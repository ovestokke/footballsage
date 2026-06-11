# FootballSage / FantasySage – plan

Mål: Bygge en gratis, selvhostet AI fantasy football helper for FIFA World Cup Fantasy, uten SaaS-abonnement. Bruk `emrbli/worldcup` som VM-datakilde, og bygg fantasy-spesifikke predictions, optimizer og AI-assistent oppå.

## 1. Prinsipp

- Ikke bygg VM-datagrunnlaget selv.
- Bruk open-source World Cup backend som kilde for:
  - lag
  - grupper
  - fixtures
  - squads/spillere
  - venues/tidspunkt
  - live scores/events/lineups når turneringen går
- Bygg selv:
  - fantasy-priser
  - scoringregler
  - expected points
  - optimal squad/transfer logic
  - AI-chat med egen API-key

## 2. Primær datakilde

Repo: https://github.com/emrbli/worldcup

Hvorfor:

- MIT-lisens
- ferdig World Cup 2026 backend
- Postgres + REST API + WebSocket
- pre-loaded dataset
- squads, fixtures, groups, teams, stadiums
- live-ready tables/adapters
- kan kjøres lokalt med Docker

Første oppsett:

```bash
git clone https://github.com/emrbli/worldcup.git services/worldcup
docker compose up -d
pnpm install
pnpm dev
```

## 3. Arkitektur

```text
services/worldcup
  ↓ REST/Postgres
apps/api / fantasy adapter
  ↓ normalized fantasy data
projection engine
  ↓ expected points
optimizer
  ↓ best squads / transfers / captain plans
AI assistant
  ↓ explanations, scenarios, strategy
web UI
```

Foreslått monorepo:

```text
FootballSage/
  apps/
    web/                  # Next.js UI
    api/                  # FastAPI eller Node API for fantasy logic
  packages/
    fantasy-core/         # regler, scoring, types
    optimizer/            # squad/transfer optimizer
    projections/          # expected points model
    ai-tools/             # LLM tool wrappers
  services/
    worldcup/             # git submodule/clone av emrbli/worldcup eller docker compose reference
  data/
    fantasy-prices/       # importert/offisiell player price data
    snapshots/            # cached snapshots
  docs/
    PLAN.md
```

## 4. Fantasy-spesifikk data vi må ha selv

`emrbli/worldcup` gir VM-data, men ikke nødvendigvis offisiell fantasy-data.

Vi må importere/vedlikeholde:

- player prices
- official fantasy positions
- scoring rules
- squad constraints
- transfer/chip rules
- ownership hvis scouting bonus er relevant

Formatforslag:

```csv
player_id,worldcup_player_id,name,team,position,price,official_position,status
```

Start manuelt/CSV. Senere scraper/import hvis offisiell API finnes.

## 5. Projection engine v1

Ikke start med tung ML. Start med forklarbar modell:

Input:

- spillerpris
- posisjon
- nasjon/lagstyrke
- fixture difficulty
- forventede minutter
- sannsynlig starter
- clean sheet probability
- attacking role
- penalty/set pieces hvis kjent
- odds/Elo hvis tilgjengelig

Output:

```ts
{
  playerId: string,
  round: number,
  expectedPoints: number,
  floor: number,
  ceiling: number,
  startProbability: number,
  minutesProjection: number,
  confidence: number,
  reasons: string[]
}
```

V1 formel:

```text
xP = minutes_factor
   * (appearance_points
      + goal_xp
      + assist_xp
      + clean_sheet_xp
      + bonus_proxy
      + save/card/defensive_proxy)
   * fixture_modifier
   * role_confidence
```

## 6. Optimizer

Bruk lineær programmering / integer programming.

Mulige libs:

- Python: OR-Tools, PuLP, highspy
- Inspirasjon: https://github.com/solioanalytics/open-fpl-solver

Constraints:

