# Whose Build? (ARAM Mayhem edition)

Party games built on your friends' ARAM Mayhem builds.

**Play** has four modes:
- **Whose build?** See a build, guess which friend made it.
- **Which champ?** See a build and who made it, pick the champion from a
  draft-style grid (search + class filters, guesses per round is a setting).
- **Odd one out:** four builds, three by the same friend. Find the impostor.
- **Did it win?** See the build, guess the result.

**Daily** is the same 5 "Whose build?" rounds for everyone each day (resets at
midnight Pacific), with a copyable emoji result for the group chat. It only
uses games collected before the day started, so it can't change mid-day.

**Hall of Shame** ranks the weirdest builds. Weirdness (0-100) compares a
build with how *other players in your lobbies* built the same champion (falling
back on the champion's class when there are few examples), as a percentile:
90 means weirder than 90% of lobby builds. Components and consumables are
ignored. The strangers' builds never leave your PC; only the scores do.

**Player profiles** open from any player's name (after a round is answered,
in the Hall of Shame, or the ⓘ next to each name in Players & options):
signature items and augments vs. the rest of the group, most played
champions, win rate, and their weirdest build. Links like
`.../#player=ube%23mlkt` open a profile directly.

Riot's public API hides Mayhem games, so the collector reads them from the
League client running on your PC (the client's local "LCU" API). The client
only shows each player's last ~20 games, so the collector runs regularly and
builds up the history over time.

## Files

| File | What it is |
|---|---|
| `players.txt` | Your friends' Riot IDs, one per line |
| `collect.py` | Collector + exporter (Python 3.10+, no installs) |
| `weirdness.py` | Weirdness scores vs. other players in your lobbies (used by the exporter) |
| `descriptions.py` | Item/spell/augment descriptions for the hover popups (used by the exporter) |
| `start_collector.bat` / `stop_collector.bat` | Start/stop the background collector (Windows) |
| `docs/index.html`, `app.js`, `style.css` | The game |
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

With `--push` on, every cycle starts with a `git pull`, so edits made on
GitHub (like a new name in `players.txt`) apply within one cycle. Code
changes are pulled too, but only take effect after a restart; the log says
so when that happens.


`.gitignore` keeps the database, logs and `.env` out of the repo. Only your
friends' builds are exported; strangers from your lobbies stay local.


## Notes

- If a friend changes their Riot ID, just update `players.txt`. Games are
  matched by account (PUUID), so their older games carry over to the new name.
- Hovering (or tapping) an item, augment or summoner spell shows its
  description. Item and spell text comes from the client; augment text comes
  from the [League of Legends Wiki](https://wiki.leagueoflegends.com/en-us/ARAM_Mayhem/Augments)
  (downloaded at export time, cached for a day in `cache_static/`). Run
  `python descriptions.py` to check how many augment descriptions it finds.
- Items or augments without a name show as their numeric ID. Run
  `python collect.py --find-static` to see which data sources are reachable.
