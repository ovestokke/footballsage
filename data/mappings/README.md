# Player mappings

`fifa-to-worldcup-players.csv` maps official FIFA Fantasy players to `emrbli/worldcup` player IDs.

Regenerate:

```bash
python3 scripts/build_player_mapping.py
```

Manual fixes go in `manual-player-overrides.csv` using:

```csv
fantasy_player_id,worldcup_player_id,note
```

Matching is intentionally conservative:

- same FIFA country code is required
- exact normalized name wins
- high fuzzy matches are marked `matched`
- weaker matches are marked `review`
- uncertain rows are left `unmatched`