- budsjett, f.eks. 100m
- 15 spillere
- posisjonskrav: 2 GK, 5 DEF, 5 MID, 3 FWD
- maks spillere per nasjon
- legal starting XI formation
- captain/vice captain
- locked players
- avoided players
- risk profile
- transfers per round
- chips/boosters senere

Optimizer endpoints/tools:

- `optimize_squad(round, strategy, locks, avoids)`
- `compare_players(playerA, playerB, round)`
- `captain_plan(round)`
- `suggest_transfers(currentSquad, round)`
- `rate_team(squad, round)`

## 7. AI assistant

AI-en skal ikke gjette tall. Den skal bruke tools og forklare resultatene.

BYO-key:

```env
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
OPENROUTER_API_KEY=
```

Tool-basert flyt:

```text
User: Lag beste MD1-lag med lav risiko
LLM -> optimize_squad(strategy=safe)
LLM -> explain_squad(result)
```

Mulig MCP senere:

- Lag en MCP-server inspirert av `lewis-king/fpl-mcp-server`
- Eksponer FootballSage-tools til Claude/Desktop/Pi

## 8. Web UI MVP

Sider:

1. Dashboard
   - next deadline
   - upcoming fixtures
   - best captain candidates
2. Player Explorer
   - sort by xP, value, risk, ownership, team
3. Squad Builder
   - lock/avoid players
   - run optimizer
   - show budget/constraints
4. Team Rater
   - paste/import squad
   - get rating + weaknesses
5. AI Chat
   - questions with tool-backed answers

## 9. MVP milepæler

### Milestone 0 – repo/bootstrap

- Init monorepo
- Docker compose for local dev
- Add docs/PLAN.md
- Decide stack: Next.js + Python FastAPI recommended

### Milestone 1 – data adapter

- Run `emrbli/worldcup`
- Fetch teams, players, fixtures into local normalized tables/cache
- Add fantasy price CSV import
- Basic API endpoints:
  - `/players`
  - `/fixtures`
  - `/teams`

### Milestone 2 – projections v1

- Implement simple xP model
- Fixture difficulty from team strength/Elo/manual ratings
- Produce xP per player per round
- Add reason strings for explainability

### Milestone 3 – optimizer v1

- Legal 15-man squad optimizer
- Budget + positions + max nation constraints
- Lock/avoid players
- Return best XI, bench, captain, vice

### Milestone 4 – AI tools

- Tool wrappers around projections/optimizer
- BYO API-key config
- Chat endpoint with grounded answers

### Milestone 5 – UI

- Player explorer
- Squad optimizer page
- Team rating
- AI chat

## 10. Første tekniske valg

Anbefalt stack:

- Backend/fantasy logic: Python FastAPI
- Optimizer: OR-Tools eller PuLP/HiGHS
- Web: Next.js + Tailwind
- DB/cache: Postgres eller SQLite for vår fantasy layer
- World Cup data: `emrbli/worldcup` via REST eller direkte Postgres
- AI: LiteLLM/OpenRouter-compatible wrapper for BYO keys

## 11. Risikoer

- Offisiell FIFA fantasy API/priser kan være vanskelig å hente automatisk.
  - Løsning: start med CSV/manual import.
- Squads/lineups endres tett på kamp.
  - Løsning: sync ofte og marker confidence/startProbability.
- LLM kan hallusinere.
  - Løsning: LLM må bare forklare tool outputs, ikke finne på tall.
- Datakilde kan ha mangler.
  - Løsning: fallback til `openfootball/worldcup.json` og manuelle overrides.

## 12. Startkommando for implementering

Når repoet er klart:

```bash
mkdir -p apps/api apps/web packages docs data/fantasy-prices
cp /path/to/this/plan docs/PLAN.md
```

Første feature å bygge:

> Import teams/players/fixtures fra `emrbli/worldcup`, importer fantasy prices CSV, og eksponer `/players?round=1` med basic expected points.
