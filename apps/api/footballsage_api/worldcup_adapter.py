from __future__ import annotations

import csv
import gzip
import json
import os
import re
import time
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any
from urllib.error import URLError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[3]
WORLDCUP_DUMP = ROOT / "services" / "worldcup" / "db" / "dump" / "worldcup.sql.gz"
WORLDCUP_API_URL = os.environ.get("WORLDCUP_API_URL", "").rstrip("/")
WORLDCUP_API_CACHE_SECONDS = float(os.environ.get("WORLDCUP_API_CACHE_SECONDS", "5"))


@dataclass(frozen=True)
class WorldCupTeam:
    id: str
    name: str
    fifa_code: str
    iso2: str | None
    group: str | None
    confederation: str | None
    fifa_ranking: int | None


@dataclass(frozen=True)
class WorldCupFixture:
    id: str
    match_number: int
    stage: str
    group: str | None
    matchday: int | None
    kickoff_utc: str
    status: str
    minute: int | None
    home_score: int | None
    away_score: int | None
    home_score_ht: int | None
    away_score_ht: int | None
    home_pens: int | None
    away_pens: int | None
    home_team_id: str | None
    away_team_id: str | None
    home_team: str | None
    away_team: str | None
    home_team_code: str | None
    away_team_code: str | None
    venue: str | None
    source_ids: dict[str, str]


@dataclass(frozen=True)
class WorldCupPlayer:
    id: str
    team_id: str | None
    team_code: str | None
    name: str
    position: str | None
    number: int | None
    club: str | None
    source_ids: dict[str, str]
    date_of_birth: str | None
    nationality: str | None


@dataclass(frozen=True)
class WorldCupData:
    teams: list[WorldCupTeam]
    fixtures: list[WorldCupFixture]
    players: list[WorldCupPlayer]

    @property
    def teams_by_id(self) -> dict[str, WorldCupTeam]:
        return {team.id: team for team in self.teams}

    @property
    def teams_by_code(self) -> dict[str, WorldCupTeam]:
        return {team.fifa_code: team for team in self.teams}


COPY_RE = re.compile(r"^COPY public\.([a-z_]+) \((.*)\) FROM stdin;$")


def _parse_pg_value(value: str) -> str | None:
    if value == r"\N":
        return None
    return (
        value.replace(r"\t", "\t")
        .replace(r"\n", "\n")
        .replace(r"\r", "\r")
        .replace(r"\\", "\\")
    )


def _read_copy_table(table_name: str) -> list[dict[str, str | None]]:
    if not WORLDCUP_DUMP.exists():
        return []

    rows: list[dict[str, str | None]] = []
    in_table = False
    columns: list[str] = []

    with gzip.open(WORLDCUP_DUMP, "rt", encoding="utf-8") as handle:
        for line in handle:
            line = line.rstrip("\n")
            if not in_table:
                match = COPY_RE.match(line)
                if match and match.group(1) == table_name:
                    columns = [col.strip(' "') for col in match.group(2).split(", ")]
                    in_table = True
                continue

            if line == r"\.":
                break

            values = next(csv.reader([line], delimiter="\t"))
            rows.append({column: _parse_pg_value(value) for column, value in zip(columns, values, strict=True)})

    return rows


def _int_or_none(value: str | None) -> int | None:
    return int(value) if value not in (None, "") else None


def _json_obj(value: str | None) -> dict[str, Any]:
    if not value:
        return {}
    parsed = json.loads(value)
    return parsed if isinstance(parsed, dict) else {}


def _nested_int(obj: dict[str, Any], *path: str) -> int | None:
    current: Any = obj
    for key in path:
        if not isinstance(current, dict):
            return None
        current = current.get(key)
    if current in (None, ""):
        return None
    return int(current)


def _fetch_api_json(path: str) -> Any:
    request = Request(f"{WORLDCUP_API_URL}{path}", headers={"Accept": "application/json"})
    with urlopen(request, timeout=8) as response:
        return json.loads(response.read().decode("utf-8"))


