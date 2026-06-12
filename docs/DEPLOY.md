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

  web:
    # ... som compose.yaml
    ports:
      - "3000:3000"
    environment:
      API_INTERNAL_URL: http://api:8000
```

## .env

```bash
# Relativ path – browser kaller /api/*, Next.js proxyer internt
NEXT_PUBLIC_API_BASE_URL=/api
```

## Caddy (subdomene)

```
footballsage.vstokke.com {
    import common
    import logging footballsage
    import authelia_middleware

    reverse_proxy 192.168.1.230:3000
}
```

Trengs ingen `handle_path` eller path-ruting. Next.js sin `/api/[...path]`
route-handler sender `/api/*` til API-containeren internt.

## Slik fungerer det

```
Browser → https://footballsage.vstokke.com/api/saved-teams
  → Caddy → 192.168.1.230:3000/api/saved-teams
    → Next.js route-proxy → http://api:8000/saved-teams
      → FastAPI svarer
```

Ingen CORS, ingen port-eksponering for API, fungerer likt fra localhost,
LAN-IP, Tailscale og offentlig domene.

## Sjekkliste

- [ ] `.env`: `NEXT_PUBLIC_API_BASE_URL=/api`
- [ ] compose: kun web-port eksponert, `API_INTERNAL_URL=http://api:8000`
- [ ] Caddy: subdomene → `192.168.1.230:3000`
- [ ] Authelia: legg til `import authelia_middleware` om ønsket
- [ ] Åpne `https://footballsage.vstokke.com` → team-select vises med CSS
- [ ] Åpne `https://footballsage.vstokke.com/api/health` → `{"status":"ok"}`
