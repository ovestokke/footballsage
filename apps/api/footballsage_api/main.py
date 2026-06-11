from __future__ import annotations

import base64
import binascii
import csv
import re
import shutil
import subprocess
import tempfile
import unicodedata
from difflib import SequenceMatcher
from functools import lru_cache
from pathlib import Path
from typing import Annotated

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from .worldcup_adapter import (
    fixture_difficulty,
    get_worldcup_data,
    next_fixture_for_team,
    opponent_for_fixture,
)

ROOT = Path(__file__).resolve().parents[3]
PRICE_CSV = ROOT / "data" / "fantasy-prices" / "world-cup-2026-official.csv"
TV2_PRICE_CSV = ROOT / "data" / "tv2-prices" / "world-cup-2026-tv2.csv"
MAPPING_CSV = ROOT / "data" / "mappings" / "fifa-to-worldcup-players.csv"
PRICE_CSV_BY_PROVIDER = {
    "fifa_official": PRICE_CSV,
    "tv2": TV2_PRICE_CSV,
}

app = FastAPI(title="FootballSage API", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


class FixtureSummary(BaseModel):
    id: str
    match_number: int
    stage: str
    matchday: int | None
    kickoff_utc: str
    opponent: str | None
    opponent_code: str | None
    difficulty: int | None = Field(default=None, ge=1, le=5)


class Player(BaseModel):
    player_id: str
    worldcup_player_id: str | None = None
    mapping_status: str | None = None
    name: str
    team: str
    team_abbr: str
    team_id: str
    position: str
    official_position: str
    price: float
    status: str
    percent_selected: float = Field(ge=0)
    fifa_id: str | None = None
    next_fixture: FixtureSummary | None = None
    expected_points: float
    reasons: list[str]


class Team(BaseModel):
    id: str
    name: str
    fifa_code: str
    iso2: str | None
    group: str | None
    confederation: str | None
    fifa_ranking: int | None


class Fixture(BaseModel):
    id: str
    match_number: int
    stage: str
    group: str | None
    matchday: int | None
    kickoff_utc: str
    status: str
    home_team: str | None
    away_team: str | None
    home_team_code: str | None
    away_team_code: str | None


class TeamImportTextRequest(BaseModel):
    text: str
    provider: str = Field(default="tv2", pattern="^(fifa_official|tv2)$")


class TeamImportScreenshotRequest(BaseModel):
    image_base64: str
    filename: str | None = None
    provider: str = Field(default="tv2", pattern="^(fifa_official|tv2)$")


class ImportPlayerOption(BaseModel):
    player_id: str
    name: str
    team: str
    team_abbr: str
    position: str
    price: float
    worldcup_player_id: str | None = None


class TeamImportCandidate(BaseModel):
    raw_text: str
    status: str
    confidence: float
    match: ImportPlayerOption | None
    alternatives: list[ImportPlayerOption]


class TeamImportResponse(BaseModel):
    provider: str
    raw_text: str
    needs_manual_verification: bool
    candidates: list[TeamImportCandidate]
    notes: list[str]


def expected_points(position: str, price: float, status: str, difficulty: int | None) -> tuple[float, list[str]]:
    """Explainable v1 placeholder until minutes/odds/team-strength are richer."""
    appearance = 2.0 if status == "playing" else 0.5
    price_signal = max(price - 3.5, 0) * 0.35
    position_signal = {"GK": 0.4, "DEF": 0.7, "MID": 1.0, "FWD": 1.1}.get(position, 0.6)
    difficulty_modifier = {1: 1.15, 2: 1.08, 3: 1.0, 4: 0.94, 5: 0.88}.get(difficulty, 1.0)

    raw = appearance + price_signal + position_signal
    projected = round(raw * difficulty_modifier, 2)

    reasons = [
        "v1 projection: appearance baseline",
        "fantasy price used as potential proxy",
        f"position modifier: {position}",
    ]
    if difficulty:
        reasons.append(f"next-fixture difficulty modifier: {difficulty}/5")
    else:
        reasons.append("fixture difficulty unavailable")
    return projected, reasons


@lru_cache(maxsize=1)
def load_mapping() -> dict[str, dict[str, str]]:
    if not MAPPING_CSV.exists():
        return {}
    with MAPPING_CSV.open(newline="", encoding="utf-8") as handle:
        return {row["fantasy_player_id"]: row for row in csv.DictReader(handle)}


def fixture_summary(team_code: str, round_id: int) -> FixtureSummary | None:
    fixture = next_fixture_for_team(team_code, round=round_id)
    if not fixture:
        return None

    opponent = opponent_for_fixture(team_code, fixture)
    difficulty = fixture_difficulty(team_code, fixture)
    return FixtureSummary(
        id=fixture.id,
        match_number=fixture.match_number,
        stage=fixture.stage,
        matchday=fixture.matchday,
        kickoff_utc=fixture.kickoff_utc,
        opponent=opponent.name if opponent else None,
        opponent_code=opponent.fifa_code if opponent else None,
        difficulty=difficulty,
    )


@lru_cache(maxsize=4)
def load_players(provider: str = "fifa_official") -> list[dict[str, str]]:
    csv_path = PRICE_CSV_BY_PROVIDER[provider]
    if not csv_path.exists():
        import_hint = "scripts/import_tv2_fantasy_prices.py" if provider == "tv2" else "scripts/import_fifa_fantasy_prices.py"
        raise FileNotFoundError(f"Missing {csv_path}. Run {import_hint} first.")

    with csv_path.open(newline="", encoding="utf-8") as handle:
        return list(csv.DictReader(handle))


def build_player(row: dict[str, str], round_id: int, provider: str) -> Player:
    mapping = load_mapping().get(row["player_id"], {}) if provider == "fifa_official" else {}
    next_fixture = fixture_summary(row["team_abbr"], round_id)
    difficulty = next_fixture.difficulty if next_fixture else None
    projected_points, reasons = expected_points(row["position"], float(row["price"]), row["status"], difficulty)

    row_worldcup_id = row.get("worldcup_player_id") or ""
    mapping_status = mapping.get("status") or ("matched" if row_worldcup_id else None)
    if mapping_status == "review":
        reasons.append("worldcup player mapping needs human review")
    elif mapping_status == "unmatched":
        reasons.append("worldcup player mapping unavailable")
    elif provider == "tv2":
        reasons.append("TV2 price source")

    return Player(
        player_id=row["player_id"],
        worldcup_player_id=mapping.get("worldcup_player_id") or row_worldcup_id or None,
        mapping_status=mapping_status,
        name=row["name"],
        team=row["team"],
        team_abbr=row["team_abbr"],
        team_id=row["team_id"],
        position=row["position"],
        official_position=row["official_position"],
        price=float(row["price"]),
        status=row["status"],
        percent_selected=float(row["percent_selected"] or 0),
        fifa_id=row["fifa_id"] or None,
        next_fixture=next_fixture,
        expected_points=projected_points,
        reasons=reasons,
    )


def normalize_match_text(value: str) -> str:
    value = unicodedata.normalize("NFKD", value)
    value = "".join(ch for ch in value if not unicodedata.combining(ch))
    value = value.casefold().replace("ø", "o").replace("đ", "d").replace("ı", "i")
    value = re.sub(r"[^a-z0-9 ]+", " ", value)
    return re.sub(r"\s+", " ", value).strip()


def import_option(row: dict[str, str]) -> ImportPlayerOption:
    return ImportPlayerOption(
        player_id=row["player_id"],
        name=row["name"],
        team=row["team"],
        team_abbr=row["team_abbr"],
        position=row["position"],
        price=float(row["price"]),
        worldcup_player_id=row.get("worldcup_player_id") or None,
    )


def line_score(line_norm: str, player_norm: str) -> float:
    if not line_norm or not player_norm:
        return 0.0
    if player_norm in line_norm:
        return 0.99
    if line_norm in player_norm and len(line_norm) >= 8:
        return 0.9
    line_tokens = set(line_norm.split())
    player_tokens = set(player_norm.split())
    if line_tokens and line_tokens <= player_tokens and len(line_norm) >= 5:
        return 0.82
    if line_norm in player_tokens and len(line_norm) >= 5:
        return 0.82
    return SequenceMatcher(None, line_norm, player_norm).ratio()


def match_team_text(text: str, provider: str) -> TeamImportResponse:
    rows = load_players(provider)
    catalog = [(row, normalize_match_text(row["name"])) for row in rows]
    full_text_norm = normalize_match_text(text)
    candidates_by_player_id: dict[str, TeamImportCandidate] = {}
    unmatched: list[TeamImportCandidate] = []

    def add_candidate(candidate: TeamImportCandidate) -> None:
        if candidate.match:
            existing = candidates_by_player_id.get(candidate.match.player_id)
            if not existing or candidate.confidence > existing.confidence:
                candidates_by_player_id[candidate.match.player_id] = candidate
        elif candidate.raw_text:
            unmatched.append(candidate)

    for row, player_norm in catalog:
        if len(player_norm) >= 8 and player_norm in full_text_norm:
            option = import_option(row)
            add_candidate(
                TeamImportCandidate(
                    raw_text=row["name"],
                    status="matched",
                    confidence=0.99,
                    match=option,
                    alternatives=[option],
                )
            )

    lines = [line.strip() for line in text.splitlines() if line.strip()]
    for line in lines:
        if not re.search(r"[A-Za-zÀ-ÿ]", line):
            continue
        line_norm = normalize_match_text(line)
        if len(line_norm) < 4:
            continue

        scored = sorted(
            ((row, line_score(line_norm, player_norm)) for row, player_norm in catalog),
            key=lambda item: item[1],
            reverse=True,
        )[:3]
        if not scored:
            continue

        best_row, best_score = scored[0]
        alternatives = [import_option(row) for row, score in scored if score >= max(0.55, best_score - 0.12)]
        status = "matched" if best_score >= 0.86 else "review" if best_score >= 0.70 else "unmatched"
        add_candidate(
            TeamImportCandidate(
                raw_text=line,
                status=status,
                confidence=round(best_score, 3),
                match=import_option(best_row) if status != "unmatched" else None,
                alternatives=alternatives,
            )
        )

    candidates = sorted(
        list(candidates_by_player_id.values()) + unmatched[:8],
        key=lambda item: (item.status != "matched", item.status != "review", -item.confidence),
    )[:30]
    notes = [
        "OCR/import is intentionally provisional; confirm every player before saving or rating.",
        "TV2 prices are loaded from their public static CSV when provider=tv2.",
    ]
    return TeamImportResponse(
        provider=provider,
        raw_text=text,
        needs_manual_verification=True,
        candidates=candidates,
        notes=notes,
    )


def run_tesseract(image_bytes: bytes, filename: str | None) -> str:
    if not shutil.which("tesseract"):
        raise HTTPException(status_code=503, detail="tesseract OCR binary is not installed")
    suffix = Path(filename or "team.png").suffix or ".png"
    with tempfile.NamedTemporaryFile(suffix=suffix) as image_file:
        image_file.write(image_bytes)
        image_file.flush()
        try:
            result = subprocess.run(
                ["tesseract", image_file.name, "stdout", "--psm", "6"],
                check=False,
                capture_output=True,
                text=True,
                timeout=20,
            )
        except subprocess.TimeoutExpired as exc:
            raise HTTPException(status_code=504, detail="OCR timed out") from exc
    if result.returncode != 0:
        detail = result.stderr.strip() or "OCR failed"
        raise HTTPException(status_code=422, detail=detail)
    return result.stdout.strip()


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/teams", response_model=list[Team])
def teams() -> list[Team]:
    data = get_worldcup_data()
    return [
        Team(
            id=team.id,
            name=team.name,
            fifa_code=team.fifa_code,
            iso2=team.iso2,
            group=team.group,
            confederation=team.confederation,
            fifa_ranking=team.fifa_ranking,
        )
        for team in data.teams
    ]


@app.get("/fixtures", response_model=list[Fixture])
def fixtures(
    stage: str | None = None,
    team: str | None = None,
    limit: Annotated[int, Query(ge=1, le=500)] = 200,
) -> list[Fixture]:
    result = get_worldcup_data().fixtures
    if stage:
        result = [fixture for fixture in result if fixture.stage == stage]
    if team:
        team_code = team.upper()
        result = [
            fixture
            for fixture in result
            if fixture.home_team_code == team_code or fixture.away_team_code == team_code
        ]
    return [
        Fixture(
            id=fixture.id,
            match_number=fixture.match_number,
            stage=fixture.stage,
            group=fixture.group,
            matchday=fixture.matchday,
            kickoff_utc=fixture.kickoff_utc,
            status=fixture.status,
            home_team=fixture.home_team,
            away_team=fixture.away_team,
            home_team_code=fixture.home_team_code,
            away_team_code=fixture.away_team_code,
        )
        for fixture in result[:limit]
    ]


@app.get("/players", response_model=list[Player])
def players(
    round: Annotated[int, Query(ge=1, le=8)] = 1,
    provider: Annotated[str, Query(pattern="^(fifa_official|tv2)$")] = "fifa_official",
    position: Annotated[str | None, Query(pattern="^(GK|DEF|MID|FWD)$")] = None,
    team: str | None = None,
    limit: Annotated[int, Query(ge=1, le=5000)] = 5000,
) -> list[Player]:
    try:
        rows = load_players(provider)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    if position:
        rows = [row for row in rows if row["position"] == position]
    if team:
        team_query = team.casefold()
        rows = [
            row
            for row in rows
            if row["team"].casefold() == team_query or row["team_abbr"].casefold() == team_query
        ]

    return [build_player(row, round, provider) for row in rows[:limit]]


@app.post("/team/import-text", response_model=TeamImportResponse)
def import_team_text(payload: TeamImportTextRequest) -> TeamImportResponse:
    if not payload.text.strip():
        raise HTTPException(status_code=400, detail="No text supplied")
    try:
        return match_team_text(payload.text, payload.provider)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@app.post("/team/import-screenshot", response_model=TeamImportResponse)
def import_team_screenshot(payload: TeamImportScreenshotRequest) -> TeamImportResponse:
    encoded = payload.image_base64.split(",", 1)[-1]
    try:
        image_bytes = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise HTTPException(status_code=400, detail="Invalid base64 image") from exc
    if len(image_bytes) > 8 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Image is too large; max 8 MB")

    text = run_tesseract(image_bytes, payload.filename)
    if not text:
        return TeamImportResponse(
            provider=payload.provider,
            raw_text="",
            needs_manual_verification=True,
            candidates=[],
            notes=["OCR returned no text. Try a tighter crop around the team/player names."],
        )
    try:
        return match_team_text(text, payload.provider)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
