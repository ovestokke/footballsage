# Deploy med Caddy + Authelia (Unraid)

FootballSage kjører to containere: `api` (FastAPI) og `web` (Next.js).
Next.js proxyer `/api/*` internt til API-containeren via en route-handler,
så kun web-porten trenger å eksponeres.

## docker-compose (Unraid)

```yaml
services:
  api:
    # ... som compose.yaml
    # Ingen ports – API nås internt via Next.js /api route-proxy
    volumes:
      # Persist kun lagrede lag. Ikke mount hele ./data over /app/data.
      - ./data/teams:/app/data/teams

  web:
    # ... som compose.yaml
    ports:
      - "3000:3000"
    environment:
      API_INTERNAL_URL: http://api:8000
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

```
Browser → https://footballsage.example.com/api/saved-teams
  → Caddy → <app-server-ip>:3000/api/saved-teams
    → Next.js route-proxy → http://api:8000/saved-teams
      → FastAPI svarer
```

Ingen CORS, ingen port-eksponering for API, fungerer likt fra localhost,
LAN-IP, Tailscale og offentlig domene.

## Sjekkliste

- [ ] `.env`: `NEXT_PUBLIC_API_BASE_URL=/api`
- [ ] compose: kun web-port eksponert, `API_INTERNAL_URL=http://api:8000`
- [ ] compose: API-volum er `./data/teams:/app/data/teams`, ikke `./data:/app/data`
- [ ] Caddy: subdomene → `<app-server-ip>:3000`
- [ ] Authelia: legg til `import authelia_middleware` om ønsket
- [ ] Åpne `https://footballsage.example.com` → team-select vises med CSS
- [ ] Åpne `https://footballsage.example.com/api/health` → `{"status":"ok"}`
