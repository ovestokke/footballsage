# Deploy med Caddy + Authelia (Unraid)

FootballSage kjører fire containere:

- `web` (Next.js)
- `api` (FastAPI)
- `worldcup-api` (VM-data/live-score service)
- `worldcup-postgres` (VM-database preloaded med tournament dump)

Next.js proxyer `/api/*` internt til API-containeren via en route-handler,
så kun web-porten trenger å eksponeres. FootballSage API leser live VM-data fra
`worldcup-api` via internt Docker-nettverk.

## docker-compose (Unraid)

```yaml
services:
  worldcup-postgres:
    image: postgres:17
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: ${WORLDCUP_DB_PASSWORD:-dev}
      POSTGRES_DB: worldcup
    volumes:
      - worldcup-pgdata:/var/lib/postgresql/data
      - ./services/worldcup/db/dump:/docker-entrypoint-initdb.d:ro
    expose:
      - "5432"
    restart: unless-stopped

  worldcup-api:
    image: node:24-alpine
    working_dir: /app/services/worldcup
    command: sh -c "corepack enable && pnpm install --ignore-workspace --prod=false && pnpm build && NODE_ENV=production pnpm start:prod"
    environment:
      CI: "true"
      NODE_ENV: production
      DATABASE_URL: postgres://postgres:${WORLDCUP_DB_PASSWORD:-dev}@worldcup-postgres:5432/worldcup
      # Upstream krever ikke-tom verdi ved startup selv når football-data jobs er av.
      # ESPN live-sync fungerer uten ekte token.
      FOOTBALL_DATA_TOKEN: ${FOOTBALL_DATA_TOKEN:-dev-placeholder}
      LIVE_SYNC_ENABLED: "true"
      LIVE_SYNC_CRON: "*/30 * * * * *"
      LINEUPS_SYNC_ENABLED: "false"
      OFFICIALS_SYNC_ENABLED: "false"
      PUSH_ENABLED: "false"
      PORT: "3001"
    volumes:
      - .:/app
      - /app/services/worldcup/node_modules
      - pnpm-store:/root/.local/share/pnpm/store
    expose:
      - "3001"
    depends_on:
      - worldcup-postgres
    restart: unless-stopped

  api:
    image: ghcr.io/ovestokke/footballsage-api:latest
    env_file:
      - path: .env
        required: false
    environment:
      WORLDCUP_API_URL: http://worldcup-api:3001/v1
    volumes:
      # Persist kun lagrede lag. Ikke mount hele ./data over /app/data.
      - ./data/teams:/app/data/teams
    expose:
      - "8000"
    depends_on:
      - worldcup-api
    restart: unless-stopped

  web:
    image: ghcr.io/ovestokke/footballsage-web:latest
    environment:
      API_INTERNAL_URL: http://api:8000
      NEXT_PUBLIC_API_BASE_URL: /api
    ports:
      - "3000:3000"
    depends_on:
      - api
    restart: unless-stopped

volumes:
  worldcup-pgdata:
  pnpm-store:
```

## Volumregel

API-imaget inneholder statiske CSV-filer for priser/mappings under `/app/data`.
Mount derfor bare teams-mappen:

```yaml
volumes:
  - ./data/teams:/app/data/teams
```

Ikke bruk:

```yaml
volumes:
  - ./data:/app/data
```

Det skjuler de innebygde CSV-filene og gir feil som:

```text
Missing /app/data/tv2-prices/world-cup-2026-tv2.csv
```

## .env

```bash
# Relativ path – browser kaller /api/*, Next.js proxyer internt
NEXT_PUBLIC_API_BASE_URL=/api

# Valgfritt, men anbefalt å sette eksplisitt i prod
WORLDCUP_DB_PASSWORD=<sett-et-passord>

# Ikke nødvendig å sette for live-score. Compose bruker dev-placeholder default
# fordi upstream worldcup-api validerer at variabelen finnes ved startup.
# FOOTBALL_DATA_TOKEN=dev-placeholder
```

## Caddy (subdomene)

```
footballsage.example.com {
    import common
    import logging footballsage
    import authelia_middleware

    reverse_proxy <app-server-ip>:3000
}
```

Trengs ingen `handle_path` eller path-ruting. Next.js sin `/api/[...path]`
route-handler sender `/api/*` til API-containeren internt.

## Slik fungerer det

```text
Browser → https://footballsage.example.com/api/fixtures
  → Caddy → <app-server-ip>:3000/api/fixtures
    → Next.js route-proxy → http://api:8000/fixtures
      → FastAPI → http://worldcup-api:3001/v1/matches
        → worldcup-postgres
```

Hvis `worldcup-api` mangler eller `WORLDCUP_API_URL` ikke er satt i `api`, vil
FastAPI falle tilbake til statisk SQL-dump som ligger i API-imaget. Da virker
appen, men live-score oppdateres ikke.

Ingen CORS, ingen port-eksponering for API, fungerer likt fra localhost,
LAN-IP, Tailscale og offentlig domene.

## Sjekkliste

- [ ] `.env`: `NEXT_PUBLIC_API_BASE_URL=/api`
- [ ] compose: kun web-port eksponert, `API_INTERNAL_URL=http://api:8000`
- [ ] compose: `api.environment.WORLDCUP_API_URL=http://worldcup-api:3001/v1`
- [ ] compose: API-volum er `./data/teams:/app/data/teams`, ikke `./data:/app/data`
- [ ] `docker compose ps` viser `worldcup-postgres`, `worldcup-api`, `api`, `web`
- [ ] `docker compose logs worldcup-api` viser `live-score sync ... updated=...`
- [ ] Caddy: subdomene → `<app-server-ip>:3000`
- [ ] Authelia: legg til `import authelia_middleware` om ønsket
- [ ] Åpne `https://footballsage.example.com` → team-select vises med CSS
- [ ] Åpne `https://footballsage.example.com/api/health` → `{"status":"ok"}`
- [ ] Åpne `https://footballsage.example.com/api/fixtures?limit=6` → live-kamper har `status`, `minute` og score