def _load_from_api() -> WorldCupData | None:
    if not WORLDCUP_API_URL:
        return None

    try:
        teams_json = _fetch_api_json("/teams")
        fixtures_json = _fetch_api_json("/matches")
    except (OSError, URLError, TimeoutError, json.JSONDecodeError):
        return None

    teams = [
        WorldCupTeam(
            id=row["id"],
            name=row["name"],
            fifa_code=row["fifaCode"],
            iso2=row.get("iso2"),
            group=row.get("group"),
            confederation=row.get("confederation"),
            fifa_ranking=row.get("fifaRanking"),
        )
        for row in teams_json
    ]
    team_code_by_id = {team.id: team.fifa_code for team in teams}
    fixtures = [
        WorldCupFixture(
            id=row["id"],
            match_number=row["matchNumber"],
            stage=row["stage"],
            group=row.get("group"),
            matchday=row.get("matchday"),
            kickoff_utc=row["kickoffUtc"],
            status=row["status"],
            minute=_nested_int(row, "minute"),
            home_score=_nested_int(row, "score", "home"),
            away_score=_nested_int(row, "score", "away"),
            home_score_ht=_nested_int(row, "score", "homeHt"),
            away_score_ht=_nested_int(row, "score", "awayHt"),
            home_pens=_nested_int(row, "score", "homePens"),
            away_pens=_nested_int(row, "score", "awayPens"),
            home_team_id=(row.get("homeTeam") or {}).get("id"),
            away_team_id=(row.get("awayTeam") or {}).get("id"),
            home_team=(row.get("homeTeam") or {}).get("name") or row.get("homePlaceholder"),
            away_team=(row.get("awayTeam") or {}).get("name") or row.get("awayPlaceholder"),
            home_team_code=team_code_by_id.get((row.get("homeTeam") or {}).get("id")),
            away_team_code=team_code_by_id.get((row.get("awayTeam") or {}).get("id")),
            venue=(row.get("venue") or {}).get("name"),
            source_ids=row.get("sourceIds") or row.get("source_ids") or {},
        )
        for row in fixtures_json
    ]
    return WorldCupData(teams=teams, fixtures=fixtures, players=[])


def _load_from_dump() -> WorldCupData:
    group_rows = _read_copy_table("groups")
    group_by_id = {row["id"]: row for row in group_rows}

    team_rows = _read_copy_table("teams")
    teams = [
        WorldCupTeam(
            id=str(row["id"]),
            name=str(row["name"]),
            fifa_code=str(row["fifa_code"]),
            iso2=row.get("iso2"),
            group=(group_by_id.get(row.get("group_id"), {}) or {}).get("letter"),
            confederation=row.get("confederation"),
            fifa_ranking=_int_or_none(row.get("fifa_ranking")),
        )
        for row in team_rows
    ]
    teams_by_id = {team.id: team for team in teams}

    fixture_rows = _read_copy_table("matches")
    venue_rows = _read_copy_table("venues")
    venue_by_id = {str(row["id"]): row for row in venue_rows}

    fixtures = []
    for row in fixture_rows:
        home = teams_by_id.get(str(row["home_team_id"])) if row.get("home_team_id") else None
        away = teams_by_id.get(str(row["away_team_id"])) if row.get("away_team_id") else None
        venue = venue_by_id.get(str(row["venue_id"])) if row.get("venue_id") else None
        fixtures.append(
            WorldCupFixture(
                id=str(row["id"]),
                match_number=int(str(row["match_number"])),
                stage=str(row["stage"]),
                group=(group_by_id.get(row.get("group_id"), {}) or {}).get("letter"),
                matchday=_int_or_none(row.get("matchday")),
                kickoff_utc=str(row["kickoff_utc"]),
                status=str(row["status"]),
                minute=_int_or_none(row.get("minute")),
                home_score=_int_or_none(row.get("home_score")),
                away_score=_int_or_none(row.get("away_score")),
                home_score_ht=_int_or_none(row.get("home_score_ht")),
                away_score_ht=_int_or_none(row.get("away_score_ht")),
                home_pens=_int_or_none(row.get("home_pens")),
                away_pens=_int_or_none(row.get("away_pens")),
                home_team_id=home.id if home else None,
                away_team_id=away.id if away else None,
                home_team=home.name if home else row.get("home_placeholder"),
                away_team=away.name if away else row.get("away_placeholder"),
                home_team_code=home.fifa_code if home else None,
                away_team_code=away.fifa_code if away else None,
                venue=str(venue["name"]) if venue and venue.get("name") else None,
                source_ids=_json_obj(row.get("source_ids")),
            )
        )
    fixtures.sort(key=lambda fixture: (fixture.kickoff_utc, fixture.match_number))

    player_rows = _read_copy_table("players")
    players = []
    for row in player_rows:
        team = teams_by_id.get(str(row["team_id"])) if row.get("team_id") else None
        players.append(
            WorldCupPlayer(
                id=str(row["id"]),
                team_id=team.id if team else row.get("team_id"),
                team_code=team.fifa_code if team else None,
                name=str(row["name"]),
                position=row.get("position"),
                number=_int_or_none(row.get("number")),
                club=row.get("club"),
                source_ids=_json_obj(row.get("source_ids")),
                date_of_birth=row.get("date_of_birth"),
                nationality=row.get("nationality"),
            )
        )

    return WorldCupData(teams=teams, fixtures=fixtures, players=players)



