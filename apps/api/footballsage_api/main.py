from __future__ import annotations

import base64
import binascii
import csv
import logging
import os
import re
from collections import Counter
import shutil
import subprocess
import tempfile
import unicodedata
from difflib import SequenceMatcher
from functools import lru_cache
from pathlib import Path
from typing import Annotated, Any

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, ValidationError

from . import sage_advisor

logger = logging.getLogger("footballsage.api")
from .worldcup_adapter import (
    fixture_difficulty,
    get_worldcup_data,
    next_fixture_for_team,
    opponent_for_fixture,
    team_has_fixture_in_round,
)

ROOT = Path(__file__).resolve().parents[3]
PRICE_CSV = ROOT / "data" / "fantasy-prices" / "world-cup-2026-official.csv"
TV2_PRICE_CSV = ROOT / "data" / "tv2-prices" / "world-cup-2026-tv2.csv"
MAPPING_CSV = ROOT / "data" / "mappings" / "fifa-to-worldcup-players.csv"
PRICE_CSV_BY_PROVIDER = {
    "fifa_official": PRICE_CSV,
    "tv2": TV2_PRICE_CSV,
}
SQUAD_SIZE = 15
SQUAD_BUDGET = 100.0
MAX_PLAYERS_PER_COUNTRY = 3
POSITION_TARGETS = {"GK": 2, "DEF": 5, "MID": 5, "FWD": 3}
TEAMS_DIR = ROOT / "data" / "teams"
TEAMS_DIR.mkdir(parents=True, exist_ok=True)

_api_prefix = os.environ.get("API_PREFIX", "").rstrip("/")

app = FastAPI(
    title="FootballSage API",
    version="0.1.0",
    root_path=_api_prefix,
)

_cors_origins_str = os.environ.get("CORS_ORIGINS", "*").strip()
cors_origins = [origin.strip() for origin in _cors_origins_str.split(",") if origin.strip()]
if not cors_origins:
    cors_origins = ["*"]

app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins,
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
    suggested_role: str | None = Field(default=None, pattern="^(starter|bench)$")
    is_captain: bool = False
    is_vice_captain: bool = False


class TeamImportResponse(BaseModel):
    provider: str
    raw_text: str
    needs_manual_verification: bool
    candidates: list[TeamImportCandidate]
    notes: list[str]


class TeamSelection(BaseModel):
    player_id: str
    role: str = Field(default="starter", pattern="^(starter|bench)$")
    is_captain: bool = False
    is_vice_captain: bool = False


class TeamAnalysisRequest(BaseModel):
    player_ids: list[str] = Field(default_factory=list, max_length=30)
    selections: list[TeamSelection] = Field(default_factory=list, max_length=30)
    provider: str = Field(default="tv2", pattern="^(fifa_official|tv2)$")
    round: int = Field(default=1, ge=1, le=8)
    budget: float = Field(default=SQUAD_BUDGET, gt=0)


class TeamIssue(BaseModel):
    code: str
    severity: str
    title: str
    detail: str
    player_id: str | None = None


class TeamSuggestion(BaseModel):
    kind: str
    severity: str
    title: str
    action: str
    reason: str
    expected_gain: float | None = None
    out_player_id: str | None = None
    in_player_id: str | None = None
    player: Player | None = None
    replacement: Player | None = None


class TeamLineupPlayer(BaseModel):
    player: Player
    role: str
    is_captain: bool
    is_vice_captain: bool


class TeamAnalysisResponse(BaseModel):
    provider: str
    round: int
    budget: float
    total_price: float
    remaining_budget: float
    expected_points: float
    player_count: int
    position_counts: dict[str, int]
    selected_players: list[Player]
    lineup: list[TeamLineupPlayer]
    issues: list[TeamIssue]
    captain_picks: list[Player]
    bench_candidates: list[Player]
    suggestions: list[TeamSuggestion]


