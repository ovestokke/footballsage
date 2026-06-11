# Fantasy prices

Offisiell FIFA World Cup Fantasy 2026 player pool importeres fra:

```text
https://play.fifa.com/json/fantasy/players.json
https://play.fifa.com/json/fantasy/squads.json
https://play.fifa.com/json/fantasy/checksums.json
```

Oppdater CSV:

```bash
python3 scripts/import_fifa_fantasy_prices.py
```

`worldcup_player_id` er bevisst tom inntil vi matcher mot `emrbli/worldcup`.
