#!/usr/bin/env python3
"""
LCU probe: reads match history from the League client's local API.

The public Riot API hides ARAM Mayhem, but the client itself shows it, so
this talks to the client running on this machine instead.

Requirements:
  - The League client must be OPEN and logged in on this machine
    (Windows or macOS). Read-only: nothing here touches the game.
  - Python 3.10+, standard library only.

Usage:
  python lcu_probe.py                       # your own history
  python lcu_probe.py "FriendName#TAG"      # a friend's history
  python lcu_probe.py --lockfile "D:\\Games\\League of Legends\\lockfile"

Env vars:
  PAGES=N   how many pages of 20 games to scan (default 10 = ~200 games)
"""

import base64
import json
import os
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
CACHE = HERE / "cache_lcu"

LOCKFILE_CANDIDATES = [
    r"C:\Riot Games\League of Legends\lockfile",
    r"D:\Riot Games\League of Legends\lockfile",
    "/Applications/League of Legends.app/Contents/LoL/lockfile",
]

# The client serves HTTPS on 127.0.0.1 with a Riot self-signed certificate.
# Verification is skipped for this localhost-only connection.
_SSL = ssl.create_default_context()
_SSL.check_hostname = False
_SSL.verify_mode = ssl.CERT_NONE


def find_lockfile(argv: list[str]) -> Path:
    if "--lockfile" in argv:
        p = Path(argv[argv.index("--lockfile") + 1])
        if p.exists():
            return p
        sys.exit(f"Lockfile not found at {p}")
    for c in LOCKFILE_CANDIDATES:
        if Path(c).exists():
            return Path(c)
    sys.exit("Couldn't find the client lockfile. Is the League client open?\n"
             "If League is installed somewhere unusual, pass --lockfile PATH\n"
             "(it sits in the League of Legends install folder while the "
             "client is running).")


def connect(lockfile: Path):
    # Format: name:pid:port:password:protocol
    _, _, port, password, proto = lockfile.read_text().strip().split(":")
    auth = base64.b64encode(f"riot:{password}".encode()).decode()
    base = f"{proto}://127.0.0.1:{port}"

    def get(path: str, params: dict | None = None):
        url = base + path + ("?" + urllib.parse.urlencode(params) if params else "")
        req = urllib.request.Request(url, headers={
            "Authorization": f"Basic {auth}", "Accept": "application/json"})
        try:
            with urllib.request.urlopen(req, context=_SSL, timeout=15) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            body = e.read().decode(errors="replace")[:300]
            raise RuntimeError(f"HTTP {e.code} on {path}: {body}") from None
    return get


def resolve_puuid(get, riot_id: str | None):
    if not riot_id:
        me = get("/lol-summoner/v1/current-summoner")
        print(f"[1] Logged in as {me.get('gameName')}#{me.get('tagLine')}")
        return me["puuid"]
    name, tag = riot_id.rsplit("#", 1)
    s = get("/lol-summoner/v1/alias/lookup", {"gameName": name, "tagLine": tag})
    print(f"[1] Resolved {riot_id} -> PUUID {s['puuid'][:16]}...")
    return s["puuid"]


def paging_test(get, puuid: str):
    """Try several ways of asking for older games and report what comes back."""
    fmt = lambda ms: time.strftime("%Y-%m-%d", time.localtime(ms / 1000))
    path = f"/lol-match-history/v1/products/lol/{puuid}/matches"
    variants = [
        ("default (no params)",       None),
        ("beg 0  end 20",             {"begIndex": 0,  "endIndex": 20}),
        ("beg 20 end 40",             {"begIndex": 20, "endIndex": 40}),
        ("beg 21 end 41",             {"begIndex": 21, "endIndex": 41}),
        ("beg 0  end 50",             {"begIndex": 0,  "endIndex": 50}),
        ("beg 0  end 100",            {"begIndex": 0,  "endIndex": 100}),
        ("beg 40 end 60",             {"begIndex": 40, "endIndex": 60}),
    ]
    print("[paging test]")
    for label, params in variants:
        try:
            data = get(path, params)
        except RuntimeError as e:
            print(f"  {label:<22} ERROR {e}")
            continue
        g = data.get("games", {})
        games = g.get("games", [])
        if games:
            ids = [x["gameId"] for x in games]
            d = sorted(x["gameCreation"] for x in games)
            print(f"  {label:<22} {len(games):>3} games  {fmt(d[0])} -> {fmt(d[-1])}  "
                  f"ids {min(ids)}..{max(ids)}  "
                  f"(reported beg={g.get('gameIndexBegin')} end={g.get('gameIndexEnd')} "
                  f"count={g.get('gameCount')})")
        else:
            print(f"  {label:<22}   0 games  keys={list(data.keys())}")
        time.sleep(0.3)