class SageAdviceRequest(BaseModel):
    question: str = Field(min_length=3, max_length=1000)
    selections: list[TeamSelection] = Field(default_factory=list, min_length=1, max_length=30)
    provider: str = Field(default="tv2", pattern="^(fifa_official|tv2)$")
    round: int = Field(default=1, ge=1, le=8)
    budget: float = Field(default=SQUAD_BUDGET, gt=0)
    bank: float | None = Field(default=None, ge=0)
    free_transfers: int = Field(default=1, ge=0, le=15)
    risk_profile: str = Field(default="balanced", pattern="^(safe|balanced|aggressive)$")
    previous_advice: dict[str, Any] | None = None
    user_feedback: str | None = Field(default=None, max_length=1000)


class SageAdvice(BaseModel):
    summary: str
    priority_actions: list[dict[str, Any]] = Field(default_factory=list)
    transfer_advice: list[dict[str, Any]] = Field(default_factory=list)
    captain_advice: dict[str, Any] | None = None
    problems_found: list[dict[str, Any]] = Field(default_factory=list)
    risks: list[str] = Field(default_factory=list)
    data_gaps: list[str] = Field(default_factory=list)


class SageAdviceResponse(BaseModel):
    provider: str
    round: int
    llm_provider: str
    model: str
    advice: SageAdvice
    context: dict[str, Any]


class SavedTeamSelection(BaseModel):
    player_id: str
    role: str = Field(default="starter", pattern="^(starter|bench)$")
    is_captain: bool = False
    is_vice_captain: bool = False


class SavedTeam(BaseModel):
    id: str
    name: str
    provider: str = Field(default="tv2", pattern="^(fifa_official|tv2)$")
    round: int = Field(default=1, ge=1, le=8)
    selections: list[SavedTeamSelection]
    created_at: str
    updated_at: str



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
    if round_id > 3 and not next_fixture:
        projected_points = 0.0
        reasons.append("team has no known fixture in selected knockout round")

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


def load_built_players(provider: str, round_id: int) -> list[Player]:
    return [build_player(row, round_id, provider) for row in load_players(provider)]


