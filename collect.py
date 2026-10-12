#!/usr/bin/env python3
"""
Mayhem Guessing Game: collector + exporter.

Reads your friends' recent ARAM Mayhem games from the League client's local
API (LCU) and stores them in a local SQLite database. The client only exposes
each player's last ~20 games, so this is meant to run regularly and build the
history up over time.

Usage:
  python collect.py               run forever: collect every INTERVAL minutes
                                  while the League client is open
  python collect.py --once        collect once (client must be open), then export
  python collect.py --export      only rebuild docs/data.js from the database
  python collect.py --find-static check which static-data sources are reachable
  python collect.py --add "Name#TAG"  add a player (checked against the client)
  add --push to git-commit and push docs/data.js after each export

Env vars:
  INTERVAL_MIN=30     minutes between collections in loop mode
  MIN_MINUTES=10      games shorter than this are left out of the export
  LOL_LOCKFILE=...    path to the client's lockfile if League is installed
                      somewhere unusual

Standard library only. Read-only: nothing here touches the game itself.
"""

import base64
import json
import logging
import os
import sqlite3
import ssl
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from descriptions import attach_augment_descriptions, clean_client_markup

HERE = Path(__file__).resolve().parent
DB_PATH = HERE / "mayhem.db"
PLAYERS_FILE = HERE / "players.txt"
OUT_FILE = HERE / "docs" / "data.js"
LOG_FILE = HERE / "collect.log"
CACHE_STATIC = HERE / "cache_static"

MAYHEM_QUEUE = 2400
INTERVAL_MIN = float(os.environ.get("INTERVAL_MIN", "30"))
MIN_SECONDS = int(float(os.environ.get("MIN_MINUTES", "10")) * 60)

LOCKFILE_CANDIDATES = [
    os.environ.get("LOL_LOCKFILE", ""),
    r"C:\Riot Games\League of Legends\lockfile",
    r"D:\Riot Games\League of Legends\lockfile",
    r"E:\Riot Games\League of Legends\lockfile",
    "/Applications/League of Legends.app/Contents/LoL/lockfile",
]

CDRAGON = "https://raw.communitydragon.org/latest"
CD_GAMEDATA = f"{CDRAGON}/plugins/rcp-be-lol-game-data/global/default"
LCU_GAMEDATA = "/lol-game-data/assets"

# Where Mayhem augment names might live. The first source that actually
# contains the augment IDs seen in our games wins. Mayhem's internal name is
# "kiwi"; Arena's is "cherry". Paths are best guesses; --find-static reports.
AUGMENT_SOURCES = [
    ("lcu", "/lol-game-data/assets/v1/kiwi-augments.json"),
    ("lcu", "/lol-game-data/assets/v1/aram-augments.json"),
    ("lcu", "/lol-game-data/assets/v1/augments.json"),
    ("lcu", "/lol-game-data/assets/v1/cherry-augments.json"),
    ("web", f"{CD_GAMEDATA}/v1/kiwi-augments.json"),
    ("web", f"{CD_GAMEDATA}/v1/aram-augments.json"),
    ("web", f"{CDRAGON}/cdragon/kiwi/en_us.json"),
    ("web", f"{CD_GAMEDATA}/v1/cherry-augments.json"),
    ("web", f"{CDRAGON}/cdragon/arena/en_us.json"),
]

log = logging.getLogger("mayhem")


def setup_logging():
    log.setLevel(logging.INFO)
    fmt = logging.Formatter("%(asctime)s  %(message)s", "%Y-%m-%d %H:%M:%S")
    fh = logging.FileHandler(LOG_FILE, encoding="utf-8")
    fh.setFormatter(fmt)
    log.addHandler(fh)
    if sys.stdout is not None:            # pythonw has no console
        sh = logging.StreamHandler(sys.stdout)
        sh.setFormatter(fmt)
        log.addHandler(sh)


# --------------------------------------------------------------------------- #
# LCU connection
# --------------------------------------------------------------------------- #

