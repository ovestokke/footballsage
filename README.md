# FootballSage

Gratis, selvhostet fantasy football helper for FIFA World Cup Fantasy 2026.

## Quickstart

```bash
git clone --recurse-submodules https://github.com/ovestokke/footballsage.git
cd footballsage
pnpm install
python3 scripts/import_fifa_fantasy_prices.py
python3 scripts/import_tv2_fantasy_prices.py
python3 scripts/build_player_mapping.py
docker compose up --build
```

API: `http://localhost:8000`

Web: `http://localhost:3000`

## Status

Repo bootstrap er på plass. Primær fantasy-priskilde er funnet og dokumentert i `docs/DATA_SOURCES.md`:

- Offisiell FIFA fantasy player pool: `https://play.fifa.com/json/fantasy/players.json`
- Offisielle lag/squads: `https://play.fifa.com/json/fantasy/squads.json`
- Checksums: `https://play.fifa.com/json/fantasy/checksums.json`
- VM-backbone: `services/worldcup` som git submodule mot `emrbli/worldcup`

Importer offisielle priser, TV2-priser og bygg mapping mot `emrbli/worldcup`:

```bash
python3 scripts/import_fifa_fantasy_prices.py
python3 scripts/import_tv2_fantasy_prices.py
python3 scripts/build_player_mapping.py
```

Start API lokalt:

```bash
cd apps/api
python3 -m venv .venv
. .venv/bin/activate
pip install -e '.[dev]'
uvicorn footballsage_api.main:app --reload
```

OCR-import bruker lokal `tesseract`. Docker-imaget installerer dette automatisk; for lokal API-kjøring må `tesseract` finnes på maskinen.

Test:

```bash
cd apps/api
pytest
```

Docker dev stack:

```bash
docker compose up --build
```

## API status

- `GET /health`
- `GET /teams` fra `emrbli/worldcup` dump/API
- `GET /fixtures` fra `emrbli/worldcup` dump/API
- `GET /players?round=1&provider=fifa_official|tv2` med pris, mapping-status, next fixture og enkel v1 xP
- `POST /team/import-screenshot` for initiell OCR av TV2-lagoppstilling, alltid med manuell verifikasjon
- `POST /team/import-text` for samme matching fra limt tekst
- `POST /sage/advice` for LLM-basert Sage-rådgivning over laganalyse, fixtures, xP og bytte-kandidater

Sage krever LLM-konfig på API-serveren:

```bash
SAGE_LLM_PROVIDER=openai|openrouter|anthropic
SAGE_LLM_MODEL=<model>
OPENAI_API_KEY=...        # eller OPENROUTER_API_KEY / ANTHROPIC_API_KEY

# Valgfritt: egen vision-modell for screenshot-OCR.
# Hvis OpenRouter er konfigurert og denne mangler, brukes google/gemini-3-flash-preview for OCR.
SAGE_OCR_LLM_MODEL=<vision-model>
```

## Mapping status

Sist generert mapping:

- `1168` matched
- `23` review
- `294` unmatched

Dette er konservativt: samme land kreves, og usikre fuzzy-matcher merkes `review`/`unmatched`.

## Struktur

```text
apps/api/              FastAPI fantasy API
apps/web/              Next.js UI
packages/fantasy-core/ Delte fantasy-typer/regler
packages/optimizer/    Optimizer package placeholder
packages/projections/  Projection package placeholder
packages/ai-tools/     LLM tool wrappers placeholder
services/worldcup/     git submodule: emrbli/worldcup
data/fantasy-prices/   Offisiell/importert FIFA fantasy price CSV
data/tv2-prices/        Importert TV2 fantasy price CSV
data/mappings/         FIFA Fantasy -> worldcup player mappings
data/snapshots/        Runtime snapshots/cache
docs/                  Plan og datakilder
scripts/               Import-/sync-scripts
```

## License og data

Kode i dette repoet er MIT-lisensiert. Tredjepartsdata eies av respektive kilder; se `docs/DATA_SOURCES.md`. `services/worldcup` er en git submodule mot `emrbli/worldcup` og beholder sin egen lisens/attribusjon.
