# FootballSage

Selvhostet AI-rådgiver for FIFA World Cup Fantasy 2026.

FootballSage lar deg importere fantasy-laget ditt fra tekst eller screenshot, sjekker laget mot reglene, lagrer flere lag server-side, og bruker en LLM til å foreslå bytter, kaptein og risikopunkter før neste runde.

## Hva du får

- Webapp for desktop og mobil
- Import fra tekst eller screenshot
- Lag-sjekk mot fantasy-regler
- Flere lag lagret på serveren
- AI-råd via OpenRouter/OpenAI/Anthropic-kompatibel konfig
- Docker Compose-oppsett uten lokal Python/pnpm-installasjon
- API-et er internt; browseren bruker samme-origin `/api/...`

## Quickstart

Krever kun:

- Docker
- Docker Compose
- En LLM API-key hvis du vil bruke Sage-råd/OCR

```bash
git clone --recurse-submodules https://github.com/ovestokke/footballsage.git
cd footballsage

cp example.env .env
# Rediger .env og fyll inn OPENROUTER_API_KEY eller annen støttet LLM-key.

docker compose up --build
```

Åpne:

```text
http://localhost:3000
```

På en annen enhet på samme nettverk:

```text
http://SERVER-IP:3000
```

Eksempel:

```text
http://192.168.1.132:3000
```

## Konfigurasjon

Minimum for AI-råd:

```env
NEXT_PUBLIC_API_BASE_URL=/api
SAGE_LLM_PROVIDER=openrouter
SAGE_LLM_MODEL=deepseek/deepseek-v4-flash
OPENROUTER_API_KEY=sk-or-v1-...
```

Valgfri web-port:

```env
WEB_PORT=3000
```

Start på annen port:

```bash
WEB_PORT=3010 docker compose up --build
```

`.env` er gitignoret. Ikke commit API-nøkler.

Uten LLM-konfig starter appen fortsatt, men Sage-råd og screenshot-OCR vil returnere konfig-feil.

## Docker-oppsett

Default `compose.yaml` er ment for enkel produksjonslignende kjøring:

```text
Browser
  -> http://server:3000
    -> Next.js web
      -> intern Docker-network
        -> FastAPI api:8000
```

Kun web-porten publiseres. API-et har ingen public `ports:` i default compose.

## Lagrede lag

Lag lagres server-side her:

```text
data/teams/*.json
```

Disse JSON-filene er gitignoret, men `data/teams/` mountes persistent av Docker Compose. Det betyr at lagene overlever container-restart/rebuild.

Backup:

```bash
tar -czf footballsage-teams-backup.tgz data/teams
```

## Vanlige kommandoer

Start:

```bash
docker compose up --build
```

Start i bakgrunn:

```bash
docker compose up -d --build
```

Se logger:

```bash
docker compose logs -f
```

Se bare web/API:

```bash
docker compose logs -f web
docker compose logs -f api
```

Stoppe:

```bash
docker compose down
```

Oppdatere etter git pull:

```bash
git pull --recurse-submodules
docker compose up -d --build
```

## Lokal utvikling

For utvikling med hot reload:

```bash
cp example.env .env
docker compose -f compose.dev.yaml up --build
```

Dev-compose eksponerer også API-porten for debugging:

```text
http://localhost:8000/health
```

Direkte lokal kjøring uten Docker er valgfritt:

```bash
# API
cd apps/api
python3 -m venv .venv
. .venv/bin/activate
pip install -e '.[dev]'
uvicorn footballsage_api.main:app --host 0.0.0.0 --port 8000

# Web
cd apps/web
pnpm install
pnpm dev --hostname 0.0.0.0
```

Ikke kjør `next build` mens `next dev` kjører mot samme `.next`-mappe.

## API

API-et er normalt ikke publisert direkte. Fra browser/web brukes `/api/...`, som proxes server-side til FastAPI.

| Endpoint | Beskrivelse |
|---|---|
| `GET /health` | Helse |
| `GET /teams` | Alle VM-lag |
| `GET /fixtures` | Alle kamper, filter på stage/team |
| `GET /players?round=&provider=&position=&team=` | Spillere med pris, xP, mapping-status |
| `POST /team/import-text` | Match spillerliste mot pris-katalog |
| `POST /team/import-screenshot` | OCR av lagoppstilling |
| `POST /team/analyze` | Regelsjekk av bekreftet lag |
| `POST /sage/advice` | AI-råd fra Sage |
| `GET /saved-teams` | Liste med lagrede lag |
| `POST /saved-teams` | Opprett nytt lag |
| `GET /saved-teams/{id}` | Hent ett lag |
| `PUT /saved-teams/{id}` | Oppdater lag |
| `DELETE /saved-teams/{id}` | Slett lag |

## Feilsøking

Sjekk at web svarer:

```bash
curl http://localhost:3000/
```

Sjekk API via web-proxy:

```bash
curl http://localhost:3000/api/health
```

Hvis Sage feiler, sjekk API-logg:

```bash
docker compose logs -f api
```

Hvis du får LLM-konfig-feil: sjekk at `.env` finnes og at riktig API-key er satt.

## Struktur

```text
apps/api/              FastAPI fantasy API + Sage advisor
apps/web/              Next.js UI
packages/              Delte pakker
services/worldcup/     Git submodule: emrbli/worldcup (VM-data)
data/                  Fantasy-priser, mappings, snapshots, saved teams
scripts/               Import-/sync-scripts
```

## License

Kode: MIT. Tredjepartsdata eies av respektive kilder, se `docs/DATA_SOURCES.md`.