def analyze_team_request(payload: TeamAnalysisRequest) -> TeamAnalysisResponse:
    available_players = load_built_players(payload.provider, payload.round)
    players_by_id = {player.player_id: player for player in available_players}
    requested_ids = [selection.player_id for selection in payload.selections] if payload.selections else payload.player_ids
    selection_by_id = {selection.player_id: selection for selection in payload.selections}
    selected_players = [players_by_id[player_id] for player_id in requested_ids if player_id in players_by_id]
    lineup = [
        TeamLineupPlayer(
            player=player,
            role=selection_by_id.get(player.player_id, TeamSelection(player_id=player.player_id)).role,
            is_captain=selection_by_id.get(player.player_id, TeamSelection(player_id=player.player_id)).is_captain,
            is_vice_captain=selection_by_id.get(player.player_id, TeamSelection(player_id=player.player_id)).is_vice_captain,
        )
        for player in selected_players
    ]

    duplicate_ids = [player_id for player_id, count in Counter(requested_ids).items() if count > 1]
    missing_ids = [player_id for player_id in requested_ids if player_id not in players_by_id]
    selected_ids = {player.player_id for player in selected_players}
    total_price = round(sum(player.price for player in selected_players), 2)
    expected_total = round(sum(player.expected_points for player in selected_players), 2)
    remaining_budget = round(payload.budget - total_price, 2)
    position_counts = {position: sum(1 for player in selected_players if player.position == position) for position in POSITION_TARGETS}

    issues: list[TeamIssue] = []
    if missing_ids:
        issues.append(
            TeamIssue(
                code="missing_players",
                severity="bad",
                title="Noen spillere finnes ikke i prislisten",
                detail=", ".join(missing_ids[:5]),
            )
        )
    if duplicate_ids:
        issues.append(
            TeamIssue(
                code="duplicate_players",
                severity="bad",
                title="Duplikater i laget",
                detail="Samme spiller er valgt mer enn én gang.",
                player_id=duplicate_ids[0],
            )
        )
    if len(selected_players) != SQUAD_SIZE:
        severity = "warn" if selected_players else "bad"
        issues.append(
            TeamIssue(
                code="squad_size",
                severity=severity,
                title=f"Laget har {len(selected_players)} av {SQUAD_SIZE} spillere",
                detail="Legg inn hele troppen for tryggere råd." if selected_players else "Importer eller legg til spillere for å starte analysen.",
            )
        )
    if remaining_budget < 0:
        issues.append(
            TeamIssue(
                code="over_budget",
                severity="bad",
                title="Laget er over budsjett",
                detail=f"Du må frigjøre minst {abs(remaining_budget):.1f}m.",
            )
        )

    for position, target in POSITION_TARGETS.items():
        count = position_counts[position]
        if selected_players and count != target:
            issues.append(
                TeamIssue(
                    code=f"position_{position.lower()}",
                    severity="warn",
                    title=f"{position}: {count}/{target}",
                    detail="Posisjonsfordelingen matcher ikke en full fantasy-tropp.",
                )
            )

    if payload.selections:
        starter_count = sum(1 for line in lineup if line.role == "starter")
        bench_count = sum(1 for line in lineup if line.role == "bench")
        captain_count = sum(1 for line in lineup if line.is_captain)
        vice_count = sum(1 for line in lineup if line.is_vice_captain)
        if len(selected_players) == SQUAD_SIZE and starter_count != 11:
            issues.append(
                TeamIssue(
                    code="starter_count",
                    severity="bad",
                    title=f"Startelleveren har {starter_count}/11 spillere",
                    detail="Marker nøyaktig 11 spillere som spiller fra start.",
                )
            )
        if len(selected_players) == SQUAD_SIZE and bench_count != 4:
            issues.append(
                TeamIssue(
                    code="bench_count",
                    severity="bad",
                    title=f"Benken har {bench_count}/4 spillere",
                    detail="Marker nøyaktig 4 spillere som benk.",
                )
            )
        if captain_count != 1:
            issues.append(
                TeamIssue(
                    code="captain_missing" if captain_count == 0 else "captain_multiple",
                    severity="bad",
                    title="Kaptein må settes" if captain_count == 0 else "Flere kapteiner er valgt",
                    detail="AI-råd trenger én tydelig kaptein fra laget ditt.",
                )
            )
        if vice_count != 1:
            issues.append(
                TeamIssue(
                    code="vice_captain_missing" if vice_count == 0 else "vice_captain_multiple",
                    severity="bad",
                    title="Vicekaptein må settes" if vice_count == 0 else "Flere vicekapteiner er valgt",
                    detail="AI-råd trenger én tydelig vicekaptein fra laget ditt.",
                )
            )
        captain_line = next((line for line in lineup if line.is_captain), None)
        vice_line = next((line for line in lineup if line.is_vice_captain), None)
        if captain_line and captain_line.role != "starter":
            issues.append(
                TeamIssue(
                    code="captain_benched",
                    severity="bad",
                    title="Kaptein er markert som benk",
                    detail=f"{captain_line.player.name} må enten starte eller kaptein må flyttes.",
                    player_id=captain_line.player.player_id,
                )
            )
        if vice_line and vice_line.role != "starter":
            issues.append(
                TeamIssue(
                    code="vice_captain_benched",
                    severity="bad",
                    title="Vicekaptein er markert som benk",
                    detail=f"{vice_line.player.name} må enten starte eller vicekaptein må flyttes.",
                    player_id=vice_line.player.player_id,
                )
            )
        if captain_line and vice_line and captain_line.player.player_id == vice_line.player.player_id:
            issues.append(
                TeamIssue(
                    code="captain_same_as_vice",
                    severity="bad",
                    title="Kaptein og vicekaptein er samme spiller",
                    detail="Velg to forskjellige spillere for C og VC.",
                    player_id=captain_line.player.player_id,
                )
            )

    country_counts = Counter(player.team_abbr for player in selected_players)
    for team_code, count in sorted(country_counts.items()):
        if count > MAX_PLAYERS_PER_COUNTRY:
            issues.append(
                TeamIssue(
                    code="country_limit",
                    severity="bad",
                    title=f"For mange spillere fra {team_code}",
                    detail=f"TV2-regelen er maks {MAX_PLAYERS_PER_COUNTRY} spillere per land. Du har {count}.",
                )
            )

    for player in selected_players:
        if payload.round > 3 and not team_has_fixture_in_round(player.team_abbr, payload.round):
            issues.append(
                TeamIssue(
                    code="team_eliminated",
                    severity="bad",
                    title=f"{player.name} har ikke kamp i valgt runde",
                    detail=f"{player.team_abbr} er ikke registrert med fixture i runde {payload.round}. Spilleren bør byttes ut hvis laget er ute.",
                    player_id=player.player_id,
                )
            )
        if player.status != "playing":
            issues.append(
                TeamIssue(
                    code="player_status",
                    severity="bad",
                    title=f"{player.name} er markert som {player.status}",
                    detail="Bytt ut eller bekreft status før deadline.",
                    player_id=player.player_id,
                )
            )

    # Keep this endpoint to deterministic rule checks only. Optimization/captaincy/transfer
    # advice will come from an AI layer later; mechanical suggestions are intentionally empty.
    captain_picks: list[Player] = []
    bench_candidates: list[Player] = []
    suggestions: list[TeamSuggestion] = []

    return TeamAnalysisResponse(
        provider=payload.provider,
        round=payload.round,
        budget=payload.budget,
        total_price=total_price,
        remaining_budget=remaining_budget,
        expected_points=expected_total,
        player_count=len(selected_players),
        position_counts=position_counts,
        selected_players=selected_players,
        lineup=lineup,
        issues=issues,
        captain_picks=captain_picks,
        bench_candidates=bench_candidates,
        suggestions=suggestions[:8],
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

    line_tokens = line_norm.split()
    player_tokens = player_norm.split()
    line_token_set = set(line_tokens)
    player_token_set = set(player_tokens)
    if line_token_set and line_token_set <= player_token_set and len(line_norm) >= 5:
        return 0.82
    if line_norm in player_token_set and len(line_norm) >= 5:
        return 0.82

    # Screenshot OCR often returns a whole table row, e.g.
    # "kee oan nytand eroge ... 4b". Compare the player name against
    # short token windows inside the row instead of only the full noisy line.
    scores = [SequenceMatcher(None, line_norm, player_norm).ratio()]
    player_len = len(player_tokens)
    for size in range(max(1, player_len - 1), min(len(line_tokens), player_len + 3) + 1):
        for start in range(0, len(line_tokens) - size + 1):
            window = " ".join(line_tokens[start : start + size])
            if len(window) < 4:
                continue
            scores.append(SequenceMatcher(None, window, player_norm).ratio())
            scores.append(SequenceMatcher(None, window.replace(" ", ""), player_norm.replace(" ", "")).ratio())
    return max(scores)


def parse_import_line_metadata(line: str) -> tuple[str, str | None, bool, bool]:
    role: str | None = None
    is_captain = False
    is_vice_captain = False
    value = line.strip()

    if "|" in value:
        parts = [part.strip() for part in value.split("|") if part.strip()]
        if parts:
            head = " ".join(parts[:-1]).casefold()
            value = parts[-1]
            if "bench" in head or "benk" in head:
                role = "bench"
            if "starter" in head or "start" in head or "xi" in head:
                role = "starter"
            if re.search(r"\bvc\b|vice", head):
                is_vice_captain = True
            if re.search(r"\bc\b|captain|kaptein", head) and not is_vice_captain:
                is_captain = True

    tag_text = value.casefold()
    if re.search(r"\[(bench|benk|b)\]|\((bench|benk|b)\)|\bbench\b|\bbenk\b", tag_text):
        role = "bench"
    if re.search(r"\[(starter|start)\]|\((starter|start)\)|\bstarter\b|\bstart\b", tag_text):
        role = "starter"
    if re.search(r"\bvc\b|vice", tag_text):
        is_vice_captain = True
    if re.search(r"\bc\b|captain|kaptein", tag_text) and not is_vice_captain:
        is_captain = True

    value = re.sub(r"\b(starter|start|bench|benk|captain|kaptein|vice captain|vicekaptein|vc|c)\b", " ", value, flags=re.I)
    value = re.sub(r"[\[\]()]", " ", value)
    value = re.sub(r"\s+", " ", value).strip(" -•*")
    return value, role, is_captain, is_vice_captain


def match_team_text(text: str, provider: str) -> TeamImportResponse:
    rows = load_players(provider)
    catalog = [(row, normalize_match_text(row["name"])) for row in rows]
    full_text_norm = normalize_match_text(text)
    candidates_by_player_id: dict[str, TeamImportCandidate] = {}
    candidate_order: list[str] = []
    unmatched: list[TeamImportCandidate] = []

    def has_lineup_metadata(candidate: TeamImportCandidate) -> bool:
        return bool(candidate.suggested_role or candidate.is_captain or candidate.is_vice_captain)

    def add_candidate(candidate: TeamImportCandidate) -> None:
        if candidate.match:
            player_id = candidate.match.player_id
            existing = candidates_by_player_id.get(player_id)
            if not existing:
                candidates_by_player_id[player_id] = candidate
                candidate_order.append(player_id)
            elif has_lineup_metadata(candidate) and candidate.confidence >= existing.confidence - 0.12:
                candidates_by_player_id[player_id] = existing.model_copy(
                    update={
                        "raw_text": candidate.raw_text,
                        "suggested_role": candidate.suggested_role or existing.suggested_role,
                        "is_captain": existing.is_captain or candidate.is_captain,
                        "is_vice_captain": existing.is_vice_captain or candidate.is_vice_captain,
                        "confidence": max(existing.confidence, candidate.confidence),
                    }
                )
            elif candidate.confidence > existing.confidence and not has_lineup_metadata(existing):
                candidates_by_player_id[player_id] = candidate
        elif candidate.raw_text:
            unmatched.append(candidate)

    lines = [line.strip() for line in text.splitlines() if line.strip()]
    for line in lines:
        if not re.search(r"[A-Za-zÀ-ÿ]", line):
            continue
        player_text, suggested_role, is_captain, is_vice_captain = parse_import_line_metadata(line)
        line_norm = normalize_match_text(player_text)
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
                raw_text=player_text,
                status=status,
                confidence=round(best_score, 3),
                match=import_option(best_row) if status != "unmatched" else None,
                alternatives=alternatives,
                suggested_role=suggested_role,
                is_captain=is_captain,
                is_vice_captain=is_vice_captain,
            )
        )

    # Add exact full-text matches that were not emitted as their own OCR line.
    # Do this after line matching so the verification screen keeps screenshot order;
    # that order is used as a safe fallback for starter/bench assignment.
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

    candidates = [candidates_by_player_id[player_id] for player_id in candidate_order] + unmatched[:8]
    candidates = candidates[:30]
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