def main():
    argv = sys.argv[1:]
    riot_id = next((a for a in argv if "#" in a), None)
    get = connect(find_lockfile(argv))
    CACHE.mkdir(exist_ok=True)

    try:
        puuid = resolve_puuid(get, riot_id)
    except RuntimeError as e:
        sys.exit(f"Couldn't resolve the player: {e}")

    if "--paging-test" in argv:
        paging_test(get, puuid)
        return

    # 2. Page through match history (20 per page).
    pages = int(os.environ.get("PAGES", "10"))
    games, queues = [], Counter()
    for page in range(pages):
        beg = page * 20
        try:
            data = get(f"/lol-match-history/v1/products/lol/{puuid}/matches",
                       {"begIndex": beg, "endIndex": beg + 20})
        except RuntimeError as e:
            print(f"    page {page} failed: {e}")
            break
        batch = data.get("games", {}).get("games", [])
        if not batch:
            break
        new = [g for g in batch if g["gameId"] not in {x["gameId"] for x in games}]
        if not new:          # some clients ignore paging and repeat the same page
            print("    (client returned the same page again; stopping)")
            break
        games.extend(new)
        time.sleep(0.2)

    for g in games:
        queues[(g.get("queueId"), g.get("gameMode"), g.get("mapId"))] += 1
    if not games:
        sys.exit("No games returned.")

    dates = sorted(g["gameCreation"] for g in games)
    fmt = lambda ms: time.strftime("%Y-%m-%d", time.localtime(ms / 1000))
    print(f"[2] {len(games)} games, spanning {fmt(dates[0])} -> {fmt(dates[-1])}")
    print("    (queueId, gameMode, mapId) counts:")
    for (q, mode, m), c in queues.most_common():
        print(f"      queue {q:>5}  {str(mode):<14} map {m}  x{c}")

    # 3. Pick the most likely Mayhem game: map 12 and not plain ARAM (450).
    candidates = [g for g in games if g.get("mapId") == 12 and g.get("queueId") != 450]
    if not candidates:
        candidates = [g for g in games if g.get("mapId") == 12]
    if not candidates:
        print("\nNo Howling Abyss games in this history.")
        return
    gid = candidates[0]["gameId"]

    # 4. Full detail for one game (all 10 participants).
    detail = get(f"/lol-match-history/v1/games/{gid}")
    out = CACHE / f"{gid}.json"
    out.write_text(json.dumps(detail, indent=2))
    print(f"\n[3] Game {gid}: queueId={detail.get('queueId')} "
          f"mode={detail.get('gameMode')} duration={detail.get('gameDuration', 0) // 60}m")
    print(f"    full JSON saved to {out.relative_to(HERE)}")

    names = {pi["participantId"]: pi.get("player", {})
             for pi in detail.get("participantIdentities", [])}
    for p in detail.get("participants", []):
        st = p.get("stats", {})
        items = [st.get(f"item{i}") for i in range(7)]
        augs = [v for k, v in sorted(st.items()) if "ugment" in k.lower() and v]
        pl = names.get(p["participantId"], {})
        who = f"{pl.get('gameName')}#{pl.get('tagLine')}"
        print(f"    {who:<26} champ={p.get('championId'):<4} items={items} augments={augs}")

    first = detail.get("participants", [{}])[0]
    print("\n[4] Stat fields available per participant:")
    print("    " + ", ".join(sorted(first.get("stats", {}).keys())))


if __name__ == "__main__":
    main()
