# Whose Build? (ARAM Mayhem edition)

Guess which friend made a given ARAM Mayhem build.

Riot's public API hides Mayhem games, so the collector reads them from the
League client running on your PC (the client's local "LCU" API). The client
only shows each player's last ~20 games, so the collector runs regularly and
builds up the history over time.

## Files

| File | What it is |
|---|---|
| `players.txt` | Your friends' Riot IDs, one per line |
| `collect.py` | Collector + exporter (Python 3.10+, no installs) |
| `start_collector.bat` / `stop_collector.bat` | Start/stop the background collector (Windows) |
| `docs/index.html` | The game |
| `docs/data.js` | The exported games (generated, gets published) |
| `mayhem.db` | Local database of raw games (generated, never published) |
| `lcu_probe.py` | Diagnostic script from setup, not needed day to day |

## Commands

```
python collect.py --once            # one collection + export (client must be open)
python collect.py --export          # rebuild docs/data.js from the database only
python collect.py --add "Name#TAG"  # add a player (checks the name with the client)
python collect.py --find-static     # check where item/augment names come from
python collect.py                   # loop forever (what start_collector.bat runs)
```

Env vars: `INTERVAL_MIN` (default 30), `MIN_MINUTES` (default 10; shorter
games are left out), `LOL_LOCKFILE` (if League isn't installed in
`C:\Riot Games\League of Legends`).

## Background collection

Double-click `start_collector.bat`. It launches the collector with no window,
shows the last few log lines, and closes after a few seconds. The collector
keeps running: it collects every 30 minutes while the League client is open
and idles while it's closed. Starting it twice is harmless (the second copy
exits). `stop_collector.bat` stops it, and `collect.log` shows what it's doing.

To start it automatically at login: Win+R -> `shell:startup` -> put a shortcut
to `start_collector.bat` in that folder.

Adding a player (`--add`, or just editing `players.txt`) takes effect on the
next cycle; no restart needed. Only their last ~20 games are available at
that point, same as everyone else on day one.


`.gitignore` keeps the database, logs and `.env` out of the repo. Only your
friends' builds are exported; strangers from your lobbies stay local.


## Notes

- If a friend changes their Riot ID, just update `players.txt`. Games are
  matched by account (PUUID), so their older games carry over to the new name.
- Items or augments without a name show as their numeric ID. Run
  `python collect.py --find-static` to see which data sources are reachable.
