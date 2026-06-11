#!/usr/bin/env python3
"""Import official FIFA World Cup Fantasy 2026 player prices.

The official web app loads public JSON from https://play.fifa.com/json/fantasy/.
This script normalizes that player pool into the CSV shape used by FootballSage.
"""

from __future__ import annotations

import csv
import json
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

BASE_URL = "https://play.fifa.com/json/fantasy/"
PLAYERS_URL = BASE_URL + "players.json"
SQUADS_URL = BASE_URL + "squads.json"
CHECKSUMS_URL = BASE_URL + "checksums.json"

ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "data" / "fantasy-prices"
CSV_PATH = OUT_DIR / "world-cup-2026-official.csv"
META_PATH = OUT_DIR / "world-cup-2026-official.meta.json"

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json,text/plain,*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://play.fifa.com/fantasy/",
}

CSV_FIELDS = [
    "player_id",
    "worldcup_player_id",
    "name",
    "first_name",
    "last_name",
    "known_name",
    "team",
    "team_abbr",
    "team_id",
    "position",
    "official_position",
    "price",
    "status",
    "percent_selected",
    "fifa_id",
    "source",
    "source_player_id",
]


def fetch_json(url: str) -> Any:
    request = Request(url, headers=HEADERS)
    try:
        with urlopen(request, timeout=20) as response:
            return json.loads(response.read().decode("utf-8"))
    except (HTTPError, URLError, TimeoutError) as exc:
        raise RuntimeError(f"Failed to fetch {url}: {exc}") from exc


def player_name(player: dict[str, Any]) -> str:
    if player.get("knownName"):
        return str(player["knownName"])
    parts = [player.get("firstName"), player.get("lastName")]
    return " ".join(str(part) for part in parts if part).strip()


def normalize(players: list[dict[str, Any]], squads: list[dict[str, Any]]) -> list[dict[str, Any]]:
    squads_by_id = {squad["id"]: squad for squad in squads}
    rows: list[dict[str, Any]] = []

    for player in sorted(players, key=lambda p: (p.get("squadId") or 0, p.get("position") or "", p.get("id") or 0)):
        squad = squads_by_id.get(player.get("squadId"), {})
        position = player.get("position") or ""
        rows.append(
            {
                "player_id": f"fifa-fantasy-{player['id']}",
                "worldcup_player_id": "",
                "name": player_name(player),
                "first_name": player.get("firstName") or "",
                "last_name": player.get("lastName") or "",
                "known_name": player.get("knownName") or "",
                "team": squad.get("name") or "",
                "team_abbr": squad.get("abbr") or "",
                "team_id": player.get("squadId") or "",
                "position": position,
                "official_position": position,
                "price": player.get("price"),
                "status": player.get("status") or "",
                "percent_selected": player.get("percentSelected") or 0,
                "fifa_id": player.get("fifaId") or "",
                "source": PLAYERS_URL,
                "source_player_id": player.get("id") or "",
            }
        )
    return rows


def write_csv(rows: list[dict[str, Any]]) -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    with CSV_PATH.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=CSV_FIELDS, lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)


def write_meta(players: list[dict[str, Any]], squads: list[dict[str, Any]], checksums: dict[str, Any]) -> None:
    prices = [player["price"] for player in players if player.get("price") is not None]
    meta = {
        "source": "official FIFA World Cup Fantasy 2026 public JSON",
        "players_url": PLAYERS_URL,
        "squads_url": SQUADS_URL,
        "checksums_url": CHECKSUMS_URL,
        "imported_at": datetime.now(UTC).isoformat(),
        "player_count": len(players),
        "squad_count": len(squads),
        "price_min": min(prices) if prices else None,
        "price_max": max(prices) if prices else None,
        "checksums": checksums,
    }
    META_PATH.write_text(json.dumps(meta, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def main() -> int:
    players = fetch_json(PLAYERS_URL)
    squads = fetch_json(SQUADS_URL)
    checksums = fetch_json(CHECKSUMS_URL)

    if not isinstance(players, list) or not isinstance(squads, list):
        raise RuntimeError("Unexpected FIFA fantasy JSON shape")

    rows = normalize(players, squads)
    write_csv(rows)
    write_meta(players, squads, checksums if isinstance(checksums, dict) else {})

    print(f"Wrote {len(rows)} players to {CSV_PATH.relative_to(ROOT)}")
    print(f"Wrote metadata to {META_PATH.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except RuntimeError as exc:
        print(exc, file=sys.stderr)
        raise SystemExit(1)
