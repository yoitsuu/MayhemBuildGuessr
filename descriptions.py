"""
Descriptions for the hover popups: items, summoner spells, and augments.

- Items and spells: the client's own data has a description with light HTML-ish
  markup (<stats>, <br>, ...); clean_client_markup() turns it into plain text.
- Mayhem augments: the client's augment list has names but no descriptions, so
  they come from the League of Legends Wiki's data module
  (Module:MayhemAugmentData/data, CC BY-SA), matched by augment name.
"""

import html
import json
import re
import time
import urllib.request
from pathlib import Path

WIKI_AUGMENTS_URL = ("https://wiki.leagueoflegends.com/en-us/"
                     "Module:MayhemAugmentData/data?action=raw")
CACHE_TTL = 24 * 3600


# --------------------------------------------------------------------------- #
# Client markup (items, spells)
# --------------------------------------------------------------------------- #

def clean_client_markup(text: str | None) -> str:
    if not text:
        return ""
    t = re.sub(r"<br\s*/?>", "\n", text, flags=re.I)
    t = re.sub(r"</?(li|p|stats|mainText|rules|flavorText)\b[^>]*>", "\n", t, flags=re.I)
    t = re.sub(r"<[^>]+>", "", t)                 # any other tag
    t = re.sub(r"\{\{[^{}]*\}\}", "", t)          # unresolved client placeholders
    t = re.sub(r"@[A-Za-z0-9_.*]+@", "?", t)      # unresolved @Variables@
    t = html.unescape(t)
    t = re.sub(r"[ \t]+", " ", t)
    t = re.sub(r" *\n *", "\n", t)
    t = re.sub(r" +([.,;:!?)])", r"\1", t)
    t = re.sub(r"\n{3,}", "\n\n", t)
    return t.strip()


# --------------------------------------------------------------------------- #
# Minimal Lua table parser (enough for wiki data modules)
# --------------------------------------------------------------------------- #

class _Lua:
    def __init__(self, src: str):
        self.s, self.i = src, 0

    def _ws(self):
        s = self.s
        while self.i < len(s):
            c = s[self.i]
            if c.isspace():
                self.i += 1
            elif s.startswith("--", self.i):
                m = re.match(r"--\[(=*)\[", s[self.i:])
                if m:                                       # block comment
                    end = s.find("]" + m.group(1) + "]", self.i + len(m.group(0)))
                    self.i = len(s) if end < 0 else end + len(m.group(1)) + 2
                else:                                       # line comment
                    nl = s.find("\n", self.i)
                    self.i = len(s) if nl < 0 else nl + 1
            else:
                break

    def _peek(self) -> str:
        self._ws()
        return self.s[self.i] if self.i < len(self.s) else ""

    def _expect(self, ch):
        if self._peek() != ch:
            raise ValueError(f"expected {ch!r} at {self.i}: {self.s[self.i:self.i + 30]!r}")
        self.i += 1

    def value(self):
        c = self._peek()
        if c == "{":
            return self.table()
        if c in "\"'":
            return self.short_string()
        if c == "[" and re.match(r"\[=*\[", self.s[self.i:]):
            return self.long_string()
        m = re.match(r"-?\d+(\.\d+)?([eE][-+]?\d+)?", self.s[self.i:])
        if m:
            self.i += len(m.group(0))
            return float(m.group(0)) if any(x in m.group(0) for x in ".eE") else int(m.group(0))
        m = re.match(r"[A-Za-z_][A-Za-z0-9_]*", self.s[self.i:])
        if m:
            self.i += len(m.group(0))
            return {"true": True, "false": False, "nil": None}.get(m.group(0), m.group(0))
        raise ValueError(f"unexpected {self.s[self.i:self.i + 30]!r}")

    def short_string(self) -> str:
        q = self.s[self.i]
        self.i += 1
        out = []
        esc = {"n": "\n", "t": "\t", "r": "", "\\": "\\", '"': '"', "'": "'", "\n": "\n"}
        while self.i < len(self.s):
            c = self.s[self.i]
            if c == "\\":
                nxt = self.s[self.i + 1]
                out.append(esc.get(nxt, nxt))
                self.i += 2
            elif c == q:
                self.i += 1
                return "".join(out)
            else:
                out.append(c)
                self.i += 1
        raise ValueError("unterminated string")

    def long_string(self) -> str:
        m = re.match(r"\[(=*)\[\n?", self.s[self.i:])
        close = "]" + m.group(1) + "]"
        start = self.i + len(m.group(0))
        end = self.s.find(close, start)
        self.i = end + len(close)
        return self.s[start:end]

    def table(self):
        self._expect("{")
        result, arr = {}, []
        while True:
            c = self._peek()
            if c == "}":
                self.i += 1
                break
            if c == "[" and not re.match(r"\[=*\[", self.s[self.i:]):
                self.i += 1
                key = self.value()
                self._expect("]")
                self._expect("=")
                result[key] = self.value()
            else:
                m = re.match(r"([A-Za-z_][A-Za-z0-9_]*)\s*=(?!=)", self.s[self.i:])
                if m:
                    self.i += len(m.group(0))
                    result[m.group(1)] = self.value()
                else:
                    arr.append(self.value())
            if self._peek() in ",;":
                self.i += 1
        return result if result or not arr else arr


