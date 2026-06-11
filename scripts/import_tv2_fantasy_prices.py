#!/usr/bin/env python3
"""Import TV 2 VM Fantasy player prices.

TV 2 exposes a static public CSV with the game price list. This script
normalizes it into the same CSV shape as the official FIFA price import so the
API can switch provider without changing projection code.
"""

from __future__ import annotations

import csv
import json
import re
import sys
import unicodedata
from datetime import UTC, datetime
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "apps" / "api"))

from footballsage_api.worldcup_adapter import WorldCupPlayer, get_worldcup_data  # noqa: E402

TV2_PRICES_URL = "https://vmfantasy.tv2.no/images/TV%202%20VM%20Fantasy%20-%20priser.csv"
OUT_DIR = ROOT / "data" / "tv2-prices"
CSV_PATH = OUT_DIR / "world-cup-2026-tv2.csv"
META_PATH = OUT_DIR / "world-cup-2026-tv2.meta.json"

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
    ),
    "Accept": "text/csv,*/*",
    "Referer": "https://vmfantasy.tv2.no/",
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

COUNTRY_TO_CODE = {
    "Algerie": "ALG",
    "Argentina": "ARG",
    "Australia": "AUS",
    "Belgia": "BEL",
    "Bosnia-Hercegovina": "BIH",
    "Brasil": "BRA",
    "Canada": "CAN",
    "Colombia": "COL",
    "Curaçao": "CUW",
    "DR Kongo": "COD",
    "Ecuador": "ECU",
    "Egypt": "EGY",
    "Elfenbenskysten": "CIV",
    "England": "ENG",
    "Frankrike": "FRA",
    "Ghana": "GHA",
    "Haiti": "HAI",
    "Irak": "IRQ",
    "Iran": "IRN",
    "Japan": "JPN",
    "Jordan": "JOR",
    "Kapp Verde": "CPV",
    "Kroatia": "CRO",
    "Marokko": "MAR",
    "Mexico": "MEX",
    "Nederland": "NED",
    "New Zealand": "NZL",
    "Norge": "NOR",
    "Panama": "PAN",
    "Paraguay": "PAR",
    "Portugal": "POR",
    "Qatar": "QAT",
    "Saudi-Arabia": "KSA",
    "Senegal": "SEN",
    "Skottland": "SCO",
    "Spania": "ESP",
    "Sveits": "SUI",
    "Sverige": "SWE",
    "Sør-Afrika": "RSA",
    "Sør-Korea": "KOR",
    "Tsjekkia": "CZE",
    "Tunisia": "TUN",
    "Tyrkia": "TUR",
    "Tyskland": "GER",
    "USA": "USA",
    "Uruguay": "URU",
    "Usbekistan": "UZB",
    "Østerrike": "AUT",
}

POSITION_TO_CODE = {
    "KEE": "GK",
    "FOR": "DEF",  # TV 2: forsvar, not forward
    "MID": "MID",
    "ANG": "FWD",
}


def fetch_csv() -> tuple[str, dict[str, str]]:
    request = Request(TV2_PRICES_URL, headers=HEADERS)
    try:
        with urlopen(request, timeout=20) as response:
            headers = {key.lower(): value for key, value in response.getheaders()}
            return response.read().decode("utf-8-sig"), headers
    except (HTTPError, URLError, TimeoutError) as exc:
        raise RuntimeError(f"Failed to fetch {TV2_PRICES_URL}: {exc}") from exc


def normalize_name(value: str) -> str:
    value = unicodedata.normalize("NFKD", value)
    value = "".join(ch for ch in value if not unicodedata.combining(ch))
    value = value.casefold().replace("ø", "o").replace("đ", "d").replace("ı", "i")
    value = re.sub(r"[^a-z0-9 ]+", " ", value)
    return re.sub(r"\s+", " ", value).strip()


