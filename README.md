# FootballSage

Gratis, selvhostet AI fantasy football advisor for FIFA World Cup Fantasy 2026.

Sage importerer laget ditt (screenshot eller tekst), sjekker mot fantasy-reglene, og gir
LLM-baserte råd om bytter, kaptein og risiko før neste runde.

## Quickstart

```bash
git clone --recurse-submodules https://github.com/ovestokke/footballsage.git
cd footballsage

# Importer offisiell FIFA-data, TV2-priser og bygg player mapping
python3 scripts/import_fifa_fantasy_prices.py
python3 scripts/import_tv2_fantasy_prices.py
python3 scripts/build_player_mapping.py

# Konfigurer Sage-LLM (kun hvis du skal bruke AI-råd)
cp example.env .env
# Rediger .env og fyll inn API-key

# Start API + web
pnpm install
docker compose up --build
```

- API: `http://localhost:8000`
- Web: `http://localhost:3000`

## Lokal utvikling

```bash
# API
cd apps/api
python3 -m venv .venv
. .venv/bin/activate
pip install -e '.[dev]'
uvicorn footballsage_api.main:app --reload

# Web
cd apps/web
pnpm dev

# Tester
pnpm test:api          # fra root
pnpm build:web         # sjekk at frontend bygger
```

## API

| Endpoint | Beskrivelse |
|---|---|
| `GET /health` | Helse |
| `GET /teams` | Alle VM-lag |
| `GET /fixtures` | Alle kamper, filter på stage/team |
| `GET /players?round=&provider=&position=&team=` | Spillere med pris, xP, mapping-status |
| `POST /team/import-text` | Match spillerliste mot pris-katalog |
| `POST /team/import-screenshot` | OCR av TV2-lagoppstilling (LLM-vision, fallback tesseract) |
| `POST /team/analyze` | Regelsjekk av bekreftet lag |
| `POST /sage/advice` | AI-råd fra Sage: bytter, kaptein, problemer for neste runde |

## Sage – LLM-konfigurasjon

Kopier `example.env` til `.env` og fyll inn.

```bash
# Obligatorisk
SAGE_LLM_PROVIDER=openrouter
SAGE_LLM_MODEL=deepseek/deepseek-v4-flash
OPENROUTER_API_KEY=sk-or-v1-...

# Valgfritt: egen vision-modell for screenshot-OCR.
# Bruker automatisk google/gemini-3-flash-preview hvis provider er openrouter.
# SAGE_OCR_LLM_MODEL=google/gemini-3-flash-preview
```

`.env` er gitignoret. Uten LLM-konfig vil `/sage/advice` returnere 503.

## Struktur

```text
apps/api/              FastAPI fantasy API + Sage advisor
apps/web/              Next.js UI
packages/              Delte pakker (fantasy-core, optimizer, projections, ai-tools)
services/worldcup/     Git submodule: emrbli/worldcup (VM-data)
data/                  Fantasy-priser, mappings, snapshots
scripts/               Import-/sync-scripts
```

## License

Kode: MIT. Tredjepartsdata eies av respektive kilder, se `docs/DATA_SOURCES.md`.