def parse_lua_module(src: str):
    m = re.search(r"\breturn\b", src)
    if not m:
        raise ValueError("no 'return' in module")
    p = _Lua(src)
    p.i = m.end()
    return p.value()


# --------------------------------------------------------------------------- #
# Wiki markup -> plain text
# --------------------------------------------------------------------------- #

# Templates whose FIRST argument is the text to show ({{as|15% AP|ap}}).
# Everything else shows its LAST positional argument ({{bi|Dragon Soul|Dragon Souls}}).
_FIRST_ARG = {"as", "pp", "ap", "fd", "rd", "tt", "sbc", "cai", "nie", "ft", "g"}
# Link-style templates: {{tip|Target|shown text}} shows the last argument.
_LAST_ARG_LINKS = {"tip", "bi", "ii", "ci", "ai", "si", "sti", "ri", "csl", "uii", "iis"}


def _template(inner: str) -> str:
    parts = [p.strip() for p in inner.split("|")]
    name = parts[0].lower().replace("_", " ").strip()
    args = [p for p in parts[1:] if not re.match(r"^[A-Za-z_ ]+\s*=", p)]
    if name.startswith("#") or not args:
        return ""
    if name in _LAST_ARG_LINKS:
        return args[-1]
    if name in _FIRST_ARG:
        return args[0]
    return args[-1]


def clean_wiki_markup(text: str | None) -> str:
    if not text:
        return ""
    t = text
    for _ in range(10):                  # innermost templates first, until none left
        new = re.sub(r"\{\{([^{}]*)\}\}", lambda m: _template(m.group(1)), t)
        if new == t:
            break
        t = new
    t = re.sub(r"\[\[(?:[^\]|]*\|)?([^\]]*)\]\]", r"\1", t)     # [[Link|text]] -> text
    t = re.sub(r"\[https?://\S+\s+([^\]]+)\]", r"\1", t)         # [url text] -> text
    t = t.replace("'''", "").replace("''", "")
    t = re.sub(r"<br\s*/?>", "\n", t, flags=re.I)
    t = re.sub(r"<[^>]+>", "", t)
    t = html.unescape(t)
    t = re.sub(r"[ \t]+", " ", t)
    t = re.sub(r" *\n *", "\n", t)
    t = re.sub(r"^\s*[*:]+\s*", "• ", t, flags=re.M)             # wiki bullets
    t = re.sub(r" +([.,;:!?)])", r"\1", t)
    t = re.sub(r"\n{3,}", "\n\n", t)
    return t.strip()


def _norm(name: str) -> str:
    return re.sub(r"[^a-z0-9]", "", (name or "").casefold())


# --------------------------------------------------------------------------- #
# Fetch with a small on-disk cache
# --------------------------------------------------------------------------- #

def _cached_fetch(url: str, cache_file: Path, log) -> str | None:
    fresh = cache_file.exists() and time.time() - cache_file.stat().st_mtime < CACHE_TTL
    if not fresh:
        try:
            req = urllib.request.Request(url, headers={
                "User-Agent": "MayhemGuessingGame/0.1 (personal project)"})
            with urllib.request.urlopen(req, timeout=30) as r:
                text = r.read().decode("utf-8")
            cache_file.parent.mkdir(exist_ok=True)
            cache_file.write_text(text, encoding="utf-8")
            return text
        except Exception as e:
            if log:
                log.warning(f"  couldn't fetch augment descriptions ({e}); "
                            f"{'using cached copy' if cache_file.exists() else 'skipping'}")
    return cache_file.read_text(encoding="utf-8") if cache_file.exists() else None


def wiki_augment_descriptions(cache_dir: Path, log=None) -> dict[str, dict]:
    """{normalized augment name: {"desc": str, "tier": str}} from the wiki."""
    src = _cached_fetch(WIKI_AUGMENTS_URL, cache_dir / "wiki_mayhem_augments.lua", log)
    if not src:
        return {}
    try:
        data = parse_lua_module(src)
    except Exception as e:
        if log:
            log.warning(f"  couldn't parse the wiki augment data: {e}")
        return {}
    out = {}
    if isinstance(data, dict):
        for name, entry in data.items():
            if isinstance(entry, dict):
                desc = clean_wiki_markup(entry.get("description"))
                notes = clean_wiki_markup(entry.get("notes")) if entry.get("notes") else ""
                out[_norm(str(name))] = {"desc": desc, "notes": notes,
                                         "tier": entry.get("tier")}
    return out


def attach_augment_descriptions(augs: dict, cache_dir: Path, log=None) -> int:
    """Add "desc" to each augment in place, matched by name. Returns how many matched."""
    wiki = wiki_augment_descriptions(cache_dir, log)
    hits = 0
    for a in augs.values():
        w = wiki.get(_norm(a.get("name", "")))
        if w and w["desc"]:
            a["desc"] = w["desc"]
            hits += 1
    return hits


if __name__ == "__main__":
    # Quick check: python descriptions.py
    d = wiki_augment_descriptions(Path(__file__).resolve().parent / "cache_static")
    print(f"{len(d)} augment descriptions parsed from the wiki.")
    for k in list(d)[:3]:
        print(f"- {k}: {d[k]['desc'][:150]}")