import json
import uuid
from datetime import datetime, timezone


def _team_path(team_id: str) -> Path:
    return TEAMS_DIR / f"{team_id}.json"


def _read_team(team_id: str) -> SavedTeam | None:
    path = _team_path(team_id)
    if not path.exists():
        return None
    return SavedTeam.model_validate_json(path.read_text(encoding="utf-8"))


def _write_team(team: SavedTeam) -> SavedTeam:
    path = _team_path(team.id)
    path.write_text(team.model_dump_json(indent=2), encoding="utf-8")
    return team


@app.get("/saved-teams", response_model=list[SavedTeam])
def list_saved_teams() -> list[SavedTeam]:
    teams: list[SavedTeam] = []
    for path in sorted(TEAMS_DIR.glob("*.json")):
        try:
            teams.append(SavedTeam.model_validate_json(path.read_text(encoding="utf-8")))
        except (ValidationError, json.JSONDecodeError):
            continue
    return teams


@app.put("/saved-teams/{team_id}", response_model=SavedTeam)
def put_saved_team(team_id: str, payload: SavedTeam) -> SavedTeam:
    """Overwrite an existing team."""
    team = payload.model_copy(update={"id": team_id})
    return _write_team(team)


@app.post("/saved-teams", response_model=SavedTeam, status_code=201)
def post_saved_team(payload: SavedTeam) -> SavedTeam:
    """Create a new team. Server generates the ID."""
    team = payload.model_copy(update={"id": uuid.uuid4().hex[:12]})
    return _write_team(team)


