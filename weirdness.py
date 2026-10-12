"""
Weirdness: how unusual a friend's build is compared with how *other players*
in the same Mayhem lobbies built that champion.

Baseline: every non-friend participant in the stored games (strangers in your
lobbies). Only aggregate counts and the resulting scores leave this machine;
no stranger's name or individual build is exported.

For each completed item in a build, estimate how often players put it on that
champion, smoothing toward the champion's class and then toward all players
when a champion has few recorded builds:

    p(item | class) = (n_class + K_CLASS * p_global) / (N_class + K_CLASS)
    p(item | champ) = (n_champ + K_CHAMP * p_class)  / (N_champ + K_CHAMP)

The build's raw score is the mean surprisal (-log2 p) of its 3 most
surprising items. The final 0-100 score is a percentile against strangers'
builds (each scored leave-one-out), i.e. "weirder than X% of lobby builds".
Components, consumables and trinkets are ignored.
"""

import math
from bisect import bisect_left
from collections import Counter, defaultdict

K_CHAMP = 5
K_CLASS = 10
TOP = 3
MIN_REFERENCE = 50       # fewer stranger builds than this -> rank against everyone


def item_filter(items_json):
    """Return a function telling whether an item counts as a 'real' build item."""
    meta = {it.get("id"): it for it in (items_json or [])}

    def ok(item_id):
        it = meta.get(item_id)
        if it is None:
            return True                                  # unknown: keep it
        cats = set(it.get("categories") or [])
        price = it.get("priceTotal") or 0
        if cats & {"Consumable", "Trinket"}:
            return False
        if it.get("to") and price < 2500:                # builds into something: component
            return False
        return True
    return ok


def compute(rounds, strangers, class_of, ok):
    """Add r["w"] to each friend round. strangers: list of (champion_id, items)."""
    def clean(items):
        return {i for i in items if i and ok(i)}

    ch_n, cl_n = Counter(), Counter()
    ch_i, cl_i, g_i = defaultdict(Counter), defaultdict(Counter), Counter()
    base = [(c, clean(items)) for c, items in strangers]
    base = [(c, its) for c, its in base if its]
    for c, its in base:
        cls = class_of(c)
        ch_n[c] += 1
        cl_n[cls] += 1
        for i in its:
            ch_i[c][i] += 1
            cl_i[cls][i] += 1
            g_i[i] += 1
    g_n = len(base)

    def surprisals(c, its, loo=False):
        cls = class_of(c)
        out = []
        sub = 1 if loo else 0                            # leave this build out of the counts
        Nc, Ncl = ch_n[c] - sub, cl_n[cls] - sub
        for i in its:
            nc = ch_i[c][i] - sub
            ncl = cl_i[cls][i] - sub
            ng = g_i[i] - sub
            pg = (ng + 0.5) / (g_n - sub + 1)
            pcl = (ncl + K_CLASS * pg) / (Ncl + K_CLASS)
            pc = (nc + K_CHAMP * pcl) / (Nc + K_CHAMP)
            out.append((-math.log2(max(pc, 1e-6)), i))
        return sorted(out, reverse=True)

    def raw(s):
        top = s[:TOP]
        return sum(x for x, _ in top) / len(top) if top else 0.0

    ref = sorted(raw(surprisals(c, its, loo=True)) for c, its in base)
    friend_raw = []
    for r in rounds:
        s = surprisals(r["c"], clean(r["items"]))
        friend_raw.append((r, s, raw(s)))
    if len(ref) < MIN_REFERENCE:                         # too few strangers yet
        ref = sorted(ref + [x for _, _, x in friend_raw])

    for r, s, x in friend_raw:
        score = round(100 * bisect_left(ref, x) / max(1, len(ref))) if ref else 0
        w = {"s": min(score, 100)}
        if s:
            item = s[0][1]
            cls = class_of(r["c"])
            w.update({"it": item, "n": ch_i[r["c"]][item], "N": ch_n[r["c"]],
                      "cn": cl_i[cls][item], "cN": cl_n[cls], "cls": cls})
        r["w"] = w
    return {"baseline_builds": g_n, "reference": "strangers" if len(base) >= MIN_REFERENCE else "everyone"}
