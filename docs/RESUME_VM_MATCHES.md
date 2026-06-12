# Resume: VM-kamper / live-resultater

Dato: 2026-06-12

## Brukerkrav

- Egen VM-kamper-fane i FootballSage.
- Mobilvennlig, én dag av gangen — ikke én lang liste.
- CET-tider.
- Live feed / stilling når tilgjengelig.
- Samme stil som appen, men litt bold/sexy.
- Ikke anta at ting fungerer; test før du sier ferdig.
- Bruk `services/worldcup` submodule (`https://github.com/emrbli/worldcup`) som VM-datakilde, ikke direkte ESPN-kall i FootballSage API.

## Hva som er gjort

### Frontend

Fil: `apps/web/app/page.tsx`

- Lagt til hovedmodus/fane: `Sage` / `VM-kamper`.
- Lagt til `WorldCupMatches`, `MatchCard`, `TeamLine`.
- Henter `/api/fixtures?limit=500`.
- Dagvelger basert på CET (`Europe/Oslo`).
- Polling:
  - 30 sek hvis live-kamper finnes.
  - 5 min ellers.
- Viser score/status hvis API-et leverer det.
- Fjernet fallback-teksten `Stadion kommer`; stadion vises bare hvis `fixture.venue` finnes.

Fil: `apps/web/app/styles.css`

- Lagt til `mode-tabs`, matchday hero, date rail, kampkort, live-kort, mobilregler.

### FootballSage API

Fil: `apps/api/footballsage_api/main.py`

- `Fixture` response har nå:
  - `minute`
  - `home_score`
  - `away_score`
  - `home_score_ht`
  - `away_score_ht`
  - `home_pens`
  - `away_pens`
  - `venue`

Fil: `apps/api/footballsage_api/worldcup_adapter.py`

- `WorldCupFixture` har samme ekstra felter + `source_ids`.
- `_load_from_api()` leser `/teams` og `/matches` fra `WORLDCUP_API_URL`.
- `_load_from_dump()` leser også `venues` fra submodule-dumpen, slik at stadion kommer fra dump fallback.
- Direkte ESPN-kode ble lagt inn midlertidig, men er fjernet igjen. Bekreft med:
  ```bash
  rg -n "ESPN|espn|SCOREBOARD|with_live_scores|Stadion kommer" apps/api/footballsage_api apps/web/app/page.tsx
  ```
  Forventet: ingen treff, bortsett fra ikke-relevante string replace.

### Dev compose

Fil: `compose.dev.yaml`

- Lagt til `worldcup-postgres` fra submodule dump.
- Lagt til `worldcup-api` service basert på `node:24-alpine`, som kjører `services/worldcup`.
- FootballSage `api` får:
  ```yaml
  WORLDCUP_API_URL: http://worldcup-api:3001/v1
  ```

Merk: `services/worldcup` krever env med `FOOTBALL_DATA_TOKEN`. Foreløpig satt til `dev-placeholder`; live-sync kan feile hvis fallback-kilder krever token, men ESPN/worldcupjson adaptere kan fungere uten. Må testes i Docker.

## Tester kjørt uten Docker

Fra repo root:

```bash
python -m py_compile apps/api/footballsage_api/worldcup_adapter.py apps/api/footballsage_api/main.py
cd apps/web && npx tsc --noEmit
cd /home/ove/projects/footballsage && docker compose -f compose.dev.yaml config >/tmp/footballsage-compose-config.txt
```

Alle OK.

Adapter-test med lokal fake `WORLDCUP_API_URL` ble kjørt og bekreftet at FootballSage adapter leser broker/API-format:

- status `ft`
- score `2-0`
- venue `Estadio Azteca`
- team codes `MEX`/`RSA`

## Docker-verifisert 2026-06-12

Docker fungerer nå for bruker `ove`.

Kjørte:

```bash
docker compose -f compose.dev.yaml up -d --build --force-recreate --renew-anon-volumes
docker compose -f compose.dev.yaml ps
curl -fsS 'http://localhost:3001/v1/matches?date=2026-06-11' | python -m json.tool
docker compose -f compose.dev.yaml exec -T worldcup-api sh -lc 'DATABASE_URL=postgres://postgres:dev@worldcup-postgres:5432/worldcup pnpm sync:live 2026-06-11'
python - <<'PY'
import json, urllib.request
fixtures=json.load(urllib.request.urlopen('http://localhost:3000/api/fixtures?limit=2', timeout=10))
first=fixtures[0]
assert first['home_team']=='Mexico', first
assert first['away_team']=='South Africa', first
assert first['status']=='ft', first
assert first['home_score']==2 and first['away_score']==0, first
assert first['venue']=='Estadio Azteca', first
print('OK Mexico fixture:', first['status'], f"{first['home_score']}-{first['away_score']}", first['venue'])
PY
```

Resultat:

- `worldcup-postgres`, `worldcup-api`, `api`, `web` starter.
- `worldcup-api` starter på `http://localhost:3001/v1`.
- `worldcup-api` live-sync for `2026-06-11` gir Mexico vs South Africa: `ft`, `2-0`, `Estadio Azteca`.
- FootballSage via `http://localhost:3000/api/fixtures?limit=2` returnerer samme `ft`, `2-0`, `Estadio Azteca`.
- `http://localhost:3000/` returnerer 200, HTML inneholder `VM-kamper`-fanen, og Firefox headless screenshot av siden lykkes (`/tmp/footballsage-home.png`).

Fikset under Docker-test:

- `worldcup-api` måtte kjøre `pnpm install --ignore-workspace` fordi repo-root har egen pnpm workspace som ikke inkluderer submodulen.
- La til `CI=true` for å unngå pnpm no-TTY purge-feil.
- FootballSage API hadde evig `lru_cache` på VM-data; endret til kort TTL-cache for `WORLDCUP_API_URL`, slik at live-score updates blir synlige uten API-restart.

## Neste steg ved ny Docker-verifisering

1. Start alt:
   ```bash
   cd /home/ove/projects/footballsage
   docker compose -f compose.dev.yaml up -d --build
   ```

2. Sjekk services:
   ```bash
   docker compose -f compose.dev.yaml ps
   docker compose -f compose.dev.yaml logs --tail=200 worldcup-api
   docker compose -f compose.dev.yaml logs --tail=200 api
   docker compose -f compose.dev.yaml logs --tail=200 web
   ```

3. Test worldcup API direkte:
   ```bash
   curl -sS http://localhost:3001/v1/matches?date=2026-06-11 | python -m json.tool | head -120
   ```

4. Hvis Mexico fortsatt er scheduled i worldcup API, trigger live-sync manuelt eller sjekk om service har endpoint/job. Relevante filer i submodule:
   - `services/worldcup/src/jobs/live-score/live-score.service.ts`
   - `services/worldcup/src/jobs/live-score/live-score.scheduler.ts`
   - `services/worldcup/src/adapters/espn/espn-scoreboard.adapter.ts`
   - `services/worldcup/src/adapters/worldcupjson/worldcupjson-scoreboard.adapter.ts`

5. Test FootballSage proxy/API:
   ```bash
   curl -sS http://localhost:3000/api/fixtures?limit=2 | python -m json.tool
   ```

6. Akseptanse før ferdigmelding:
   - Mexico vs South Africa viser `status` ferdig (`ft`/`finished`).
   - Score er `2-0`.
   - Venue er `Estadio Azteca`.
   - UI laster uten tekniske feil på `http://localhost:3000`, VM-kamper-fanen.