# The client serves HTTPS on 127.0.0.1 with a Riot self-signed certificate,
# so verification is skipped for this localhost-only connection.
_LOCAL_SSL = ssl.create_default_context()
_LOCAL_SSL.check_hostname = False
_LOCAL_SSL.verify_mode = ssl.CERT_NONE


class ClientUnavailable(Exception):
    pass


def find_lockfile(argv) -> Path | None:
    if "--lockfile" in argv:
        return Path(argv[argv.index("--lockfile") + 1])
    for c in LOCKFILE_CANDIDATES:
        if c and Path(c).exists():
            return Path(c)
    return None


class LCU:
    def __init__(self, lockfile: Path):
        try:
            _, _, port, password, proto = lockfile.read_text().strip().split(":")
        except (OSError, ValueError) as e:
            raise ClientUnavailable(f"can't read lockfile: {e}")
        self.base = f"{proto}://127.0.0.1:{port}"
        self.auth = base64.b64encode(f"riot:{password}".encode()).decode()

    def get(self, path: str, params: dict | None = None):
        url = self.base + path
        if params:
            url += "?" + urllib.parse.urlencode(params)
        req = urllib.request.Request(url, headers={
            "Authorization": f"Basic {self.auth}", "Accept": "application/json"})
        try:
            with urllib.request.urlopen(req, context=_LOCAL_SSL, timeout=20) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            body = e.read().decode(errors="replace")[:200]
            raise RuntimeError(f"HTTP {e.code} on {path}: {body}") from None
        except (urllib.error.URLError, ConnectionError, TimeoutError) as e:
            raise ClientUnavailable(str(e)) from None


