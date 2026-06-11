#!/usr/bin/env python3
"""Build FIFA Fantasy -> emrbli/worldcup player mapping.

The two sources do not expose a shared ID in the official fantasy JSON, so the
initial mapping uses same-country name matching plus optional manual overrides.
"""

from __future__ import annotations

import csv
import re
import sys
import unicodedata
from difflib import SequenceMatcher
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "apps" / "api"))

from footballsage_api.worldcup_adapter import WorldCupPlayer, get_worldcup_data  # noqa: E402

FANTASY_CSV = ROOT / "data" / "fantasy-prices" / "world-cup-2026-official.csv"
OVERRIDES_CSV = ROOT / "data" / "mappings" / "manual-player-overrides.csv"
OUT_CSV = ROOT / "data" / "mappings" / "fifa-to-worldcup-players.csv"

FIELDS = [
    "fantasy_player_id",
    "fantasy_source_player_id",
    "fantasy_name",
    "fantasy_team",
    "fantasy_team_abbr",
    "fantasy_position",
    "worldcup_player_id",
    "worldcup_name",
    "worldcup_team_code",
    "worldcup_position",
    "worldcup_club",
    "confidence",
    "status",
    "match_method",
    "notes",
]

POSITION_MAP = {
    "Goalkeeper": "GK",
    "Defender": "DEF",
    "Midfielder": "MID",
    "Forward": "FWD",
}


def normalize_name(value: str) -> str:
    value = unicodedata.normalize("NFKD", value)
    value = "".join(ch for ch in value if not unicodedata.combining(ch))
    value = value.casefold()
    value = value.replace("ø", "o").replace("đ", "d").replace("ı", "i")
    value = re.sub(r"[^a-z0-9 ]+", " ", value)
    value = re.sub(r"\b(jr|junior|sr|senior)\b", " ", value)
    value = re.sub(r"\s+", " ", value).strip()
    return value


def token_sort(value: str) -> str:
    return " ".join(sorted(normalize_name(value).split()))


def name_score(a: str, b: str) -> float:
    na = normalize_name(a)
    nb = normalize_name(b)
    if not na or not nb:
        return 0.0
    if na == nb:
        return 1.0
    if token_sort(a) == token_sort(b):
        return 0.98
    if na in nb or nb in na:
        shorter = min(len(na), len(nb))
        longer = max(len(na), len(nb))
        return 0.90 + 0.08 * (shorter / longer)
    return SequenceMatcher(None, na, nb).ratio()


def load_fantasy_rows() -> list[dict[str, str]]:
    if not FANTASY_CSV.exists():
        raise RuntimeError(f"Missing {FANTASY_CSV}. Run scripts/import_fifa_fantasy_prices.py first.")
    with FANTASY_CSV.open(newline="", encoding="utf-8") as handle:
        return list(csv.DictReader(handle))


def load_overrides() -> dict[str, tuple[str, str]]:
    if not OVERRIDES_CSV.exists():
        return {}
    with OVERRIDES_CSV.open(newline="", encoding="utf-8") as handle:
        return {
            row["fantasy_player_id"]: (row["worldcup_player_id"], row.get("note", ""))
            for row in csv.DictReader(handle)
            if row.get("fantasy_player_id") and row.get("worldcup_player_id")
        }


def best_match(row: dict[str, str], candidates: list[WorldCupPlayer]) -> tuple[WorldCupPlayer | None, float, str, str]:
    fantasy_name = row["name"]
    scored = sorted(
        ((candidate, name_score(fantasy_name, candidate.name)) for candidate in candidates),
        key=lambda item: item[1],
        reverse=True,
    )
    if not scored:
        return None, 0.0, "unmatched", "no same-country candidates"

    best, score = scored[0]
    runner_up = scored[1][1] if len(scored) > 1 else 0.0
    position_note = ""
    worldcup_position = POSITION_MAP.get(best.position or "")
    if worldcup_position and worldcup_position != row["position"]:
        position_note = f"position differs: fantasy {row['position']} vs worldcup {worldcup_position}"

    if score >= 0.995:
        return best, score, "matched", position_note or "exact normalized name"
    if score >= 0.92 and score - runner_up >= 0.02:
        return best, score, "matched", position_note or "high-confidence fuzzy name"
    if score >= 0.86:
        return best, score, "review", position_note or "needs human review"
    return None, score, "unmatched", f"best candidate {best.name} scored {score:.3f}"


def main() -> int:
    fantasy_rows = load_fantasy_rows()
    overrides = load_overrides()
    worldcup = get_worldcup_data()
    worldcup_by_id = {player.id: player for player in worldcup.players}

    players_by_team: dict[str, list[WorldCupPlayer]] = {}
    for player in worldcup.players:
        if player.team_code:
            players_by_team.setdefault(player.team_code, []).append(player)

    rows: list[dict[str, str]] = []
    counts = {"matched": 0, "review": 0, "unmatched": 0, "manual": 0}

    for fantasy in fantasy_rows:
        team_code = fantasy["team_abbr"]
        method = "name+country"
        notes = ""
        confidence = 0.0
        worldcup_player: WorldCupPlayer | None = None
        status = "unmatched"

        override = overrides.get(fantasy["player_id"])
        if override:
            worldcup_player = worldcup_by_id.get(override[0])
            if worldcup_player:
                confidence = 1.0
                status = "matched"
                method = "manual override"
                notes = override[1]
                counts["manual"] += 1
            else:
                notes = f"manual override points to missing worldcup id {override[0]}"

        if not worldcup_player:
            candidates = players_by_team.get(team_code, [])
            worldcup_player, confidence, status, notes = best_match(fantasy, candidates)

        if status in counts:
            counts[status] += 1

        rows.append(
            {
                "fantasy_player_id": fantasy["player_id"],
                "fantasy_source_player_id": fantasy["source_player_id"],
                "fantasy_name": fantasy["name"],
                "fantasy_team": fantasy["team"],
                "fantasy_team_abbr": team_code,
                "fantasy_position": fantasy["position"],
                "worldcup_player_id": worldcup_player.id if worldcup_player else "",
                "worldcup_name": worldcup_player.name if worldcup_player else "",
                "worldcup_team_code": worldcup_player.team_code if worldcup_player else "",
                "worldcup_position": worldcup_player.position if worldcup_player else "",
                "worldcup_club": worldcup_player.club if worldcup_player and worldcup_player.club else "",
                "confidence": f"{confidence:.3f}",
                "status": status,
                "match_method": method,
                "notes": notes,
            }
        )

    OUT_CSV.parent.mkdir(parents=True, exist_ok=True)
    with OUT_CSV.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=FIELDS, lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)

    print(f"Wrote {len(rows)} mappings to {OUT_CSV.relative_to(ROOT)}")
    print(
        "Matched: {matched}, review: {review}, unmatched: {unmatched}, manual overrides: {manual}".format(
            **counts
        )
    )
    return 0 if counts["matched"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
