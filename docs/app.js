// Whose Build? -- game logic. Data comes from data.js (window.MAYHEM_DATA),
// written by collect.py. Everything here runs in the browser; no server.
(() => {
  "use strict";
  const D = window.MAYHEM_DATA;
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const main = $("#main");

  if (!D || !D.rounds || !D.rounds.length) {
    main.innerHTML = `<div class="card empty-state">No games yet.<br><br>
      Run <code>python collect.py --once</code> with the League client open,
      then reload this page.</div>`;
    ["#tabs", "#playbar"].forEach((s) => $(s).style.display = "none");
    return;
  }

  // ======================================================================
  // Helpers
  // ======================================================================
  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  const look = (table, id, kind = "") =>
    (D[table] && D[table][id]) || { name: `${kind} ${id}`.trim(), icon: null };
  const iconEl = (o) => o.icon
    ? `<img src="${esc(o.icon)}" alt="${esc(o.name)}" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'ph'}))">`
    : `<span class="ph"></span>`;
  const portrait = (c) => `<div class="portrait">${c && c.icon
    ? `<img src="${esc(c.icon)}" alt="" onerror="this.replaceWith('?')">` : "?"}</div>`;
  const cap = (s) => s ? s[0].toUpperCase() + s.slice(1) : s;
  // A player's name that opens their profile panel
  const plink = (rid, text) => `<span class="plink" role="button" tabindex="0" data-profile="${esc(rid)}">${esc(text || String(rid).split("#")[0])}</span>`;
  const short = (rid) => String(rid).split("#")[0];
  const norm = (x) => String(x || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const fmtDate = (t) => new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const mins = (r) => Math.round(r.dur / 60);
  const keyOf = (r) => r.g + "|" + r.p;
  const rolesOf = (c) => (look("champions", c).roles || []).map(cap).join(" · ") || "Unknown class";
  const pick = (arr, rnd = Math.random) => arr[Math.floor(rnd() * arr.length)];
  function shuffle(arr, rnd = Math.random) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  }
  const hoverable = matchMedia("(hover: hover)").matches;

  const store = {
    get(k, d) { try { const v = localStorage.getItem("whosebuild." + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem("whosebuild." + k, JSON.stringify(v)); } catch {} },
  };

  function toast(msg) {
    const t = Object.assign(document.createElement("div"), { className: "toast", textContent: msg });
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 1800);
  }

  // ======================================================================
  // Weirdness: how unusual a build is compared with the group's other builds
  // on champions of the same class. For each item, estimate how often builds
  // of that class include it (smoothed toward the item's overall rate), take
  // its surprisal, average the 3 most surprising items, then rank all builds
  // 0-100 so the score reads as a percentile.
  // ======================================================================
  const W = (() => {
    const K = 5;                                    // smoothing strength
    const cls = (r) => (look("champions", r.c).roles || [])[0] || "other";
    const byCls = {}, itemCls = {}, itemAll = {};
    for (const r of D.rounds) {
      const c = cls(r);
      byCls[c] = (byCls[c] || 0) + 1;
      for (const it of new Set(r.items)) {
        (itemCls[c] ||= {})[it] = (itemCls[c][it] || 0) + 1;
        itemAll[it] = (itemAll[it] || 0) + 1;
      }
    }
    const N = D.rounds.length;
    const raw = new Map();
    for (const r of D.rounds) {
      const c = cls(r), Nc = byCls[c];
      const sur = [...new Set(r.items)].map((it) => {
        const n = itemCls[c][it] || 0;
        const pg = (itemAll[it] || 0) / N;
        const p = (n + K * pg) / (Nc + K);
        return { it, n, s: -Math.log2(Math.max(p, 1e-6)) };
      }).sort((a, b) => b.s - a.s);
      const top = sur.slice(0, 3);
      const val = top.reduce((t, x) => t + x.s, 0) / Math.max(1, top.length);
      raw.set(keyOf(r), { val, rare: sur[0], cls: c, Nc });
    }
    const sorted = [...raw.values()].map((x) => x.val).sort((a, b) => a - b);
    const rank = (v) => {                          // share of builds strictly less weird
      let lo = 0, hi = sorted.length;
      while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m] < v) lo = m + 1; else hi = m; }
      return lo;
    };
    const out = new Map();
    for (const [k, x] of raw) {
      out.set(k, { score: Math.round(100 * rank(x.val) / Math.max(1, sorted.length - 1)),
                   item: x.rare && x.rare.it, n: x.rare ? x.rare.n : 0, Nc: x.Nc, cls: x.cls });
    }
    return out;
  })();

  // Exported scores (vs. other players in your lobbies) when available;
  // otherwise the in-browser estimate above.
  const EXTERNAL = D.rounds.some((r) => r.w);
  function wOf(r) {
    if (r.w) return { score: r.w.s, item: r.w.it, n: r.w.n, N: r.w.N, cn: r.w.cn, cN: r.w.cN, cls: r.w.cls, ext: true, c: r.c };
    const w = W.get(keyOf(r));
    return w && { ...w, c: r.c };
  }
  function weirdReason(w) {
    if (!w || !w.item) return "";
    const item = look("items", w.item, "Item").name;
    const c = cap(w.cls);
    if (w.ext) {
      const champ = look("champions", w.c, "Champion").name;
      if (w.N >= 5) return w.n === 0
        ? `no other ${champ} in your lobbies built ${item} (out of ${w.N})`
        : `${item} on ${champ}: ${w.n} of ${w.N} other ${champ} builds in your lobbies`;
      return w.cn === 0
        ? `no ${c} build from other players in your lobbies had ${item}`
        : `${item} is in ${Math.round(100 * w.cn / Math.max(1, w.cN))}% of ${c} builds in your lobbies`;
    }
    return w.n <= 1
      ? `the only ${c} build with ${item} (out of ${w.Nc})`
      : `${item} shows up in ${w.n} of ${w.Nc} ${c} builds`;
  }
  function weirdLine(r) {
    const w = wOf(r);
    if (!w) return "";
    return `<div class="weird"><span class="w-score">Weirdness ${w.score}</span><span>${esc(weirdReason(w))}</span></div>`;
  }

  // ======================================================================
  // Settings (Play tab)
  // ======================================================================
  const players = D.players;
  let selected = new Set(store.get("players", players).filter((p) => players.includes(p)));
  if (!selected.size) selected = new Set(players);
  const champStart = $("#champStart"), skipDays = $("#skipDays"), triesIn = $("#tries");
  champStart.value = store.get("champStart", "none");
  skipDays.value = String(store.get("skipDays", 0));
  triesIn.value = String(store.get("tries", 3));
  const maxTries = () => Math.min(10, Math.max(1, parseInt(triesIn.value, 10) || 3));

  function eligible() {
    const days = +skipDays.value, cutoff = Date.now() - days * 86400000;
    return D.rounds.filter((r) => selected.has(r.p) && (!days || r.t < cutoff));
  }
  function byPlayer(pool) {
    const m = {};
    pool.forEach((r) => (m[r.p] ||= []).push(r));
    return m;
  }
  // Guess options: selected players with at least one build in the pool.
  function choiceList() {
    const has = new Set(eligible().map((r) => r.p));
    return players.filter((p) => selected.has(p) && has.has(p));
  }

  function renderPlayers() {
    const count = (p) => D.rounds.filter((r) => r.p === p).length;
    $("#players").innerHTML = players.map((p) => `
      <label class="chip ${selected.has(p) ? "on" : ""}" title="${esc(p)}">
        <input type="checkbox" data-p="${esc(p)}" ${selected.has(p) ? "checked" : ""}>
        ${esc(short(p))} <span class="n">${count(p)}</span>
        <span class="pinfo" role="button" tabindex="0" data-profile="${esc(p)}" title="View profile">ⓘ</span>
      </label>`).join("");
    $$("#players input").forEach((cb) => cb.onchange = () => {
      cb.checked ? selected.add(cb.dataset.p) : selected.delete(cb.dataset.p);
      saveSettings();
    });
    const pool = eligible(), ps = new Set(pool.map((r) => r.p));
    $("#pool").textContent = `${pool.length} builds in the pool from ${ps.size} player${ps.size === 1 ? "" : "s"}.`;
  }
  function saveSettings() {
    triesIn.value = String(maxTries());
    store.set("players", [...selected]);
    store.set("champStart", champStart.value);
    store.set("skipDays", +skipDays.value);
    store.set("tries", maxTries());
    renderPlayers();
    MODES[mode].start();
  }
  $("#all").onclick = () => { selected = new Set(players); saveSettings(); };
  $("#none").onclick = () => { selected = new Set(); saveSettings(); };
  champStart.onchange = skipDays.onchange = triesIn.onchange = saveSettings;

  // ======================================================================
  // Scores (one per play mode; best streak remembered)
  // ======================================================================
  const bestKey = (m) => m === "player" ? "best" : "best." + m;
  const scores = {};
  for (const m of ["player", "champ", "odd", "win"])
    scores[m] = { right: 0, total: 0, streak: 0, best: store.get(bestKey(m), 0) };
  function record(ok) {
    const sc = scores[mode];
    sc.total++;
    if (ok) { sc.right++; sc.streak++; } else sc.streak = 0;
    if (sc.streak > sc.best) { sc.best = sc.streak; store.set(bestKey(mode), sc.best); }
    renderScore();
  }
  function renderScore() {
    if (view !== "play") { $("#score").innerHTML = ""; return; }
    const sc = scores[mode];
    $("#score").innerHTML = `<b>${sc.right}/${sc.total}</b><br>streak ${sc.streak} · best ${sc.best}`;
  }

  // ======================================================================
  // Shared round pieces: build card + hints
  // ======================================================================
  const seen = new Set();
  // 1) random player, 2) random game of theirs (prefer unseen ones)
  function pickRound(pool) {
    if (!pool.length) return null;
    const bp = byPlayer(pool);
    const p = pick(Object.keys(bp));
    let opts = bp[p].filter((r) => !seen.has(keyOf(r)));
    if (!opts.length) { bp[p].forEach((r) => seen.delete(keyOf(r))); opts = bp[p]; }
    const r = pick(opts);
    seen.add(keyOf(r));
    return r;
  }

  function itemsHtml(r) {
    const slots = [...r.items];
    while (slots.length < 6) slots.push(null);
    return `<div class="items">${slots.map((id) => {
      if (!id) return `<div class="item empty"><div class="icon"></div></div>`;
      const it = look("items", id, "Item");
      return `<div class="item" data-tip="items:${id}"><div class="icon" data-name="${esc(it.name)}">${it.icon
        ? `<img src="${esc(it.icon)}" alt="" loading="lazy" onerror="this.replaceWith(this.parentNode.dataset.name)">`
        : esc(it.name)}</div><div class="label">${esc(it.name)}</div></div>`;
    }).join("")}</div>`;
  }

  const HINT_LABELS = { cls: "Champion class", champ: "Champion", aug: "Augments",
    spells: "Summoner spells", kda: "KDA & result", kdaOnly: "KDA", foes: "Enemy team" };

  function hintsHtml(r, rev, allowed) {
    const btns = allowed.filter((k) => k !== "foes" || (r.foes && r.foes.length))
      .map((k) => `<button type="button" data-hint="${k}" ${rev[k] ? "disabled" : ""}>${HINT_LABELS[k]}</button>`).join("");
    let out = "";
    if (rev.aug) {
      const a = r.aug.map((id) => { const o = look("augments", id, "Augment");
        return `<span class="r-${esc(o.rarity || "")}" data-tip="augments:${id}">${iconEl(o)}${esc(o.name)}</span>`; }).join("");
      out += `<div class="hint"><h4>Augments</h4><div class="mini">${a || "<span>None recorded</span>"}</div></div>`;
    }
    if (rev.spells) {
      const s = r.spells.filter(Boolean).map((id) => { const o = look("spells", id, "Spell");
        return `<span data-tip="spells:${id}">${iconEl(o)}${esc(o.name)}</span>`; }).join("");
      out += `<div class="hint"><h4>Summoner spells</h4><div class="mini">${s}</div></div>`;
    }
    if (rev.kda || rev.kdaOnly) {
      const [k, d, a] = r.kda;
      out += `<div class="hint"><h4>${rev.kda ? "KDA &amp; result" : "KDA"}</h4><div class="mini">
        <span><b>${k} / ${d} / ${a}</b></span>
        ${rev.kda ? `<span style="color:${r.win ? "var(--good)" : "var(--bad)"}">${r.win ? "Victory" : "Defeat"}</span>` : ""}
        <span>${mins(r)} min</span>
        ${r.dmg ? `<span>${r.dmg.toLocaleString()} dmg to champs</span>` : ""}</div></div>`;
    }
    if (rev.foes) {
      const f = r.foes.map((id) => { const o = look("champions", id, "Champion");
        return `<span class="foe" title="${esc(o.name)}">${o.icon
          ? `<img src="${esc(o.icon)}" alt="${esc(o.name)}" loading="lazy" onerror="this.replaceWith(this.alt)">`
          : esc(o.name)}</span>`; }).join("");
      out += `<div class="hint"><h4>Enemy team</h4><div class="mini foes">${f}</div></div>`;
    }
    return `<div class="hints">${btns}</div><div class="hint-out">${out}</div>`;
  }

  // The main build card used by most modes.
  //   o.champ / o.cls: whether champion / class are visible
  //   o.byline: "Built by X" text, o.hints: allowed hint keys, o.rev: revealed
  //   o.title: header text when the champion is hidden, o.weird: show weirdness
  function buildCard(r, o) {
    const c = look("champions", r.c, "Champion");
    const head = o.champ
      ? `${portrait(c)}<div><div class="name">${esc(c.name)}</div><div class="sub">${esc(rolesOf(r.c))}</div></div>`
      : `${portrait(null)}<div><div class="name">${esc(o.title || "Hidden champion")}</div>
         <div class="sub">${o.cls ? esc(rolesOf(r.c)) : "Class hidden"}</div></div>`;
    return `<section class="card">
      ${o.byline ? `<div class="byline">Built by <b>${o.link ? plink(o.byline) : esc(short(o.byline))}</b></div>` : ""}
      <div class="champ">${head}</div>
      ${itemsHtml(r)}
      ${hintsHtml(r, o.rev, o.hints)}
      ${o.weird ? weirdLine(r) : ""}
    </section>`;
  }

  function wireHints(rev) {
    $$("#main [data-hint]").forEach((b) => b.onclick = () => { rev[b.dataset.hint] = true; rerender(); });
  }
  function wireNext(fn) {
    const n = $("#next");
    if (n) { n.onclick = fn; n.focus({ preventScroll: true }); }
  }
  const nextBtn = (label = "Next round") =>
    `<button type="button" class="primary" id="next">${label} ↵</button>`;

  function emptyCard(msg) {
    main.innerHTML = `<div class="card empty-state">${msg}</div>`;
  }

  // ======================================================================
  // Play mode 1: Whose build?
  // ======================================================================
  const P = { r: null, rev: {}, answered: null };
  const playerMode = {
    start() {
      renderScore();
      const choices = choiceList();
      if (choices.length < 2) { emptyCard(`Pick at least two players with games in <b>Players &amp; options</b>.`); $("#settings").open = true; return; }
      P.r = pickRound(eligible());
      if (!P.r) { emptyCard("No games match these settings."); return; }
      P.rev = { champ: champStart.value === "champ", cls: champStart.value !== "none" };
      P.answered = null;
      this.render();
    },
    render() {
      const r = P.r, choices = choiceList();
      const guesses = choices.map((p, i) => {
        const cls = !P.answered ? "" : p === r.p ? "correct" : p === P.answered ? "wrong" : "";
        return `<button type="button" data-guess="${esc(p)}" class="${cls}" ${P.answered ? "disabled" : ""}>
          <span class="k">${i < 9 ? i + 1 : ""}</span>${esc(short(p))}</button>`;
      }).join("");
      let verdict = "";
      if (P.answered) {
        const ok = P.answered === r.p;
        verdict = `<div class="verdict"><div>
          <div class="msg ${ok ? "good" : "bad"}">${ok ? `Correct! It was ${plink(r.p)}.` : `Nope, it was ${plink(r.p)}.`}</div>
          <div class="meta">${esc(look("champions", r.c, "Champion").name)} · ${fmtDate(r.t)} · ${mins(r)} min · ${r.win ? "won" : "lost"}</div>
          </div>${nextBtn()}</div>`;
      }
      main.innerHTML = buildCard(r, {
        champ: P.rev.champ, cls: P.rev.cls, rev: P.rev, weird: !!P.answered,
        byline: P.answered ? r.p : null, link: true,
        hints: [!P.rev.champ && !P.rev.cls && "cls", !P.rev.champ && "champ", "aug", "spells", "kda", "foes"].filter(Boolean),
      }) + `<section class="card"><p class="guess-title">Whose build is this?</p>
        <div class="guesses">${guesses}</div>${verdict}</section>`;
      wireHints(P.rev);
      $$("#main [data-guess]").forEach((b) => b.onclick = () => this.guess(b.dataset.guess));
      wireNext(() => this.start());
    },
    guess(p) {
      if (P.answered) return;
      P.answered = p; P.rev.champ = true;
      record(p === P.r.p);
      this.render();
    },
    key(e) {
      const n = parseInt(e.key, 10);
      if (!P.answered && n >= 1 && n <= 9) { const c = choiceList()[n - 1]; if (c) this.guess(c); }
      else if (P.answered && e.key === "Enter") this.start();
    },
  };

  // ======================================================================
  // Play mode 2: Which champ?
  // ======================================================================
  const CLASSES = ["fighter", "tank", "mage", "assassin", "marksman", "support"];
  const allChamps = () => Object.entries(D.champions || {})
    .map(([id, c]) => ({ id: +id, ...c })).filter((c) => c.id > 0 && c.name)
    .sort((a, b) => a.name.localeCompare(b.name));
  const C = { r: null, rev: {}, answered: null, wrong: [], q: "", cls: "" };
  const champMode = {
    start() {
      renderScore();
      if (!choiceList().length) { emptyCard(`Pick at least one player with games in <b>Players &amp; options</b>.`); $("#settings").open = true; return; }
      C.r = pickRound(eligible());
      if (!C.r) { emptyCard("No games match these settings."); return; }
      Object.assign(C, { rev: {}, answered: null, wrong: [], q: "", cls: "" });
      this.render();
      if (hoverable) { const s = $("#search"); if (s) s.focus(); }
    },
    render() {
      const r = C.r, done = !!C.answered, n = maxTries(), left = n - C.wrong.length;
      const pips = "●".repeat(Math.max(0, left)) + "○".repeat(Math.min(n, C.wrong.length));
      const wrongHtml = C.wrong.length ? `<div class="wrong-list">Wrong:
        ${C.wrong.map((id) => { const c = look("champions", id, "Champion"); return `<span class="w">${iconEl(c)}${esc(c.name)}</span>`; }).join("")}</div>` : "";
      const cards = allChamps().map((c) => {
        let cls = "ch";
        if (C.wrong.includes(c.id)) cls += " wrong";
        if (done && c.id === r.c) cls += " correct";
        return `<button type="button" class="${cls}" data-champ="${c.id}" data-k="${esc(norm(c.name) + " " + norm(c.alias))}"
          data-roles="${esc((c.roles || []).join(" "))}" title="${esc(c.name)}" ${done || C.wrong.includes(c.id) ? "disabled" : ""}>
          <span class="face">${c.icon ? `<img src="${esc(c.icon)}" alt="" loading="lazy" onerror="this.replaceWith('?')">` : "?"}</span>
          <span class="nm">${esc(c.name)}</span></button>`;
      }).join("");
      let verdict = "";
      if (done) {
        const ok = C.answered === "win";
        verdict = `<div class="verdict"><div>
          <div class="msg ${ok ? "good" : "bad"}">${ok ? `Correct! ${C.wrong.length ? `(${C.wrong.length + 1} guesses)` : "First try!"}`
            : `Out of guesses. It was ${esc(look("champions", r.c, "Champion").name)}.`}</div>
          <div class="meta">${esc(short(r.p))} · ${fmtDate(r.t)} · ${mins(r)} min · ${r.win ? "won" : "lost"}</div>
          </div>${nextBtn()}</div>`;
      }
      main.innerHTML = buildCard(r, {
        champ: done, cls: C.rev.cls || done, rev: C.rev, byline: r.p, link: done, title: "Which champion?", weird: done,
        hints: [!C.rev.cls && "cls", "aug", "spells", "kda", "foes"].filter(Boolean),
      }) + `<section class="card picker">
        <div class="pick-head"><p class="guess-title">Which champion was this?</p>
          <span class="tries">${done ? "" : `<span class="pips">${pips}</span>${left} of ${n} guess${n === 1 ? "" : "es"} left`}</span></div>
        ${wrongHtml}${verdict}
        ${done ? "" : `<input id="search" class="search" type="search" placeholder="Search champions…" autocomplete="off" value="${esc(C.q)}">
        <div class="classes"><button type="button" data-cls="" class="${C.cls ? "" : "on"}">All</button>
          ${CLASSES.map((k) => `<button type="button" data-cls="${k}" class="${C.cls === k ? "on" : ""}">${cap(k)}</button>`).join("")}</div>`}
        <div class="grid" id="grid">${cards}<div class="none" hidden>No champions match.</div></div>
      </section>`;
      wireHints(C.rev);
      this.wire();
      wireNext(() => this.start());
    },
    filter() {
      const q = norm(C.q);
      let shown = 0;
      $$("#grid .ch").forEach((b) => {
        const ok = (!q || b.dataset.k.split(" ").some((k) => k.includes(q)))
          && (!C.cls || b.dataset.roles.split(" ").includes(C.cls));
        b.hidden = !ok; if (ok) shown++;
      });
      const none = $("#grid .none"); if (none) none.hidden = shown > 0;
    },
    wire() {
      const s = $("#search");
      if (s) {
        s.oninput = () => { C.q = s.value; this.filter(); };
        s.onkeydown = (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            const b = $$("#grid .ch").find((x) => !x.hidden && !x.disabled);
            if (b && (C.q || C.cls)) this.guess(+b.dataset.champ);
          } else if (e.key === "Escape") { s.value = ""; C.q = ""; this.filter(); }
        };
      }
      $$("#main [data-cls]").forEach((b) => b.onclick = () => {
        C.cls = b.dataset.cls;
        $$("#main [data-cls]").forEach((x) => x.classList.toggle("on", x === b));
        this.filter();
      });
      $$("#grid .ch").forEach((b) => b.onclick = () => this.guess(+b.dataset.champ));
      if (!C.answered) this.filter();
    },
    guess(id) {
      if (C.answered || C.wrong.includes(id)) return;
      if (id === C.r.c) { C.answered = "win"; record(true); }
      else {
        C.wrong.push(id); C.q = "";
        if (C.wrong.length >= maxTries()) { C.answered = "lose"; record(false); }
      }
      this.render();
      const s = $("#search"); if (s && hoverable) s.focus();
    },
    key(e) {
      if (C.answered) { if (e.key === "Enter") this.start(); return; }
      if (e.key.length === 1 && /[a-z0-9' .&]/i.test(e.key)) {
        const s = $("#search");
        if (s) { e.preventDefault(); s.focus(); s.value += e.key; C.q = s.value; this.filter(); }
      }
    },
  };

  // ======================================================================
  // Play mode 3: Odd one out -- 4 builds, 3 by one friend, 1 by another
  // ======================================================================
  const O = { cards: [], odd: -1, a: null, b: null, picked: -1, rev: {} };
  const oddMode = {
    start() {
      renderScore();
      const bp = byPlayer(eligible());
      const mains = Object.keys(bp).filter((p) => bp[p].length >= 3);
      const all = Object.keys(bp);
      if (!mains.length || all.length < 2) {
        emptyCard(`Odd one out needs one player with at least 3 builds and another player with at least 1.<br>Include more players in <b>Players &amp; options</b>.`);
        return;
      }
      const a = pick(mains), b = pick(all.filter((p) => p !== a));
      // Prefer three different champions for the main player
      const pool = shuffle(bp[a]), three = [];
      for (const r of pool) if (three.length < 3 && !three.some((x) => x.c === r.c)) three.push(r);
      for (const r of pool) if (three.length < 3 && !three.includes(r)) three.push(r);
      const odd = pick(bp[b]);
      const cards = shuffle([...three, odd]);
      Object.assign(O, { cards, odd: cards.indexOf(odd), a, b, picked: -1, rev: {} });
      this.render();
    },
    render() {
      const done = O.picked >= 0;
      const cards = O.cards.map((r, i) => {
        const c = look("champions", r.c, "Champion");
        let cls = "oc";
        if (done && i === O.odd) cls += i === O.picked ? " correct" : " odd-reveal";
        if (done && i === O.picked && i !== O.odd) cls += " wrong";
        const items = r.items.map((id) => { const it = look("items", id, "Item");
          return `<div class="icon" data-tip="items:${id}" title="">${it.icon ? `<img src="${esc(it.icon)}" alt="${esc(it.name)}" loading="lazy">` : esc(it.name)}</div>`; }).join("");
        const augs = O.rev.aug ? `<div class="oc-aug">${r.aug.map((id) => { const o = look("augments", id, "Augment");
          return `<span data-tip="augments:${id}">${o.icon ? `<img src="${esc(o.icon)}" alt="">` : ""}</span>`; }).join("")}</div>` : "";
        const w = wOf(r);
        const who = done ? `<div class="who"><span>${i === O.odd ? "Odd one: " : ""}<b>${plink(r.p)}</b></span>
          ${w ? `<span>Weirdness ${w.score}</span>` : ""}</div>` : "";
        // Not "disabled" once answered: disabled buttons swallow clicks on the
        // player names inside them. guess() ignores repeat picks instead.
        return `<button type="button" class="${cls}${done ? " done" : ""}" data-card="${i}">
          <div class="oc-head">${portrait(c)}<div><div class="oc-name">${esc(c.name)}</div>
            <div class="oc-sub">${esc(rolesOf(r.c))}</div></div><span class="k">${done ? "" : i + 1}</span></div>
          <div class="oc-items">${items}</div>${augs}${who}</button>`;
      }).join("");
      let verdict = "";
      if (done) {
        const ok = O.picked === O.odd;
        verdict = `<div class="verdict"><div>
          <div class="msg ${ok ? "good" : "bad"}">${ok ? "Correct!" : "Nope!"}</div>
          <div class="meta">Three were ${plink(O.a)}'s; the odd one was ${plink(O.b)}'s.</div>
          </div>${nextBtn()}</div>`;
      }
      main.innerHTML = `<section class="card">
        <p class="guess-title">Three of these builds are by the same friend. Which one isn't?</p>
        <div class="hints"><button type="button" data-hint="aug" ${O.rev.aug ? "disabled" : ""}>Show augments</button></div>
        <div class="odd-grid" style="margin-top:12px">${cards}</div>${verdict}</section>`;
      wireHints(O.rev);
      $$("#main [data-card]").forEach((b) => b.onclick = (e) => {
        if (e.target.closest("[data-tip]") && !hoverable) return;   // tapping an item shows its info
        this.guess(+b.dataset.card);
      });
      wireNext(() => this.start());
    },
    guess(i) {
      if (O.picked >= 0) return;
      O.picked = i;
      record(i === O.odd);
      this.render();
    },
    key(e) {
      const n = parseInt(e.key, 10);
      if (O.picked < 0 && n >= 1 && n <= 4) this.guess(n - 1);
      else if (O.picked >= 0 && e.key === "Enter") this.start();
    },
  };

  // ======================================================================
  // Play mode 4: Did it win?
  // ======================================================================
  const V = { r: null, rev: {}, answered: null };
  const winMode = {
    start() {
      renderScore();
      V.r = pickRound(eligible());
      if (!V.r) { emptyCard(`No games match these settings. Include more players in <b>Players &amp; options</b>.`); return; }
      V.rev = {}; V.answered = null;
      this.render();
    },
    render() {
      const r = V.r, done = V.answered !== null;
      const btn = (val, label, k) => {
        const cls = !done ? "" : val === r.win ? "correct" : val === V.answered ? "wrong" : "";
        return `<button type="button" data-win="${val ? 1 : 0}" class="${cls}" ${done ? "disabled" : ""}>${label}<span class="k">${k}</span></button>`;
      };
      let verdict = "";
      if (done) {
        const ok = V.answered === r.win, [k, d, a] = r.kda;
        verdict = `<div class="verdict"><div>
          <div class="msg ${ok ? "good" : "bad"}">${ok ? "Correct!" : "Nope!"} It was a ${r.win ? "win" : "loss"}.</div>
          <div class="meta">${k}/${d}/${a} · ${mins(r)} min · ${fmtDate(r.t)}</div></div>${nextBtn()}</div>`;
      }
      main.innerHTML = buildCard(r, {
        champ: true, cls: true, rev: V.rev, byline: r.p, link: done, weird: done,
        hints: ["kdaOnly", "aug", "spells", "foes"],
      }) + `<section class="card"><p class="guess-title">Did this build win?</p>
        <div class="wl">${btn(true, "Victory", "V")}${btn(false, "Defeat", "D")}</div>${verdict}</section>`;
      wireHints(V.rev);
      $$("#main [data-win]").forEach((b) => b.onclick = () => this.guess(b.dataset.win === "1"));
      wireNext(() => this.start());
    },
    guess(val) {
      if (V.answered !== null) return;
      V.answered = val;
      record(val === V.r.win);
      this.render();
    },
    key(e) {
      const k = e.key.toLowerCase();
      if (V.answered === null && (k === "v" || k === "1")) this.guess(true);
      else if (V.answered === null && (k === "d" || k === "2")) this.guess(false);
      else if (V.answered !== null && e.key === "Enter") this.start();
    },
  };

  const MODES = { player: playerMode, champ: champMode, odd: oddMode, win: winMode };

  // ======================================================================
  // Daily: the same 5 "Whose build?" rounds for everyone, per Pacific day
  // ======================================================================
  const TZ = "America/Los_Angeles";
  const ptDate = (ms) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
  const EPOCH = "2026-10-12";                       // Daily #1
  const dayNumber = (day) => {
    const [y, m, d] = day.split("-").map(Number), [y0, m0, d0] = EPOCH.split("-").map(Number);
    return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(y0, m0 - 1, d0)) / 86400000) + 1;
  };
  function msUntilNextDay() {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", minute: "numeric", second: "numeric", hourCycle: "h23" })
      .formatToParts(new Date()).map((p) => [p.type, +p.value || 0]));
    return 86400000 - ((parts.hour * 60 + parts.minute) * 60 + parts.second) * 1000;
  }
  function seededRandom(seed) {                    // cyrb53-style hash -> mulberry32
    let h = 1779033703 ^ seed.length;
    for (let i = 0; i < seed.length; i++) { h = Math.imul(h ^ seed.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
    let a = h >>> 0;
    return () => {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const DAILY_ROUNDS = 5;
  function buildDaily(day) {
    // Only games collected before today started, so a push mid-day doesn't
    // change anyone's puzzle. Sorted so every browser sees the same order.
    const pool = D.rounds.filter((r) => ptDate(r.f || r.t) < day)
      .sort((x, y) => (x.g - y.g) || (x.p < y.p ? -1 : x.p > y.p ? 1 : 0));
    const bp = byPlayer(pool);
    const choices = players.filter((p) => bp[p]);
    const rnd = seededRandom("whosebuild:" + day);
    const rounds = [], used = new Set();
    for (let i = 0; i < DAILY_ROUNDS * 20 && rounds.length < DAILY_ROUNDS; i++) {
      const p = pick(choices, rnd);
      const opts = bp[p].filter((r) => !used.has(keyOf(r)));
      if (!opts.length) continue;
      const r = pick(opts, rnd);
      used.add(keyOf(r)); rounds.push(r);
    }
    return { rounds, choices };
  }

  const Dy = { day: null, set: null, st: null, rev: {} };
  const daily = {
    start() {
      Dy.day = ptDate(Date.now());
      Dy.set = buildDaily(Dy.day);
      Dy.st = store.get("daily." + Dy.day, { i: 0, res: [] });
      Dy.rev = {};
      $("#score").innerHTML = `<b>Daily #${dayNumber(Dy.day)}</b><br>${Dy.st.res.filter((x) => x.ok).length}/${DAILY_ROUNDS}`;
      if (Dy.set.rounds.length < DAILY_ROUNDS || Dy.set.choices.length < 2) {
        emptyCard("Not enough games collected yet for a daily challenge. Check back tomorrow!");
        return;
      }
      this.render();
    },
    save() { store.set("daily." + Dy.day, Dy.st); },
    render() {
      const st = Dy.st;
      $("#score").innerHTML = `<b>Daily #${dayNumber(Dy.day)}</b><br>${st.res.filter((x) => x.ok).length}/${DAILY_ROUNDS}`;
      if (st.res.length >= DAILY_ROUNDS && st.i >= DAILY_ROUNDS) return this.summary();
      const idx = Math.min(st.i, DAILY_ROUNDS - 1), r = Dy.set.rounds[idx];
      const answered = st.res[idx];
      const pips = Dy.set.rounds.map((_, i) => i < st.res.length ? (st.res[i].ok ? "🟩" : "🟥") : i === idx ? "⬜" : "▫️").join("");
      const guesses = Dy.set.choices.map((p, i) => {
        const cls = !answered ? "" : p === r.p ? "correct" : p === answered.guess ? "wrong" : "";
        return `<button type="button" data-guess="${esc(p)}" class="${cls}" ${answered ? "disabled" : ""}>
          <span class="k">${i < 9 ? i + 1 : ""}</span>${esc(short(p))}</button>`;
      }).join("");
      let verdict = "";
      if (answered) {
        verdict = `<div class="verdict"><div>
          <div class="msg ${answered.ok ? "good" : "bad"}">${answered.ok ? `Correct! It was ${plink(r.p)}.` : `Nope, it was ${plink(r.p)}.`}</div>
          <div class="meta">${esc(look("champions", r.c, "Champion").name)} · ${fmtDate(r.t)} · ${mins(r)} min</div>
          </div>${nextBtn(idx === DAILY_ROUNDS - 1 ? "See results" : "Next round")}</div>`;
      }
      const rev = answered ? { ...Dy.rev, champ: true } : Dy.rev;
      main.innerHTML = `<div class="daily-head"><h2>Daily #${dayNumber(Dy.day)}</h2>
          <span class="prog">Round ${idx + 1} of ${DAILY_ROUNDS}<span class="pips">${pips}</span></span></div>`
        + buildCard(r, {
          champ: !!rev.champ, cls: !!rev.cls, rev, weird: !!answered,
          hints: answered ? [] : [!rev.cls && "cls", "champ", "aug", "spells", "kda", "foes"].filter(Boolean),
        }) + `<section class="card"><p class="guess-title">Whose build is this?</p>
          <div class="guesses">${guesses}</div>${verdict}</section>`;
      wireHints(Dy.rev);
      $$("#main [data-guess]").forEach((b) => b.onclick = () => this.guess(b.dataset.guess));
      wireNext(() => { st.i = idx + 1; Dy.rev = {}; this.save(); this.render(); window.scrollTo({ top: 0 }); });
    },
    guess(p) {
      const st = Dy.st, idx = st.i, r = Dy.set.rounds[idx];
      if (st.res[idx]) return;
      st.res[idx] = { guess: p, ok: p === r.p, hints: Object.keys(Dy.rev).filter((k) => Dy.rev[k]).length };
      this.save();
      this.render();
    },
    shareText() {
      const st = Dy.st, right = st.res.filter((x) => x.ok).length;
      const hints = st.res.reduce((t, x) => t + (x.hints || 0), 0);
      const url = location.protocol.startsWith("http") ? "\n" + location.href.split(/[?#]/)[0] : "";
      return `Whose Build? Daily #${dayNumber(Dy.day)} · ${right}/${DAILY_ROUNDS}\n`
        + st.res.map((x) => x.ok ? "🟩" : "🟥").join("")
        + `\n💡 ${hints} hint${hints === 1 ? "" : "s"}` + url;
    },
    summary() {
      const st = Dy.st, right = st.res.filter((x) => x.ok).length, text = this.shareText();
      applyNav();                                    // clears the "not played" dot
      const recap = Dy.set.rounds.map((r, i) => {
        const c = look("champions", r.c, "Champion"), res = st.res[i];
        return `<div class="rc">${portrait(c)}<div><b>${plink(r.p)}</b> · ${esc(c.name)}
          <div style="color:var(--muted);font-size:12px">${res.ok ? "You got it" : `You said ${esc(short(res.guess))}`}${res.hints ? ` · ${res.hints} hint${res.hints === 1 ? "" : "s"}` : ""}</div></div>
          <span class="mark">${res.ok ? "🟩" : "🟥"}</span></div>`;
      }).join("");
      const h = Math.floor(msUntilNextDay() / 3600000), m = Math.floor(msUntilNextDay() % 3600000 / 60000);
      main.innerHTML = `<section class="card summary">
        <div style="color:var(--muted)">Daily #${dayNumber(Dy.day)}</div>
        <div class="big">${right}/${DAILY_ROUNDS}</div>
        <div class="emoji">${st.res.map((x) => x.ok ? "🟩" : "🟥").join("")}</div>
        <div class="share-row">
          <button type="button" class="primary" id="copy">Copy result</button>
          ${navigator.share ? `<button type="button" id="share">Share…</button>` : ""}
        </div>
        <pre id="sharetext">${esc(text)}</pre>
        <div class="next-in">Next daily in ${h}h ${m}m</div>
        <div class="recap">${recap}</div>
      </section>`;
      $("#copy").onclick = async () => {
        try { await navigator.clipboard.writeText(text); toast("Copied! Paste it in the group chat."); }
        catch {
          const range = document.createRange(); range.selectNodeContents($("#sharetext"));
          const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
          toast("Selected. Press Ctrl+C / long-press to copy.");
        }
      };
      const sh = $("#share");
      if (sh) sh.onclick = () => navigator.share({ text }).catch(() => {});
    },
    key(e) {
      const st = Dy.st;
      if (!st || st.i >= DAILY_ROUNDS) return;
      const idx = st.i, n = parseInt(e.key, 10);
      if (!st.res[idx] && n >= 1 && n <= 9) { const c = Dy.set.choices[n - 1]; if (c) this.guess(c); }
      else if (st.res[idx] && e.key === "Enter") $("#next") && $("#next").click();
    },
    played() { const s = store.get("daily." + ptDate(Date.now()), null); return s && s.i >= DAILY_ROUNDS; },
  };

  // ======================================================================
  // Hall of Shame: the weirdest builds on record
  // ======================================================================
  let shameWho = store.get("shameWho", "");
  const shame = {
    start() { $("#score").innerHTML = ""; this.render(); },
    render() {
      const list = D.rounds.filter((r) => !shameWho || r.p === shameWho)
        .map((r) => ({ r, w: wOf(r) })).filter((x) => x.w)
        .sort((a, b) => b.w.score - a.w.score || b.r.t - a.r.t).slice(0, 25);
      const rows = list.map(({ r, w }, i) => {
        const c = look("champions", r.c, "Champion");
        const items = r.items.map((id) => { const it = look("items", id, "Item");
          return `<div class="icon" data-tip="items:${id}">${it.icon ? `<img src="${esc(it.icon)}" alt="${esc(it.name)}" loading="lazy">` : esc(it.name)}</div>`; }).join("");
        return `<div class="sh"><div class="rank">${i + 1}</div><div>
          <div class="sh-top">${portrait(c)}<div><div class="sh-name">${esc(c.name)} <span style="color:var(--muted);font-weight:400">by</span> ${plink(r.p)}</div>
            <div class="sh-sub">${fmtDate(r.t)} · ${r.kda.join("/")} · ${r.win ? "won" : "lost"}</div></div>
            <span class="wbadge" title="Weirdness">${w.score}</span></div>
          <div class="sh-items">${items}</div>
          <div class="why">${esc(cap(weirdReason(w)))}</div></div></div>`;
      }).join("");
      main.innerHTML = `<div class="shame-head"><div><h2>Hall of Shame</h2>
          <p>${EXTERNAL
            ? "The weirdest builds on record, scored against how other players in your lobbies built the same champion."
            : "The weirdest builds on record, by how rarely the group puts those items on that class of champion."}</p></div>
          <select id="shameWho"><option value="">Everyone</option>
            ${players.map((p) => `<option value="${esc(p)}" ${p === shameWho ? "selected" : ""}>${esc(short(p))}</option>`).join("")}</select></div>
        <div class="shame">${rows || `<div class="card empty-state">No builds yet.</div>`}</div>`;
      $("#shameWho").onchange = (e) => { shameWho = e.target.value; store.set("shameWho", shameWho); this.render(); };
    },
    key() {},
  };

  // ======================================================================
  // Player profiles: a panel opened by clicking any player's name
  // ======================================================================
  const pf = document.createElement("div");
  pf.id = "profile"; pf.className = "pf"; pf.hidden = true;
  pf.innerHTML = `<div class="pf-backdrop" data-close></div>
    <aside class="pf-panel" role="dialog" aria-modal="true" aria-label="Player profile">
      <button type="button" class="pf-close" data-close aria-label="Close">×</button>
      <div class="pf-body"></div></aside>`;
  document.body.appendChild(pf);
  let pfOpen = null;

  const realItem = (id) => !(D.items && D.items[id] && D.items[id].comp);
  const pct = (x) => `${Math.round(100 * x)}%`;

  // Things this player picks much more often than the rest of the group
  function signature(mine, others, getList, filter = () => true, min = 2, top = 6) {
    const count = (rs) => {
      const m = new Map();
      rs.forEach((r) => new Set(getList(r)).forEach((x) => { if (x && filter(x)) m.set(x, (m.get(x) || 0) + 1); }));
      return m;
    };
    const cm = count(mine), co = count(others);
    return [...cm].filter(([, n]) => n >= Math.min(min, Math.max(1, mine.length)))
      .map(([x, n]) => ({ x, n, rate: n / mine.length, other: others.length ? (co.get(x) || 0) / others.length : 0 }))
      .sort((a, b) => (b.rate - b.other) - (a.rate - a.other) || b.n - a.n).slice(0, top);
  }

  function profileHtml(rid) {
    const mine = D.rounds.filter((r) => r.p === rid), others = D.rounds.filter((r) => r.p !== rid);
    if (!mine.length) return `<h2 class="pf-name">${esc(short(rid))}</h2><p class="pf-muted">No builds recorded yet.</p>`;
    const wins = mine.filter((r) => r.win).length;
    const ws = mine.map(wOf).filter(Boolean);
    const avgW = ws.length ? Math.round(ws.reduce((t, w) => t + w.score, 0) / ws.length) : null;

    const items = signature(mine, others, (r) => r.items, realItem).map(({ x, n, rate, other }) => {
      const it = look("items", x, "Item");
      return `<div class="pf-row" data-tip="items:${x}"><span class="pf-ic">${iconEl(it)}</span>
        <span class="pf-label">${esc(it.name)}</span>
        <span class="pf-stat"><b>${pct(rate)}</b> of builds<br><span>group ${pct(other)}</span></span></div>`;
    }).join("");
    const augs = signature(mine, others, (r) => r.aug, () => true, 2, 5).map(({ x, rate, other }) => {
      const a = look("augments", x, "Augment");
      return `<div class="pf-row" data-tip="augments:${x}"><span class="pf-ic r-${esc(a.rarity || "")}">${iconEl(a)}</span>
        <span class="pf-label">${esc(a.name)}</span>
        <span class="pf-stat"><b>${pct(rate)}</b> of games<br><span>group ${pct(other)}</span></span></div>`;
    }).join("");
    const byChamp = {};
    mine.forEach((r) => { const b = (byChamp[r.c] ||= { n: 0, w: 0 }); b.n++; if (r.win) b.w++; });
    const champs = Object.entries(byChamp).sort((a, b) => b[1].n - a[1].n).slice(0, 8).map(([c, b]) => {
      const ch = look("champions", c, "Champion");
      return `<div class="pf-champ" title="${esc(ch.name)}">${portrait(ch)}<span>${esc(ch.name)}</span>
        <span class="pf-muted">×${b.n} · ${pct(b.w / b.n)} W</span></div>`;
    }).join("");
    const weirdest = mine.map((r) => ({ r, w: wOf(r) })).filter((x) => x.w).sort((a, b) => b.w.score - a.w.score)[0];
    const weirdHtml = weirdest ? (() => {
      const { r, w } = weirdest, c = look("champions", r.c, "Champion");
      const its = r.items.map((id) => { const it = look("items", id, "Item");
        return `<div class="icon" data-tip="items:${id}">${it.icon ? `<img src="${esc(it.icon)}" alt="${esc(it.name)}" loading="lazy">` : esc(it.name)}</div>`; }).join("");
      return `<div class="pf-weird"><div class="sh-top">${portrait(c)}<div><div class="sh-name">${esc(c.name)}</div>
        <div class="sh-sub">${fmtDate(r.t)} · ${r.kda.join("/")} · ${r.win ? "won" : "lost"}</div></div>
        <span class="wbadge">${w.score}</span></div><div class="sh-items">${its}</div>
        <div class="why">${esc(cap(weirdReason(w)))}</div></div>`;
    })() : "";

    return `<h2 class="pf-name">${esc(short(rid))}</h2><div class="pf-muted">${esc(rid)}</div>
      <div class="pf-stats">
        <div><b>${mine.length}</b><span>builds</span></div>
        <div><b>${pct(wins / mine.length)}</b><span>win rate</span></div>
        <div><b>${avgW ?? "–"}</b><span>avg weirdness</span></div>
      </div>
      ${items ? `<h3>Signature items</h3><p class="pf-muted">Built much more often than the rest of the group.</p><div class="pf-list">${items}</div>` : ""}
      ${augs ? `<h3>Favorite augments</h3><div class="pf-list">${augs}</div>` : ""}
      <h3>Most played</h3><div class="pf-champs">${champs}</div>
      ${weirdHtml ? `<h3>Weirdest build</h3>${weirdHtml}` : ""}`;
  }

  function openProfile(rid, fromHash = false) {
    if (!players.includes(rid)) return;
    hideTip();
    pfOpen = rid;
    pf.querySelector(".pf-body").innerHTML = profileHtml(rid);
    pf.querySelector(".pf-panel").scrollTop = 0;
    pf.hidden = false;
    requestAnimationFrame(() => pf.classList.add("show"));
    document.body.style.overflow = "hidden";
    if (!fromHash) history.replaceState(null, "", "#player=" + encodeURIComponent(rid));
    pf.querySelector(".pf-close").focus({ preventScroll: true });
  }
  function closeProfile() {
    if (!pfOpen) return;
    pfOpen = null;
    hideTip();
    pf.classList.remove("show");
    document.body.style.overflow = "";
    setTimeout(() => { if (!pfOpen) pf.hidden = true; }, 200);
    if (location.hash) history.replaceState(null, "", location.pathname + location.search);
  }
  function profileFromHash() {
    const m = location.hash.match(/^#player=(.+)$/);
    if (m) openProfile(decodeURIComponent(m[1]), true); else closeProfile();
  }
  pf.addEventListener("click", (e) => { if (e.target.closest("[data-close]")) closeProfile(); });
  // Capture phase, so a name inside a card or a settings chip opens the
  // profile instead of guessing / toggling the checkbox.
  document.addEventListener("click", (e) => {
    const el = e.target.closest("[data-profile]");
    if (!el) return;
    e.preventDefault(); e.stopPropagation();
    openProfile(el.dataset.profile);
  }, true);
  addEventListener("hashchange", profileFromHash);

  // ======================================================================
  // Navigation
  // ======================================================================
  let view = ["play", "daily", "shame"].includes(store.get("view")) ? store.get("view") : "play";
  let mode = MODES[store.get("mode")] ? store.get("mode") : "player";
  const VIEWS = { play: { start: () => MODES[mode].start(), key: (e) => MODES[mode].key(e), render: () => MODES[mode].render() },
                  daily, shame };

  function rerender() { hideTip(); VIEWS[view].render(); }

  function applyNav() {
    $$("#tabs button").forEach((b) => b.classList.toggle("on", b.dataset.view === view));
    const dailyBtn = $('#tabs [data-view="daily"]');
    dailyBtn.innerHTML = "Daily" + (daily.played() ? "" : '<span class="dot" title="Not played yet today"></span>');
    $("#playbar").style.display = view === "play" ? "" : "none";
    $$("#modes button").forEach((b) => b.classList.toggle("on", b.dataset.mode === mode));
    $$(".for-player").forEach((el) => el.style.display = mode === "player" ? "" : "none");
    $$(".for-champ").forEach((el) => el.style.display = mode === "champ" ? "" : "none");
  }
  $$("#tabs button").forEach((b) => b.onclick = () => {
    view = b.dataset.view; store.set("view", view); applyNav(); hideTip(); VIEWS[view].start();
  });
  $$("#modes button").forEach((b) => b.onclick = () => {
    if (b.dataset.mode === mode) return;
    mode = b.dataset.mode; store.set("mode", mode); applyNav(); hideTip(); MODES[mode].start();
  });

  document.addEventListener("keydown", (e) => {
    if (pfOpen) { if (e.key === "Escape") closeProfile(); return; }
    if ((e.key === "Enter" || e.key === " ") && e.target.dataset && e.target.dataset.profile) {
      e.preventDefault(); openProfile(e.target.dataset.profile); return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.target.id === "search" || ["SELECT", "INPUT", "TEXTAREA"].includes(e.target.tagName)) return;
    if (e.target.tagName === "BUTTON" && (e.key === "Enter" || e.key === " ")) return;  // let the button handle it
    VIEWS[view].key(e);
  });

  // ======================================================================
  // Hover / tap popups for items, augments, spells
  // ======================================================================
  const tip = $("#tip");
  const RARITY = { kSilver: "Silver augment", kGold: "Gold augment", kPrismatic: "Prismatic augment" };
  let tipFor = null;
  function showTip(el) {
    const [table, id] = el.dataset.tip.split(":");
    const o = (D[table] || {})[id];
    if (!o) return;
    let sub = "";
    if (table === "augments") sub = RARITY[o.rarity] || "Augment";
    if (table === "items" && o.cost) sub = `${o.cost.toLocaleString()} gold`;
    if (table === "spells") sub = "Summoner spell";
    tip.innerHTML = `<div class="t-name">${esc(o.name)}</div>${sub ? `<div class="t-sub">${esc(sub)}</div>` : ""}
      ${o.desc ? `<div class="t-desc">${esc(o.desc)}</div>` : `<div class="t-none">No description available.</div>`}`;
    tip.classList.add("show");
    tipFor = el;
    const r = el.getBoundingClientRect(), t = tip.getBoundingClientRect(), pad = 8;
    const x = Math.min(Math.max(pad, r.left + r.width / 2 - t.width / 2), innerWidth - t.width - pad);
    let y = r.bottom + 8;
    if (y + t.height > innerHeight - pad) y = Math.max(pad, r.top - t.height - 8);
    tip.style.left = x + "px"; tip.style.top = y + "px";
  }
  function hideTip() { tip.classList.remove("show"); tipFor = null; }
  if (hoverable) {
    document.addEventListener("mouseover", (e) => {
      const el = e.target.closest("[data-tip]");
      if (el && el !== tipFor) showTip(el); else if (!el && tipFor) hideTip();
    });
  }
  document.addEventListener("click", (e) => {
    const el = e.target.closest("[data-tip]");
    if (!el) { if (!hoverable) hideTip(); return; }
    if (!hoverable && el === tipFor) hideTip(); else showTip(el);
  });
  addEventListener("scroll", hideTip, { passive: true });

  // ======================================================================
  // Go
  // ======================================================================
  const gen = new Date(D.generated).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  $("#footer").innerHTML = `${D.rounds.length} builds from ${new Set(D.rounds.map((r) => r.g)).size} games · updated ${esc(gen)}`
    + (Object.values(D.augments || {}).some((a) => a.desc)
      ? `<br>Augment descriptions from the <a href="https://wiki.leagueoflegends.com/en-us/ARAM_Mayhem/Augments" style="color:inherit">League of Legends Wiki</a> (CC BY-SA).` : "");

  applyNav();
  renderPlayers();
  VIEWS[view].start();
  profileFromHash();
})();