@app.get("/saved-teams/{team_id}", response_model=SavedTeam)
def get_saved_team(team_id: str) -> SavedTeam:
    team = _read_team(team_id)
    if not team:
        raise HTTPException(status_code=404, detail="Team not found")
    return team


@app.delete("/saved-teams/{team_id}", response_model=dict[str, str])
def delete_saved_team(team_id: str) -> dict[str, str]:
    path = _team_path(team_id)
    if not path.exists():
        raise HTTPException(status_code=404, detail="Team not found")
    path.unlink()
    return {"status": "deleted"}


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


@app.post("/team/analyze", response_model=TeamAnalysisResponse)
def analyze_team(payload: TeamAnalysisRequest) -> TeamAnalysisResponse:
    try:
        return analyze_team_request(payload)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@app.post("/sage/advice", response_model=SageAdviceResponse)
def sage_advice(payload: SageAdviceRequest) -> SageAdviceResponse:
    try:
        analysis = analyze_team_request(
            TeamAnalysisRequest(
                selections=payload.selections,
                provider=payload.provider,
                round=payload.round,
                budget=payload.budget,
            )
        )
        available_players = load_built_players(payload.provider, payload.round)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    bank = payload.bank if payload.bank is not None else max(analysis.remaining_budget, 0)
    context = sage_advisor.build_sage_context(
        question=payload.question,
        risk_profile=payload.risk_profile,
        free_transfers=payload.free_transfers,
        bank=bank,
        analysis=analysis.model_dump(),
        available_players=[player.model_dump() for player in available_players],
        previous_advice=payload.previous_advice,
        user_feedback=payload.user_feedback,
    )
    try:
        advice_payload, llm_meta = sage_advisor.generate_sage_advice(context)
        advice = SageAdvice.model_validate(advice_payload)
    except sage_advisor.SageConfigError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except (sage_advisor.SageLLMError, ValidationError) as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    return SageAdviceResponse(
        provider=payload.provider,
        round=payload.round,
        llm_provider=llm_meta["provider"],
        model=llm_meta["model"],
        advice=advice,
        context=context,
    )


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

    ocr_notes: list[str] = []
    try:
        text, llm_meta = sage_advisor.ocr_team_screenshot(payload.image_base64)
        ocr_notes.append(f"Screenshot OCR used {llm_meta['provider']} model {llm_meta['model']}.")
    except sage_advisor.SageConfigError:
        text = run_tesseract(image_bytes, payload.filename)
        ocr_notes.append("Screenshot OCR used local tesseract because LLM OCR is not configured.")
    except Exception as exc:
        logger.warning(
            "LLM screenshot OCR failed (%s); falling back to local tesseract. "
            "OCR quality will be lower — C/VC/B markers will NOT be detected.",
            type(exc).__name__,
        )
        text = run_tesseract(image_bytes, payload.filename)
        ocr_notes.append(f"LLM screenshot OCR failed; used local tesseract fallback ({type(exc).__name__}).")

    if not text:
        return TeamImportResponse(
            provider=payload.provider,
            raw_text="",
            needs_manual_verification=True,
            candidates=[],
            notes=["OCR returned no text. Try a tighter crop around the team/player names."] + ocr_notes,
        )
    try:
        response = match_team_text(text, payload.provider)
        response.notes = ocr_notes + response.notes
        return response
    except FileNotFoundError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