@lru_cache(maxsize=1)
def _load_from_dump_cached() -> WorldCupData:
    return _load_from_dump()


_cached_api_data: WorldCupData | None = None
_cached_api_at = 0.0


def get_worldcup_data() -> WorldCupData:
    global _cached_api_at, _cached_api_data

    if WORLDCUP_API_URL:
        now = time.monotonic()
        if _cached_api_data is not None and now - _cached_api_at < WORLDCUP_API_CACHE_SECONDS:
            return _cached_api_data

        api_data = _load_from_api()
        if api_data is not None:
            _cached_api_data = api_data
            _cached_api_at = now
            return api_data

        if _cached_api_data is not None:
            return _cached_api_data

    return _load_from_dump_cached()


KNOCKOUT_ROUND_STAGE = {
    4: "r32",
    5: "r16",
    6: "qf",
    7: "sf",
    8: "final",
}


def next_fixture_for_team(team_code: str, *, round: int | None = None) -> WorldCupFixture | None:
    data = get_worldcup_data()
    team = data.teams_by_code.get(team_code)
    if not team:
        return None

    fixtures = [
        fixture
        for fixture in data.fixtures
        if fixture.home_team_id == team.id or fixture.away_team_id == team.id
    ]
    group_fixtures = [fixture for fixture in fixtures if fixture.stage == "group"]
    if round is not None and 1 <= round <= 3 and len(group_fixtures) >= round:
        # worldcup.matchday is calendar matchday, not fantasy MD1/MD2/MD3.
        # For fantasy group rounds, use each team's nth group fixture.
        return group_fixtures[round - 1]

    knockout_stage = KNOCKOUT_ROUND_STAGE.get(round or 0)
    if knockout_stage:
        knockout_fixture = next((fixture for fixture in fixtures if fixture.stage == knockout_stage), None)
        if knockout_fixture:
            return knockout_fixture
        return None

    return fixtures[0] if fixtures else None


def team_has_fixture_in_round(team_code: str, round: int) -> bool:
    return next_fixture_for_team(team_code, round=round) is not None


def opponent_for_fixture(team_code: str, fixture: WorldCupFixture) -> WorldCupTeam | None:
    data = get_worldcup_data()
    if fixture.home_team_code == team_code and fixture.away_team_id:
        return data.teams_by_id.get(fixture.away_team_id)
    if fixture.away_team_code == team_code and fixture.home_team_id:
        return data.teams_by_id.get(fixture.home_team_id)
    return None


def fixture_difficulty(team_code: str, fixture: WorldCupFixture | None) -> int | None:
    if not fixture:
        return None
    opponent = opponent_for_fixture(team_code, fixture)
    if not opponent or opponent.fifa_ranking is None:
        return None
    if opponent.fifa_ranking <= 10:
        return 5
    if opponent.fifa_ranking <= 20:
        return 4
    if opponent.fifa_ranking <= 40:
        return 3
    if opponent.fifa_ranking <= 70:
        return 2
    return 1