def slug(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", normalize_name(value)).strip("-")


def name_score(a: str, b: str) -> float:
    na = normalize_name(a)
    nb = normalize_name(b)
    if not na or not nb:
        return 0.0
    if na == nb:
        return 1.0
    if na in nb or nb in na:
        shorter = min(len(na), len(nb))
        longer = max(len(na), len(nb))
        return 0.90 + 0.08 * (shorter / longer)
    return SequenceMatcher(None, na, nb).ratio()


def best_worldcup_match(name: str, team_code: str, players_by_team: dict[str, list[WorldCupPlayer]]) -> str:
    candidates = players_by_team.get(team_code, [])
    if not candidates:
        return ""
    best, score = max(((player, name_score(name, player.name)) for player in candidates), key=lambda item: item[1])
    return best.id if score >= 0.92 else ""


def parse_price(value: str) -> float:
    return float(value.strip().rstrip("Mm").replace(",", "."))


def split_name(name: str) -> tuple[str, str]:
    parts = name.split()
    if len(parts) <= 1:
        return "", name
    return " ".join(parts[:-1]), parts[-1]


def normalize_rows(raw_csv: str) -> list[dict[str, Any]]:
    worldcup = get_worldcup_data()
    players_by_team: dict[str, list[WorldCupPlayer]] = {}
    for player in worldcup.players:
        if player.team_code:
            players_by_team.setdefault(player.team_code, []).append(player)

    rows: list[dict[str, Any]] = []
    reader = csv.DictReader(raw_csv.splitlines())
    for source_id, row in enumerate(reader, start=1):
        country = row["land"].strip()
        name = row["spiller"].strip()
        team_code = COUNTRY_TO_CODE.get(country)
        position = POSITION_TO_CODE.get(row["position"].strip())
        if not team_code:
            raise RuntimeError(f"Unknown TV2 country: {country}")
        if not position:
            raise RuntimeError(f"Unknown TV2 position: {row['position']}")

        first_name, last_name = split_name(name)
        rows.append(
            {
                "player_id": f"tv2-fantasy-{team_code.lower()}-{slug(name)}",
                "worldcup_player_id": best_worldcup_match(name, team_code, players_by_team),
                "name": name,
                "first_name": first_name,
                "last_name": last_name,
                "known_name": "",
                "team": country,
                "team_abbr": team_code,
                "team_id": team_code,
                "position": position,
                "official_position": row["position"].strip(),
                "price": f"{parse_price(row['pris']):.1f}",
                "status": "playing",
                "percent_selected": "0",
                "fifa_id": "",
                "source": TV2_PRICES_URL,
                "source_player_id": str(source_id),
            }
        )
    return rows


def write_csv(rows: list[dict[str, Any]]) -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    with CSV_PATH.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=CSV_FIELDS, lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)


def write_meta(rows: list[dict[str, Any]], response_headers: dict[str, str]) -> None:
    prices = [float(row["price"]) for row in rows]
    matched = sum(1 for row in rows if row["worldcup_player_id"])
    meta = {
        "source": "TV 2 VM Fantasy public static CSV",
        "prices_url": TV2_PRICES_URL,
        "imported_at": datetime.now(UTC).isoformat(),
        "player_count": len(rows),
        "team_count": len({row["team_abbr"] for row in rows}),
        "price_min": min(prices) if prices else None,
        "price_max": max(prices) if prices else None,
        "worldcup_matched": matched,
        "worldcup_unmatched": len(rows) - matched,
        "etag": response_headers.get("etag"),
        "last_modified": response_headers.get("last-modified"),
        "content_length": response_headers.get("content-length"),
    }
    META_PATH.write_text(json.dumps(meta, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def main() -> int:
    raw_csv, response_headers = fetch_csv()
    rows = normalize_rows(raw_csv)
    write_csv(rows)
    write_meta(rows, response_headers)
    print(f"Wrote {len(rows)} TV2 players to {CSV_PATH.relative_to(ROOT)}")
    print(f"Wrote metadata to {META_PATH.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except RuntimeError as exc:
        print(exc, file=sys.stderr)
        raise SystemExit(1)
