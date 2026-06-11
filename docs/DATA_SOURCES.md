# Data sources

## Fantasy player prices

Valgt kilde: den offentlige JSON-filen som den offisielle FIFA World Cup Fantasy 2026-webappen selv laster.

- Player pool/priser: `https://play.fifa.com/json/fantasy/players.json`
- Squads/land: `https://play.fifa.com/json/fantasy/squads.json`
- Rounds/fixtures i fantasy-spillet: `https://play.fifa.com/json/fantasy/rounds.json`
- Checksums: `https://play.fifa.com/json/fantasy/checksums.json`
- Offisiell help/rules: `https://play.fifa.com/fantasy/help`

FIFA help bekrefter at hver spiller har en fast pris, at budsjettet starter på $100m, og at prisene ikke endres gjennom turneringen. Det gjør CSV-snapshot egnet som stabil input til optimizer/projections.

### Verifisert 2026-06-11

`players.json` var offentlig tilgjengelig uten innlogging med browser-lignende headers og inneholdt:

- 1485 spillere
- felter: `id`, `firstName`, `lastName`, `knownName`, `squadId`, `position`, `price`, `status`, `percentSelected`, `stats`, `fifaId`
- prisintervall: 3.5–10.5
- posisjoner: `GK`, `DEF`, `MID`, `FWD`

### Import

Kjør:

```bash
python3 scripts/import_fifa_fantasy_prices.py
```

Output:

- `data/fantasy-prices/world-cup-2026-official.csv`
- `data/fantasy-prices/world-cup-2026-official.meta.json`

### Notater

- Dette er offisiell fantasy-data, ikke `emrbli/worldcup`-data.
- `worldcup_player_id` holdes tom inntil vi matcher mot `emrbli/worldcup` squads/spillere.
- Scriptet bruker bare offentlige JSON-endepunkter. Ingen FIFA-konto, cookies eller private API-nøkler trengs.
- Hvis FIFA endrer endepunkter, bruk webappens JS bundle på `https://play.fifa.com/fantasy/` som kilde til gjeldende JSON base path.

## TV2 VM Fantasy prices

TV2 eksponerer en offentlig, statisk CSV med spillerprisene:

- `https://vmfantasy.tv2.no/images/TV%202%20VM%20Fantasy%20-%20priser.csv`

Verifisert 2026-06-11:

- HTTP 200 fra Vercel/static asset
- `content-type: text/csv; charset=utf-8`
- `access-control-allow-origin: *`
- `last-modified: Thu, 11 Jun 2026 09:55:28 GMT`
- header/felter: `land,spiller,position,pris`
- 1249 spillere, 48 land
- posisjoner er norsk-kodet: `KEE`, `FOR` (forsvar), `MID`, `ANG`

Import:

```bash
python3 scripts/import_tv2_fantasy_prices.py
```

Output:

- `data/tv2-prices/world-cup-2026-tv2.csv`
- `data/tv2-prices/world-cup-2026-tv2.meta.json`

Eksempler som bekrefter at TV2-prisene avviker fra FIFA official snapshot:

- Erling Haaland: TV2 12.5m, FIFA official 10.5m
- Mohamed Salah: TV2 10.5m, FIFA official 10.0m
- Marcus Rashford: TV2 8.5m, FIFA official 7.5m

## Team input / OCR

TV2-lag kan importeres uten login/API via:

1. `POST /team/import-screenshot` med base64-image. API kjører lokal `tesseract` hvis tilgjengelig.
2. `POST /team/import-text` med limt tekst.

Begge returnerer foreløpige spillerkandidater fra TV2-prislisten. Resultatet er ikke fasit; UI-en må vise manuell verifikasjon før laget lagres/rates.

## World Cup base data

Primærkilde for VM-data:

- `services/worldcup` git submodule: `https://github.com/emrbli/worldcup`

Brukes for lag, grupper, fixtures, squads/spillere og live data. Fantasy-priser/posisjoner kommer fra FIFA fantasy-kilden over.

FootballSage-adapteren kan lese:

1. `WORLDCUP_API_URL` hvis en lokal `emrbli/worldcup` API kjører.
2. Fallback direkte fra `services/worldcup/db/dump/worldcup.sql.gz`, slik at repoet fungerer uten å starte Postgres.

## Player mapping

Mapping genereres med:

```bash
python3 scripts/build_player_mapping.py
```

Output:

- `data/mappings/fifa-to-worldcup-players.csv`
- `data/mappings/manual-player-overrides.csv` for håndjusteringer

Sist generert status:

- matched: 1168
- review: 23
- unmatched: 294

Regel: samme FIFA country code kreves. Navn matches konservativt; usikre treff markeres for review i stedet for å late som mappingen er sikker.