def web_get(url: str):
    req = urllib.request.Request(url, headers={
        "User-Agent": "MayhemGuessingGame/0.1 (personal project)"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


# --------------------------------------------------------------------------- #
# Storage
# --------------------------------------------------------------------------- #

def open_db() -> sqlite3.Connection:
    db = sqlite3.connect(DB_PATH)
    db.executescript("""
        CREATE TABLE IF NOT EXISTS games (
            game_id    INTEGER PRIMARY KEY,
            created    INTEGER,          -- unix ms
            duration   INTEGER,          -- seconds
            queue      INTEGER,
            raw        TEXT,             -- full game JSON from the client
            fetched_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS players (
            riot_id TEXT PRIMARY KEY,
            puuid   TEXT
        );
    """)
    return db


def read_players() -> list[str]:
    if not PLAYERS_FILE.exists():
        sys.exit(f"Missing {PLAYERS_FILE.name}: add one Riot ID (Name#TAG) per line.")
    ids = []
    for line in PLAYERS_FILE.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "#" in line:
            ids.append(line)
    return ids


# --------------------------------------------------------------------------- #
# Collection
# --------------------------------------------------------------------------- #

def resolve_puuid(lcu: LCU, db, riot_id: str) -> str | None:
    row = db.execute("SELECT puuid FROM players WHERE riot_id=?", (riot_id,)).fetchone()
    if row and row[0]:
        return row[0]
    name, tag = riot_id.rsplit("#", 1)
    try:
        s = lcu.get("/lol-summoner/v1/alias/lookup", {"gameName": name, "tagLine": tag})
    except RuntimeError as e:
        log.warning(f"  can't resolve {riot_id}: {e}")
        return None
    puuid = s.get("puuid")
    if puuid:
        db.execute("INSERT OR REPLACE INTO players VALUES (?, ?)", (riot_id, puuid))
        db.commit()
    return puuid


def collect_once(lcu: LCU, db) -> int:
    """Pull each friend's recent Mayhem games; store the ones we don't have."""
    known = {r[0] for r in db.execute("SELECT game_id FROM games")}
    added = 0
    for riot_id in read_players():
        puuid = resolve_puuid(lcu, db, riot_id)
        if not puuid:
            continue
        try:
            data = lcu.get(f"/lol-match-history/v1/products/lol/{puuid}/matches",
                           {"begIndex": 0, "endIndex": 20})
        except RuntimeError as e:
            log.warning(f"  history failed for {riot_id}: {e}")
            continue
        recent = data.get("games", {}).get("games", [])
        mayhem = [g for g in recent if g.get("queueId") == MAYHEM_QUEUE]
        new_ids = [g["gameId"] for g in mayhem if g["gameId"] not in known]
        for gid in new_ids:
            try:
                game = lcu.get(f"/lol-match-history/v1/games/{gid}")
            except RuntimeError as e:
                log.warning(f"  game {gid} failed: {e}")
                continue
            db.execute(
                "INSERT OR IGNORE INTO games VALUES (?, ?, ?, ?, ?, ?)",
                (gid, game.get("gameCreation"), game.get("gameDuration"),
                 game.get("queueId"), json.dumps(game), int(time.time())))
            known.add(gid)
            added += 1
            time.sleep(0.1)
        db.commit()
        log.info(f"  {riot_id:<24} {len(recent):>2} recent, {len(mayhem):>2} Mayhem, "
                 f"{len(new_ids):>2} new")
    total = db.execute("SELECT COUNT(*) FROM games").fetchone()[0]
    log.info(f"Collected {added} new game(s); {total} Mayhem games stored.")
    return added


# --------------------------------------------------------------------------- #
# Static data (names + icons)
# --------------------------------------------------------------------------- #

def asset_url(path: str | None) -> str | None:
    """Turn a client asset path into a public CommunityDragon URL."""
    if not path:
        return None
    if path.startswith("http"):
        return path
    if path.startswith(LCU_GAMEDATA + "/"):
        return f"{CD_GAMEDATA}/{path[len(LCU_GAMEDATA) + 1:].lower()}"
    if path.startswith("assets/"):
        return f"{CDRAGON}/game/{path.lower()}"
    return None


def fetch_static(lcu: LCU | None, rel: str):
    """rel like 'v1/items.json': try the running client, then CommunityDragon."""
    if lcu:
        try:
            return lcu.get(f"{LCU_GAMEDATA}/{rel}")
        except (RuntimeError, ClientUnavailable):
            pass
    try:
        return web_get(f"{CD_GAMEDATA}/{rel}")
    except Exception as e:
        log.warning(f"  couldn't load {rel}: {e}")
        return None


def normalize_augments(data) -> dict:
    """Accept the shapes the various augment files use; return {id: {...}}."""
    if isinstance(data, dict):
        data = data.get("augments") or list(data.values())
    out = {}
    for a in data or []:
        if not isinstance(a, dict) or "id" not in a:
            continue
        name = a.get("name") or a.get("nameTRA") or a.get("displayName")
        icon = (a.get("iconLarge") or a.get("augmentLargeIconPath")
                or a.get("iconPath") or a.get("iconSmall")
                or a.get("augmentSmallIconPath"))
        out[int(a["id"])] = {
            "name": name or f"Augment {a['id']}",
            "icon": asset_url(icon),
            "rarity": a.get("rarity"),
        }
    return out


def load_augments(lcu: LCU | None, wanted: set[int], report=False) -> dict:
    best, best_hits = {}, 0
    for kind, src in AUGMENT_SOURCES:
        try:
            if kind == "lcu":
                if not lcu:
                    continue
                data = lcu.get(src)
            else:
                data = web_get(src)
        except Exception as e:
            if report:
                print(f"  augments  {kind:<3} {src}\n            -> unavailable ({str(e)[:60]})")
            continue
        aug = normalize_augments(data)
        hits = len(wanted & aug.keys())
        if report:
            print(f"  augments  {kind:<3} {src}\n            -> {len(aug)} entries, "
                  f"covers {hits}/{len(wanted)} augments in our games")
        if hits > best_hits:
            best, best_hits = aug, hits
        if wanted and hits == len(wanted):
            break
    return best


# --------------------------------------------------------------------------- #
# Export
# --------------------------------------------------------------------------- #

def build_rounds(db) -> tuple[list[dict], list[str]]:
    players = read_players()
    by_puuid = {p: r for r, p in db.execute("SELECT riot_id, puuid FROM players")
                if r in players and p}
    rounds = []
    for gid, created, duration, raw, fetched in db.execute(
            "SELECT game_id, created, duration, raw, fetched_at FROM games ORDER BY created"):
        if (duration or 0) < MIN_SECONDS:
            continue
        game = json.loads(raw)
        ident = {pi["participantId"]: pi.get("player", {})
                 for pi in game.get("participantIdentities", [])}
        parts = game.get("participants", [])
        # Team of each participant; fall back to 1-5 vs 6-10 if teamId is absent
        team = {p["participantId"]: p.get("teamId") or (100 if p["participantId"] <= 5 else 200)
                for p in parts}
        for p in parts:
            puuid = ident.get(p["participantId"], {}).get("puuid")
            if puuid not in by_puuid:         # only friends -- never strangers
                continue
            st = p.get("stats", {})
            if st.get("gameEndedInEarlySurrender"):
                continue
            items = [st.get(f"item{i}") for i in range(6)]
            items = [i for i in items if i]
            if not items:
                continue
            augs = [st.get(f"playerAugment{i}") for i in range(1, 7)]
            rounds.append({
                "g": gid,
                "t": created,
                "f": (fetched or 0) * 1000,   # when we collected it (daily pool uses this)
                "dur": duration,
                "p": by_puuid[puuid],
                "c": p.get("championId"),
                "items": items,
                "aug": [a for a in augs if a],
                "spells": [p.get("spell1Id"), p.get("spell2Id")],
                "kda": [st.get("kills", 0), st.get("deaths", 0), st.get("assists", 0)],
                "win": bool(st.get("win")),
                "lvl": st.get("champLevel"),
                "dmg": st.get("totalDamageDealtToChampions"),
                "foes": [q.get("championId") for q in parts
                         if team[q["participantId"]] != team[p["participantId"]]],
            })
    return rounds, players


def export(lcu: LCU | None) -> Path:
    db = open_db()
    rounds, players = build_rounds(db)
    used_champs = {r["c"] for r in rounds} | {c for r in rounds for c in r["foes"]}
    used_items = {i for r in rounds for i in r["items"]}
    used_spells = {s for r in rounds for s in r["spells"] if s}
    used_augs = {a for r in rounds for a in r["aug"]}

    # Every champion, not just ones in our games: "Which champ?" mode offers
    # them all in its picker. (~170 entries, a few KB.)
    # The client also lists mode-specific copies of champions with big IDs
    # (e.g. 60001 "Jade_Annie"); skip those unless one actually shows up in a game.
    champs, by_name = {}, {}
    for c in sorted(fetch_static(lcu, "v1/champion-summary.json") or [],
                    key=lambda c: c.get("id") or 0):
        cid = c.get("id") or 0
        if cid <= 0 or (cid >= 10000 and cid not in used_champs):
            continue
        if c.get("name") in by_name and cid not in used_champs:
            continue                                   # duplicate name, unused
        champs[cid] = {"name": c.get("name"), "alias": c.get("alias"),
                       "icon": asset_url(c.get("squarePortraitPath")),
                       "roles": c.get("roles") or []}
        by_name.setdefault(c.get("name"), cid)
    items = {}
    for it in fetch_static(lcu, "v1/items.json") or []:
        if it.get("id") in used_items:
            items[it["id"]] = {"name": it.get("name"), "icon": asset_url(it.get("iconPath")),
                               "desc": clean_client_markup(it.get("description")),
                               "cost": it.get("priceTotal")}
    spells = {}
    for s in fetch_static(lcu, "v1/summoner-spells.json") or []:
        if s.get("id") in used_spells:
            spells[s["id"]] = {"name": s.get("name"), "icon": asset_url(s.get("iconPath")),
                               "desc": clean_client_markup(s.get("description"))}
    augs = {k: v for k, v in load_augments(lcu, used_augs).items() if k in used_augs}
    described = attach_augment_descriptions(augs, CACHE_STATIC, log)
    if augs and described < len(augs):
        log.info(f"  augment descriptions found for {described}/{len(augs)}")

    missing = {"items": len(used_items - items.keys()),
               "augments": len(used_augs - augs.keys()),
               "champions": len(used_champs - champs.keys())}
    payload = {
        "generated": int(time.time() * 1000),
        "players": players,
        "rounds": rounds,
        "champions": champs, "items": items, "spells": spells, "augments": augs,
    }
    OUT_FILE.parent.mkdir(exist_ok=True)
    OUT_FILE.write_text("window.MAYHEM_DATA = " + json.dumps(payload, separators=(",", ":"))
                        + ";\n", encoding="utf-8")
    log.info(f"Exported {len(rounds)} rounds from {len({r['g'] for r in rounds})} games "
             f"-> {OUT_FILE.relative_to(HERE)}")
    if any(missing.values()):
        log.info(f"  names/icons missing for: {missing} (shown as IDs on the page)")
    return OUT_FILE


def _git(*args, timeout=60):
    """Run git without ever prompting: in the background there is nobody to
    answer, so it fails fast and the failure gets logged instead of hanging."""
    env = {**os.environ, "GIT_TERMINAL_PROMPT": "0"}
    return subprocess.run(["git", *args], cwd=HERE, env=env, capture_output=True,
                          text=True, timeout=timeout,
                          creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))


def _pull_rebase() -> bool:
    """git pull --rebase that survives Windows' "touched but unchanged" files.

    If a file was rewritten with identical content, git's quick stat check calls
    the tree dirty, --autostash then finds nothing to stash and git dies with
    "Unexpected stash response". Refreshing the index first clears those false
    positives, and autostash is only used when there really are local edits."""
    _git("update-index", "-q", "--refresh")
    dirty = (_git("diff", "--quiet").returncode != 0
             or _git("diff", "--cached", "--quiet").returncode != 0)
    pull = _git("pull", "--rebase", *(["--autostash"] if dirty else []))
    if pull.returncode == 0:
        return True
    log.warning(f"git pull failed: {pull.stderr.strip()[:200]}")
    changed = _git("status", "--porcelain", "-uno").stdout.strip()
    if changed:
        log.warning(f"  local changes in the way: {' '.join(changed.split())[:200]}")
    _git("rebase", "--abort")
    return False


def git_pull() -> list[str]:
    """Pull changes made on GitHub (players.txt edits, code changes).
    Returns the files that changed, or [] if nothing did or the pull failed."""
    if not (HERE / ".git").exists():
        return []
    try:
        before = _git("rev-parse", "HEAD").stdout.strip()
        if not _pull_rebase():
            return []
        after = _git("rev-parse", "HEAD").stdout.strip()
        if before == after:
            return []
        changed = _git("diff", "--name-only", before, after).stdout.split()
        log.info(f"Pulled from GitHub: {', '.join(changed)}")
        code = [f for f in changed if f.endswith((".py", ".bat"))]
        if code:
            log.info("  Code changed; restart the collector (stop, then start) "
                     "to use the new version.")
        return changed
    except subprocess.TimeoutExpired:
        log.warning("git pull timed out")
    except FileNotFoundError:
        log.warning("git isn't installed or isn't on PATH")
    return []


def git_push():
    """Commit docs/data.js and push it."""
    if not (HERE / ".git").exists():
        log.warning("--push: not a git repository, skipping")
        return
    git = _git
    try:
        rel = str(OUT_FILE.relative_to(HERE)).replace("\\", "/")
        git("add", rel)
        if git("diff", "--cached", "--quiet").returncode != 0:
            git("commit", "-m", "Update Mayhem games", "--", rel)
        # Pick up anything pushed from elsewhere since the start of this cycle.
        if not _pull_rebase():
            return
        r = git("push")
        log.info("Pushed to GitHub." if r.returncode == 0
                 else f"git push failed: {r.stderr.strip()[:200]}")
    except subprocess.TimeoutExpired:
        log.warning("git timed out (credentials not cached yet? push once by hand)")
    except FileNotFoundError:
        log.warning("git isn't installed or isn't on PATH")


def add_player(argv):
    riot_id = argv[argv.index("--add") + 1].strip() if len(argv) > argv.index("--add") + 1 else ""
    if "#" not in riot_id:
        sys.exit('Usage: python collect.py --add "Name#TAG"')
    if riot_id.lower() in (p.lower() for p in read_players()):
        sys.exit(f"{riot_id} is already in {PLAYERS_FILE.name}.")
    lcu = connect(argv)
    if lcu:
        db = open_db()
        if not resolve_puuid(lcu, db, riot_id):
            sys.exit(f"The client couldn't find {riot_id}. Check the spelling and tag.")
        print(f"Found {riot_id}.")
    else:
        print("League client isn't open, so the name wasn't checked; adding anyway.")
    text = PLAYERS_FILE.read_text(encoding="utf-8")
    PLAYERS_FILE.write_text(text.rstrip("\n") + f"\n{riot_id}\n", encoding="utf-8")
    print(f"Added to {PLAYERS_FILE.name}. Their recent games are picked up on the next "
          f"collection (or run: python collect.py --once).")


# Only one collector at a time: holding this localhost port is the lock.
_LOCK_PORT = 47213
PID_FILE = HERE / "collector.pid"


def acquire_single_instance():
    import socket
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.bind(("127.0.0.1", _LOCK_PORT))
    except OSError:
        return None
    PID_FILE.write_text(str(os.getpid()))
    return s


# --------------------------------------------------------------------------- #
# Entry points
# --------------------------------------------------------------------------- #

def connect(argv) -> LCU | None:
    lf = find_lockfile(argv)
    if not lf or not lf.exists():
        return None
    try:
        lcu = LCU(lf)
        lcu.get("/lol-summoner/v1/current-summoner")   # is it really up?
        return lcu
    except (ClientUnavailable, RuntimeError):
        return None


def run_cycle(argv) -> bool:
    lcu = connect(argv)
    if not lcu:
        return False
    # With --push, start each cycle by pulling, so edits made on GitHub
    # (like a new name in players.txt) apply to this very collection.
    pulled = git_pull() if "--push" in argv else []
    db = open_db()
    log.info("League client found; collecting...")
    try:
        added = collect_once(lcu, db)
    except ClientUnavailable:
        log.info("Client closed mid-collection; will retry next cycle.")
        return False
    if added or not OUT_FILE.exists() or "players.txt" in pulled:
        export(lcu)
        if "--push" in argv:
            git_push()
    return True


def find_static(argv):
    lcu = connect(argv)
    print(f"League client: {'connected' if lcu else 'not running (web sources only)'}")
    db = open_db()
    rounds, _ = build_rounds(db)
    for rel in ["v1/champion-summary.json", "v1/items.json", "v1/summoner-spells.json"]:
        data = fetch_static(lcu, rel)
        print(f"  {rel:<28} -> {len(data) if data else 'FAILED'} entries")
    wanted = {a for r in rounds for a in r["aug"]}
    used_items = {i for r in rounds for i in r["items"]}
    items = {i["id"] for i in fetch_static(lcu, "v1/items.json") or []}
    print(f"  items used in our games: {len(used_items)}, "
          f"missing from items.json: {sorted(used_items - items)[:20]}")
    load_augments(lcu, wanted, report=True)


def main():
    argv = sys.argv[1:]
    setup_logging()
    if "--add" in argv:
        add_player(argv)
        return
    if "--find-static" in argv:
        find_static(argv)
        return
    if "--export" in argv:
        export(connect(argv))
        if "--push" in argv:
            git_push()
        return
    if "--once" in argv:
        if not run_cycle(argv):
            sys.exit("League client isn't running (or the lockfile wasn't found).")
        return

    lock = acquire_single_instance()
    if not lock:
        log.info("Another collector is already running; exiting.")
        return
    log.info(f"Collector started (pid {os.getpid()}): every {INTERVAL_MIN:g} min while "
             f"the client is open{', pushing to GitHub' if '--push' in argv else ''}.")
    while True:
        try:
            ran = run_cycle(argv)
        except Exception as e:                     # keep the loop alive
            log.exception(f"Unexpected error: {e}")
            ran = False
        # Check back sooner when the client is closed, so we catch it opening.
        time.sleep(INTERVAL_MIN * 60 if ran else 120)


if __name__ == "__main__":
    main()
