// Margin tutor: one-page app over the JSON API in server.py.
// Views render into #side, #top, #main and #tutor; clicks are delegated through data-act attributes.

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const TYPE_LABEL = { mcq: "Multiple choice", fill: "Fill in the blanks", free: "Free-form", math: "Math", python: "Python" };
const STATUS_LABEL = { correct: "Correct", partial: "Partly right", incorrect: "Not quite", grading: "Grading…" };
const CHEERS = ["Nailed it! 🎉", "Brilliant! ⭐", "You got it! 🚀", "Awesome work! 🌟", "Spot on! 🎯", "Exactly right! 💡"];
const EMOJIS = ["🦊", "🐼", "🦁", "🐯", "🐸", "🐙", "🦄", "🐲", "🦉", "🐧", "🐳", "🦖", "🚀", "⭐", "🌈", "⚡", "🎨", "🎸", "⚽", "🧠", "📚", "🧪", "🔭", "👩‍💻", "👨‍💻", "🧑‍🏫"];
const COLORS = ["#3b5bdb", "#e8590c", "#2b8a3e", "#c2255c", "#7048e8", "#0c8599", "#f08c00"];
const CLAUDE_EFFORT = ["", "low", "medium", "high", "xhigh", "max"];
const PI_THINKING = ["", "off", "minimal", "low", "medium", "high", "xhigh"];
const QUICK_Q = ["Give me a hint", "Explain the idea behind this", "Why is my answer wrong?", "Show me the full solution", "3 more questions like this"];
const QUICK_LESSON = ["Explain this more simply", "Give me a real-life example", "Rewrite the lesson with fun examples", "Add 3 practice questions"];

const S = {
  config: null, profiles: [], pid: null, courses: [], course: null, ch: null,
  route: { view: "library" }, menu: false,
  gen: null, chGen: {}, outline: null, editOutline: false,
  drafts: {}, grading: {}, hints: {}, solution: {}, pyOut: {}, running: {},
  activeQ: null, tutor: { open: false, qid: null, pending: null },
  prompts: null, promptSel: "tutor", review: null, editingProfile: null,
};

// ---- small utilities --------------------------------------------------------

const store = {
  get(k, d = null) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};

async function api(method, path, body) {
  const r = await fetch(path, { method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || r.statusText);
  return d;
}

// POST that answers with server-sent events; resolves with the "done" payload.
async function sse(path, body, onEvent) {
  const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
  if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error || r.statusText); }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = "", result;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      if (!chunk.startsWith("data:")) continue;
      const ev = JSON.parse(chunk.slice(5));
      if (ev.type === "error") throw new Error(ev.message);
      if (ev.type === "done") result = ev.data;
      else if (onEvent) onEvent(ev);
    }
  }
  return result;
}

function tex(src, display = false) {
  try { return katex.renderToString(src, { displayMode: display, throwOnError: false }); } catch { return esc(src); }
}

// Markdown with $…$ / $$…$$ math. Math is lifted out before marked runs so underscores and
// backslashes inside formulas survive, then rendered with KaTeX and the whole thing sanitised.
function md(src, inline = false) {
  const math = [];
  let s = String(src ?? "")
    .replace(/\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]/g, (m, a, b) => { math.push([a ?? b, true]); return `@@M${math.length - 1}@@`; })
    .replace(/\\\((.+?)\\\)|\$(?=\S)([^$\n]+?)(?<=\S)\$(?!\d)/g, (m, a, b) => { math.push([a ?? b, false]); return `@@M${math.length - 1}@@`; });
  let html = inline ? marked.parseInline(s) : marked.parse(s);
  html = html.replace(/@@M(\d+)@@/g, (m, k) => tex(math[k][0], math[k][1]));
  return DOMPurify.sanitize(html);
}

function toast(text, kind = "") {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = text;
  $("#toasts").appendChild(el);
  setTimeout(() => el.remove(), 2700);
}

function celebrate(big = false) {
  if (!S.config?.fun?.confetti || typeof confetti !== "function") return;
  confetti({ particleCount: big ? 160 : 70, spread: big ? 100 : 65, origin: { y: big ? 0.6 : 0.75 }, disableForReducedMotion: true });
}

function fail(e) { console.error(e); toast(e.message || String(e), "err"); }

const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const profile = () => S.profiles.find((p) => p.id === S.pid);
const level = (xp) => ({ n: Math.floor((xp || 0) / 100) + 1, pct: (xp || 0) % 100 });
const pill = (st) => (st ? `<span class="pill ${st}">${STATUS_LABEL[st] || st}</span>` : "");
const ago = (ms) => {
  const d = (Date.now() - ms) / 86400000;
  return d < 1 ? "today" : d < 2 ? "yesterday" : d < 30 ? `${Math.floor(d)} days ago` : new Date(ms).toLocaleDateString();
};

// ---- routing ----------------------------------------------------------------

function parseRoute() {
  const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  if (!parts.length) return { view: "library" };
  if (parts[0] === "c" && parts[1]) {
    if (!parts[2]) return { view: "course", cid: parts[1] };
    if (parts[3] === "summary") return { view: "summary", cid: parts[1], chid: parts[2] };
    return { view: "chapter", cid: parts[1], chid: parts[2], q: parts[3] };
  }
  return { view: { new: "start", review: "review", settings: "settings", profiles: "profiles" }[parts[0]] || "library" };
}

const go = (hash) => { if (location.hash === hash) onRoute(); else location.hash = hash; };

async function onRoute() {
  const r = parseRoute();
  S.route = r;
  S.menu = false;
  try {
    if (!profile() && r.view !== "profiles") { renderAll(); return; }
    if (r.cid) {
      if (S.course?.id !== r.cid) { S.course = await api("GET", `/api/courses/${r.cid}`); S.editOutline = false; S.outline = null; }
      if (r.chid) {
        if (S.ch?.id !== r.chid || S.chCourse !== r.cid) {
          S.ch = null;
          const entry = S.course.chapters.find((c) => c.id === r.chid);
          if (entry?.status === "ready") { S.ch = await api("GET", `/api/courses/${r.cid}/ch/${r.chid}`); S.chCourse = r.cid; seedDrafts(); }
        }
        if (r.q) S.activeQ = r.q;
        else if (!S.ch?.questions?.some((q) => q.id === S.activeQ)) S.activeQ = null;
      }
    } else if (r.view === "library") {
      await loadCourses();
    }
    if (r.view === "review") loadReview();
    if (r.view === "settings" && !S.prompts) S.prompts = await api("GET", "/api/prompts");
  } catch (e) { fail(e); }
  if (r.view !== "chapter" && S.tutor.open && !S.tutor.pending) S.tutor.open = false;
  renderAll();
  if (r.view === "chapter" && !S.ch) generateChapter(r.cid, r.chid);
  if (r.view === "chapter" && r.q) requestAnimationFrame(() => $(`#q-${r.q}`)?.scrollIntoView({ behavior: "smooth", block: "start" }));
  else $("#main").scrollTop = 0;
}

async function loadCourses() { S.courses = await api("GET", `/api/courses?profile=${encodeURIComponent(S.pid)}`); }

// ---- render: frame ----------------------------------------------------------

function renderAll() {
  renderSide();
  renderTop();
  renderMain();
  renderTutor();
}

function renderSide() {
  const p = profile();
  if (!p) { $("#side").innerHTML = `<div class="brand"><b>Margin</b><span>tutor</span></div>`; return; }
  const lv = level(p.xp);
  const v = S.route.view;
  const missed = S.courses.map((c) => (c.id === S.course?.id ? S.course : c))
    .reduce((n, c) => n + c.chapters.reduce((m, ch) => m + (ch.missed || 0), 0), 0);
  let html = `
    <div class="brand"><b>Margin</b><span>tutor</span></div>
    <div class="who">
      <button class="who-btn" data-act="menu">
        <span class="avatar" style="background:${p.color || COLORS[0]}26">${esc(p.emoji || "🙂")}</span>
        <span class="grow">
          <span class="who-name">${esc(p.name)}</span>
          <span class="who-stats"><span>Lv ${lv.n} · ${p.xp || 0} XP</span>${p.streak ? `<span class="fire">🔥 ${p.streak}</span>` : ""}</span>
          <span class="lvl"><span style="width:${lv.pct}%"></span></span>
        </span>
        <span class="muted">▾</span>
      </button>
      ${S.menu ? `<div class="menu">
        ${S.profiles.map((x) => `<button data-act="switch" data-id="${x.id}"><span class="avatar" style="background:${x.color || COLORS[0]}26">${esc(x.emoji || "🙂")}</span><span class="grow">${esc(x.name)}</span><span class="muted small">${x.xp || 0} XP</span></button>`).join("")}
        <button data-act="nav" data-to="#/profiles"><span class="avatar">⚙︎</span>Manage profiles</button>
      </div>` : ""}
    </div>
    <nav class="nav">
      <button class="${v === "start" ? "on" : ""}" data-act="nav" data-to="#/new"><span class="ic" style="color:var(--accent);font-weight:600">+</span>New course</button>
      <button class="${v === "library" ? "on" : ""}" data-act="nav" data-to="#/"><span class="ic">▤</span>Notebooks</button>
      <button class="${v === "review" ? "on" : ""}" data-act="nav" data-to="#/review"><span class="ic">↺</span><span class="grow">Review mistakes</span>${missed ? `<span class="count">${missed}</span>` : ""}</button>
    </nav>`;
  const c = S.course;
  if (c && c.profile === S.pid && ["course", "chapter", "summary"].includes(v)) {
    const done = c.chapters.reduce((n, x) => n + (x.answered || 0), 0);
    const total = c.chapters.reduce((n, x) => n + (x.total || 0), 0) || 1;
    html += `<div class="side-course">
      <div class="eyebrow">Current notebook</div>
      <button class="side-title ${v === "course" ? "on" : ""}" data-act="nav" data-to="#/c/${c.id}">
        <span class="serif">${esc(c.emoji || "")} ${esc(c.title)}</span>
        <span class="bar"><span style="width:${Math.round((done / total) * 100)}%"></span></span>
      </button>
      ${c.chapters.map((x, i) => {
        const open = S.route.chid === x.id && S.ch;
        const dot = x.finished ? "done" : x.answered ? "going" : "fresh";
        return `<button class="side-ch ${S.route.chid === x.id ? "on" : ""}" data-act="nav" data-to="#/c/${c.id}/${x.id}">
            <span class="dot ${dot}"></span><span class="mono small muted">${i + 1}</span><span class="grow">${esc(x.title)}</span></button>
          ${open ? `<div class="side-qs">${S.ch.questions.map((q) => {
            const st = S.ch.answers?.[q.id]?.result?.status;
            return `<button class="side-q ${S.activeQ === q.id ? "on" : ""}" data-act="jump" data-q="${q.id}"><span class="dot ${st || ""}"></span>${q.id.toUpperCase()} · ${TYPE_LABEL[q.type]}</button>`;
          }).join("")}</div>` : ""}`;
      }).join("")}
    </div>`;
  }
  const theme = document.documentElement.dataset.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  html += `<div class="side-foot">
    <button class="btn" data-act="theme">${theme === "dark" ? "☀︎ Light" : "☾ Dark"}</button>
    <button class="btn ${v === "settings" ? "on" : ""}" data-act="nav" data-to="#/settings">⚙︎ Settings</button>
  </div>`;
  $("#side").innerHTML = html;
}

function renderTop() {
  const r = S.route, c = S.course;
  const crumbs = [];
  if (["course", "chapter", "summary"].includes(r.view) && c) {
    crumbs.push(`<a href="#/">Notebooks</a>`);
    if (r.view === "course") crumbs.push(`<span class="cur">${esc(c.title)}</span>`);
    else {
      const i = c.chapters.findIndex((x) => x.id === r.chid);
      crumbs.push(`<a href="#/c/${c.id}">${esc(c.title)}</a>`);
      crumbs.push(`<span class="cur">${i + 1}. ${esc(c.chapters[i]?.title || "")}${r.view === "summary" ? " · Summary" : ""}</span>`);
    }
  } else {
    crumbs.push(`<span class="cur">${{ library: "Notebooks", start: "New course", review: "Review mistakes", settings: "Settings", profiles: "Profiles" }[r.view] || ""}</span>`);
  }
  let right = "";
  if (r.view === "chapter" && S.ch) {
    const n = S.ch.questions.filter((q) => S.ch.answers?.[q.id]?.result).length;
    right += `<span class="mono small muted">${n} of ${S.ch.questions.length} checked</span>`;
    if (!S.tutor.open) right += `<button class="btn" style="color:var(--accent);font-weight:500" data-act="open-tutor">Open tutor</button>`;
  }
  $("#top").innerHTML = `<div class="crumbs">${crumbs.join('<span class="sep">/</span>')}</div><span class="grow"></span>${right}`;
}

function renderMain() {
  const views = { library: viewLibrary, start: viewStart, course: viewCourse, chapter: viewChapter, summary: viewSummary, review: viewReview, settings: viewSettings, profiles: viewProfiles };
  $("#main").innerHTML = profile() || S.route.view === "profiles" ? (views[S.route.view] || viewLibrary)() : viewWelcome();
  afterMain();
}

function afterMain() {
  $$(".code textarea").forEach(sizeCode);
}

// ---- views: profiles --------------------------------------------------------

function profileForm(p = {}) {
  const emoji = p.emoji || EMOJIS[0], color = p.color || COLORS[0];
  return `<form class="stack" data-form="profile" data-id="${esc(p.id || "")}" style="gap:14px">
    <div class="stack"><label class="lbl">Name</label><input class="field" name="name" value="${esc(p.name || "")}" placeholder="e.g. Ava" required></div>
    <div class="stack"><label class="lbl">Avatar</label>
      <div class="emoji-pick">${EMOJIS.map((e) => `<button type="button" class="${e === emoji ? "on" : ""}" data-act="pick-emoji" data-v="${e}">${e}</button>`).join("")}</div>
      <input type="hidden" name="emoji" value="${esc(emoji)}">
      <div class="swatches">${COLORS.map((c) => `<button type="button" class="${c === color ? "on" : ""}" style="background:${c}" data-act="pick-color" data-v="${c}"></button>`).join("")}</div>
      <input type="hidden" name="color" value="${esc(color)}">
    </div>
    <div class="stack"><label class="lbl">About this learner</label>
      <textarea class="field" name="about" rows="3" placeholder="Age, school year or job, interests. The tutor pitches its words, examples and tone to this.">${esc(p.about || "")}</textarea></div>
    <div class="row"><button class="btn primary" type="submit">${p.id ? "Save" : "Create profile"}</button>
      ${p.id ? `<button class="btn" type="button" data-act="cancel-profile">Cancel</button><span class="grow"></span><button class="btn danger" type="button" data-act="del-profile" data-id="${p.id}">Delete</button>` : ""}</div>
  </form>`;
}

function viewWelcome() {
  return `<div class="welcome">
    <span class="eyebrow">Welcome</span>
    <h1 class="title">Who's learning?</h1>
    <p class="lede">Make a profile for each person who uses Margin. Each one gets their own notebooks, XP and streak, and the tutor talks to them at their level.</p>
    <div class="panel">${profileForm()}</div>
  </div>`;
}

function viewProfiles() {
  return `<div class="page narrow">
    <div class="stack"><h1 class="title">Profiles</h1><p class="lede">Switch between learners from the menu at the top of the sidebar.</p></div>
    ${S.profiles.map((p) => S.editingProfile === p.id ? `<div class="panel">${profileForm(p)}</div>` : `
      <div class="panel"><div class="profile-card">
        <span class="avatar" style="background:${p.color || COLORS[0]}26">${esc(p.emoji || "🙂")}</span>
        <div class="stack grow" style="gap:4px"><span class="serif" style="font-size:21px">${esc(p.name)}</span>
          <span class="small muted">Level ${level(p.xp).n} · ${p.xp || 0} XP${p.streak ? ` · 🔥 ${p.streak}-day streak` : ""}</span>
          <span class="small" style="color:var(--ink2)">${esc(p.about || "No description yet.")}</span></div>
        <div class="row">${p.id === S.pid ? `<span class="pill correct">Active</span>` : `<button class="btn sm" data-act="switch" data-id="${p.id}">Switch</button>`}
          <button class="btn sm" data-act="edit-profile" data-id="${p.id}">Edit</button></div>
      </div></div>`).join("")}
    ${S.editingProfile === "new" ? `<div class="panel">${profileForm()}</div>` : `<button class="card new" style="min-height:90px" data-act="edit-profile" data-id="new"><span style="font-size:22px">+</span><span class="small">Add a learner</span></button>`}
  </div>`;
}

// ---- views: library & start ---------------------------------------------------

function viewLibrary() {
  return `<div class="page wide">
    <div class="stack"><h1 class="title">Notebooks</h1><p class="lede">Every course ${esc(profile().name)} builds lives here, with answers, grades and tutor conversations. Open one to pick up where you left off or re-read a lesson.</p></div>
    <div class="cards">
      <button class="card new" data-act="nav" data-to="#/new"><span style="font-size:26px;font-weight:300">+</span><span style="font-size:14px;font-weight:500">New course</span></button>
      ${S.courses.map((c) => {
        const total = c.chapters.reduce((n, x) => n + (x.total || 0), 0);
        const answered = c.chapters.reduce((n, x) => n + (x.answered || 0), 0);
        const done = c.chapters.filter((x) => x.finished).length;
        const status = c.status === "outline" ? "Outline ready" : done === c.chapters.length ? "Complete 🎉" : `${done} of ${c.chapters.length} chapters`;
        return `<div class="card" data-act="nav" data-to="#/c/${c.id}" role="button" tabindex="0" style="cursor:pointer">
          <button class="icon-btn del" data-act="del-course" data-id="${c.id}" title="Delete notebook">✕</button>
          <span class="emoji">${esc(c.emoji || "📘")}</span>
          <span class="serif">${esc(c.title)}</span>
          <span class="bar thick"><span style="width:${total ? Math.round((answered / total) * 100) : 0}%"></span></span>
          <span class="meta"><span>${status}</span><span>${ago(c.updated)}</span></span>
        </div>`;
      }).join("")}
    </div>
  </div>`;
}

function startForm() {
  if (!S.startForm) {
    const cc = S.config.course;
    S.startForm = { topic: "", depth: cc.default_depth, types: [...cc.types], lessons: true, chapters: cc.chapters };
  }
  return S.startForm;
}

function viewStart() {
  const f = startForm(), cc = S.config.course, g = S.gen;
  return `<div class="page" style="max-width:700px;padding-top:64px">
    <div class="stack" style="gap:12px">
      <span class="eyebrow">New course for ${esc(profile().name)}</span>
      <h1 class="title" style="font-size:46px">What do you want to learn?</h1>
      <p class="lede">Describe a topic and, if you like, a goal. The tutor drafts an outline you can edit; each chapter is written when you open it, with a short lesson and practice questions.</p>
    </div>
    <textarea class="topic" rows="3" data-in="topic" placeholder="e.g. Enough linear algebra to read ML papers">${esc(f.topic)}</textarea>
    <div class="stack" style="gap:18px">
      <div class="row" style="gap:32px;align-items:flex-end">
        <div class="stack" style="gap:8px"><span class="small muted">Depth</span>
          <div class="seg">${cc.depths.map((d) => `<button class="${d === f.depth ? "on" : ""}" data-act="depth" data-v="${esc(d)}">${esc(d)}</button>`).join("")}</div></div>
        <div class="stack grow" style="gap:8px;min-width:220px"><span class="small muted">Chapters <b class="mono" data-chapters-out style="color:var(--ink);font-weight:500">${f.chapters}</b></span>
          <input type="range" class="slider" min="1" max="25" step="1" value="${f.chapters}" data-in="chapters"></div>
      </div>
      <div class="stack" style="gap:8px"><span class="small muted">Question types</span>
        <div class="row" style="gap:8px">${Object.keys(TYPE_LABEL).map((t) => `<button class="chip ${f.types.includes(t) ? "on" : ""}" data-act="type" data-v="${t}">${TYPE_LABEL[t]}</button>`).join("")}</div></div>
      <div class="row" style="gap:22px">
        <label class="row" style="gap:10px;font-size:14px;color:var(--ink2);cursor:pointer"><input type="checkbox" data-act="lessons" ${f.lessons ? "checked" : ""} style="accent-color:var(--accent);width:16px;height:16px"> Start each chapter with a short lesson</label>
      </div>
    </div>
    <div class="row" style="gap:14px">
      <button class="btn primary big" data-act="build" ${g && !g.done && !g.error ? "disabled" : ""}>Build outline</button>
      <span class="small muted">Takes a few seconds. You can edit the outline before starting.</span>
    </div>
    ${g ? `<div class="gen">
      <div class="row">${g.error ? `<span class="pill incorrect">Failed</span><span class="small">${esc(g.error)}</span>` : `<span class="pulse"></span><span style="font-size:14px;font-weight:500">${g.titles.length ? "Drafting chapters…" : "Thinking about the topic…"}</span>`}</div>
      ${g.titles.map((t, i) => `<div class="gen-row"><span class="mono small muted">${String(i + 1).padStart(2, "0")}</span><span class="serif">${esc(t)}</span></div>`).join("")}
    </div>` : ""}
    <div class="stack" style="gap:8px;margin-top:6px"><span class="small muted">Or try</span>
      <div class="row" style="gap:8px">${(S.config.suggestions || []).map((s) => `<button class="chip dashed" data-act="suggest" data-v="${esc(s)}">${esc(s)}</button>`).join("")}</div></div>
  </div>`;
}

async function buildCourse() {
  const f = startForm();
  f.topic = $('[data-in="topic"]')?.value.trim() || f.topic;
  if (!f.topic) { toast("Type a topic first"); return; }
  S.gen = { titles: [], done: false };
  renderMain();
  try {
    const course = await sse("/api/courses", { profile: S.pid, topic: f.topic, depth: f.depth, types: f.types, lessons: f.lessons, chapters: f.chapters }, (ev) => {
      if (ev.type === "titles") { S.gen.titles = ev.titles; if (S.route.view === "start") renderMain(); }
    });
    S.gen = null;
    S.startForm = null;
    S.course = course;
    S.editOutline = true;
    S.outline = null;
    await loadCourses();
    go(`#/c/${course.id}`);
    S.editOutline = true;
  } catch (e) {
    S.gen.error = e.message;
    renderMain();
  }
}

// ---- views: course ----------------------------------------------------------

function viewCourse() {
  const c = S.course;
  if (!c) return "";
  if (c.status === "outline" || S.editOutline) return viewOutline(c);
  const total = c.chapters.reduce((n, x) => n + (x.total || 0), 0);
  const answered = c.chapters.reduce((n, x) => n + (x.answered || 0), 0);
  const score = c.chapters.reduce((n, x) => n + (x.score || 0), 0);
  const done = c.chapters.filter((x) => x.finished).length;
  const next = c.chapters.findIndex((x) => !x.finished);
  return `<div class="page mid">
    <div class="stack" style="gap:12px">
      <span class="eyebrow">Notebook · ${esc(c.depth)} · created ${new Date(c.created).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span>
      <h1 class="title"><span style="font-size:.85em">${esc(c.emoji || "")}</span> ${esc(c.title)}</h1>
      <p class="lede">${esc(c.summary)}</p>
    </div>
    <div class="stats">
      <div><span class="serif">${answered ? Math.round((score / answered) * 100) + "%" : "–"}</span><span class="small muted">Average score</span></div>
      <div><span class="serif">${answered}<span class="of"> / ${total || "–"}</span></span><span class="small muted">Questions answered</span></div>
      <div><span class="serif">${done}<span class="of"> / ${c.chapters.length}</span></span><span class="small muted">Chapters complete</span></div>
    </div>
    <div class="stack" style="gap:0">
      <div class="row" style="margin-bottom:8px"><h2 class="sub grow">Chapters</h2><button class="btn sm" data-act="edit-outline">Edit outline</button></div>
      ${c.chapters.map((x, i) => {
        const pct = x.total ? Math.round(((x.answered || 0) / x.total) * 100) : 0;
        const cta = x.status !== "ready" ? (i === next ? "Start" : "Open") : x.finished ? "Re-read" : x.answered ? "Continue" : "Start";
        const primary = i === next;
        return `<div class="ch-row" style="opacity:${x.status !== "ready" && i > next && next >= 0 ? 0.65 : 1}">
          <span class="mono small muted">${String(i + 1).padStart(2, "0")}</span>
          <div class="stack" style="gap:4px;min-width:0"><span class="serif">${esc(x.title)}</span><span class="desc">${esc(x.desc)}</span></div>
          <div class="stack" style="gap:6px"><span class="bar thick"><span style="width:${pct}%;background:${x.finished ? "var(--good)" : "var(--accent)"}"></span></span>
            <span class="small muted">${x.status !== "ready" ? "Not written yet" : `${x.answered || 0} of ${x.total} answered${x.finished ? ` · ${x.score}/${x.total}` : ""}`}</span></div>
          <button class="btn ${primary ? "primary" : ""} sm" data-act="nav" data-to="#/c/${c.id}/${x.id}">${cta}</button>
        </div>`;
      }).join("")}
    </div>
  </div>`;
}

function viewOutline(c) {
  if (!S.outline) S.outline = { title: c.title, summary: c.summary, chapters: c.chapters.map((x) => ({ ...x })) };
  const o = S.outline;
  const starting = c.status === "outline";
  return `<div class="page mid">
    <div class="stack" style="gap:12px">
      <span class="eyebrow">${starting ? "Outline · edit anything, then start" : "Editing outline"}</span>
      <input class="title" data-in="ol-course-title" value="${esc(o.title)}" style="font-family:var(--serif);font-size:40px;border:none;background:transparent;padding:0;width:100%">
      <textarea class="lede" data-in="ol-summary" rows="3" style="border:none;background:transparent;resize:none;width:100%;max-width:none;padding:0">${esc(o.summary)}</textarea>
    </div>
    <div class="stack" style="gap:0">
      ${o.chapters.map((x, i) => `<div class="outline-row">
        <span class="mono small muted" style="padding-top:6px">${String(i + 1).padStart(2, "0")}</span>
        <div class="stack" style="gap:2px">
          <input class="t" data-in="ol-title" data-k="${i}" value="${esc(x.title)}" placeholder="Chapter title">
          <textarea class="d" data-in="ol-desc" data-k="${i}" rows="2" placeholder="What this chapter teaches">${esc(x.desc)}</textarea>
          ${x.status === "ready" ? `<span class="small muted">Already written${x.answered ? `, ${x.answered} answered` : ""}</span>` : ""}
        </div>
        <div class="row" style="gap:0;flex-wrap:nowrap">
          <button class="icon-btn" data-act="ol-move" data-k="${i}" data-d="-1" ${i === 0 ? "disabled" : ""} title="Move up">↑</button>
          <button class="icon-btn" data-act="ol-move" data-k="${i}" data-d="1" ${i === o.chapters.length - 1 ? "disabled" : ""} title="Move down">↓</button>
          <button class="icon-btn" data-act="ol-del" data-k="${i}" title="Remove">✕</button>
        </div>
      </div>`).join("")}
      <div style="padding-top:12px"><button class="btn sm" data-act="ol-add">+ Add chapter</button></div>
    </div>
    <div class="row" style="gap:12px">
      <button class="btn primary big" data-act="ol-save">${starting ? "Start course →" : "Save outline"}</button>
      ${starting ? "" : `<button class="btn" data-act="ol-cancel">Cancel</button>`}
      <span class="small muted">${starting ? "Chapters are written one at a time as you open them, so later ones can adapt to how you're doing." : ""}</span>
    </div>
  </div>`;
}

async function saveOutline() {
  const o = S.outline, c = S.course;
  const removed = c.chapters.filter((x) => x.status === "ready" && !o.chapters.some((y) => y.id === x.id));
  if (removed.length && !confirm(`Remove ${removed.map((x) => `"${x.title}"`).join(", ")}? Its lesson, answers and tutor notes will be deleted.`)) return;
  try {
    const starting = c.status === "outline";
    S.course = await api("PUT", `/api/courses/${c.id}`, { title: o.title, summary: o.summary, chapters: o.chapters.filter((x) => x.title.trim()), status: "active" });
    S.outline = null;
    S.editOutline = false;
    if (starting && S.course.chapters[0]) go(`#/c/${c.id}/${S.course.chapters[0].id}`);
    else renderAll();
  } catch (e) { fail(e); }
}

// ---- views: chapter ---------------------------------------------------------

async function generateChapter(cid, chid, force = false) {
  const key = `${cid}/${chid}`;
  if (S.chGen[key] && !S.chGen[key].error) return;
  S.chGen[key] = { chars: 0, questions: 0 };
  renderMain();
  try {
    const ch = await sse(`/api/courses/${cid}/ch/${chid}/generate`, { force }, (ev) => {
      if (ev.type === "progress") {
        Object.assign(S.chGen[key], ev);
        const el = $("#gen-status");
        if (el) el.textContent = genLabel(S.chGen[key]);
      }
    });
    delete S.chGen[key];
    S.course = await api("GET", `/api/courses/${cid}`);
    if (S.route.cid === cid && S.route.chid === chid) {
      S.ch = ch; S.chCourse = cid; seedDrafts();
      renderAll();
    }
  } catch (e) {
    S.chGen[key].error = e.message;
    if (S.route.chid === chid) renderMain();
  }
}

function genLabel(g) {
  if (!g.chars) return "Planning the chapter…";
  if (!g.questions) return `Writing the lesson… (${Math.round(g.chars / 1000)}k characters)`;
  return `Writing question ${g.questions} of ${S.course?.questions || "?"}…`;
}

function viewChapter() {
  const c = S.course, r = S.route;
  const i = c.chapters.findIndex((x) => x.id === r.chid);
  const entry = c.chapters[i];
  if (!entry) return `<div class="page narrow"><p>That chapter isn't in this course any more.</p></div>`;
  const head = `<div class="stack"><span class="eyebrow">Chapter ${i + 1} of ${c.chapters.length}</span><h1 class="title" style="font-size:40px">${esc(entry.title)}</h1></div>`;
  if (!S.ch) {
    const g = S.chGen[`${c.id}/${entry.id}`] || {};
    return `<div class="page narrow">${head}
      <div class="writing">${g.error
        ? `<span class="big" style="animation:none">😵</span><span>Couldn't write this chapter: ${esc(g.error)}</span><button class="btn primary" data-act="regen">Try again</button>`
        : `<span class="big">${esc(c.emoji || "✏️")}</span><span class="serif" style="font-size:20px">Writing this chapter for ${esc(profile()?.name || "you")}</span><span class="small muted" id="gen-status">${genLabel(g)}</span>`}</div></div>`;
  }
  const ch = S.ch;
  const lessonOpen = S.lessonOpen ?? true;
  const checked = ch.questions.filter((q) => ch.answers?.[q.id]?.result).length;
  return `<div class="page narrow" style="padding-top:44px;gap:22px">
    ${head}
    ${ch.lesson ? `<div class="lesson-box">
      <div class="row"><span class="small" style="font-weight:600;color:var(--ink2)">Lesson</span>${ch.minutes ? `<span class="small muted">${ch.minutes} min read</span>` : ""}
        <span class="grow"></span><button class="btn link" data-act="ask-lesson">Ask about the lesson</button><button class="btn link" data-act="toggle-lesson">${lessonOpen ? "Hide lesson" : "Show lesson"}</button></div>
      ${lessonOpen ? `<div class="prose">${md(ch.lesson)}</div>` : ""}
    </div>` : ""}
    <div class="row" style="align-items:baseline;gap:12px;margin-top:8px"><h2 class="sub" style="font-size:24px">Questions</h2>
      <span class="small muted">Check each answer as you go. Hints are free, and the tutor can see the question you're on.</span></div>
    ${ch.questions.map((q) => `<div class="q ${S.activeQ === q.id ? "active" : ""}" id="q-${q.id}" data-card="${q.id}">${cardInner(q)}</div>`).join("")}
    <div class="finish">
      <div class="stack grow" style="gap:2px"><span style="font-size:14px;font-weight:500">${checked} of ${ch.questions.length} checked</span>
        <span class="small muted">Answers, grades and tutor threads save to this notebook automatically.</span></div>
      <button class="btn primary" data-act="finish">${ch.finished ? "See summary" : "Finish chapter"}</button>
    </div>
  </div>`;
}

// ---- question cards ---------------------------------------------------------

const dkey = (qid) => `${S.course.id}/${S.ch.id}/${qid}`;
const saved = (qid) => S.ch.answers?.[qid];

function emptyValue(q) {
  return { mcq: { choice: null }, fill: { blanks: q.blanks?.map(() => "") || [] }, free: { text: "" },
    math: { working: [""], final: "" }, python: { code: q.starter || "" } }[q.type];
}

function seedDrafts() {
  for (const q of S.ch.questions) {
    const k = dkey(q.id);
    if (!S.drafts[k]) S.drafts[k] = structuredClone(saved(q.id)?.value || emptyValue(q));
    if (S.hints[k] == null) S.hints[k] = saved(q.id)?.hints || 0;
  }
}

const draft = (qid) => S.drafts[dkey(qid)];

function cardInner(q) {
  const k = dkey(q.id), a = saved(q.id), d = draft(q.id);
  const res = S.grading[k] ? { status: "grading" } : a?.result;
  const shown = S.hints[k] || 0;
  const canSolve = (a?.attempts || shown >= q.hints.length) && !S.solution[k];
  const checkLabel = { mcq: "Check answer", fill: "Check answer", free: "Submit for grading", math: "Check", python: "Submit" }[q.type];
  return `
    <div class="q-head">
      <span class="mono small muted">${q.id.toUpperCase()}</span>
      <span class="q-type">${TYPE_LABEL[q.type]}${q.type === "free" ? " · AI graded" : ""}${q.type === "math" && q.working ? " · show your working" : ""}</span>
      ${q.added ? `<span class="badge-new">added by tutor</span>` : ""}
      <span class="grow"></span>${pill(res?.status)}
      <button class="btn link" data-act="ask" data-q="${q.id}">Ask tutor</button>
    </div>
    ${q.type === "fill" && q.prompt.includes("[[") ? "" : `<div class="q-prompt">${md(q.prompt)}</div>`}
    ${body(q, d, a)}
    <div class="row">
      ${q.type === "python" ? `<button class="btn" data-act="run" data-q="${q.id}" ${S.running[k] ? "disabled" : ""}>▸ Run tests</button>` : ""}
      <button class="btn primary" data-act="check" data-q="${q.id}" ${S.grading[k] || S.running[k] ? "disabled" : ""}>${checkLabel}</button>
      ${q.hints.length ? `<button class="btn" data-act="hint" data-q="${q.id}" ${shown >= q.hints.length ? "disabled" : ""}>${shown ? `Another hint (${shown}/${q.hints.length})` : "Get a hint"}</button>` : ""}
      ${canSolve && q.solution ? `<button class="btn link" data-act="solution" data-q="${q.id}">Show solution</button>` : ""}
    </div>
    ${shown ? `<div class="hints">${q.hints.slice(0, shown).map((h, i) => `<div class="hint"><b>Hint ${i + 1}</b>${md(h, true)}</div>`).join("")}</div>` : ""}
    ${S.pyOut[k] ? `<div class="out">${S.pyOut[k]}</div>` : ""}
    ${res && res.status !== "grading" ? feedback(res) : ""}
    ${S.solution[k] ? `<div class="solution"><div class="small muted" style="margin-bottom:4px">Solution</div><div class="prose sm">${md(q.solution)}</div></div>` : ""}`;
}

function body(q, d, a) {
  const res = a?.result;
  if (q.type === "mcq") {
    const judged = res && a.value?.choice === d.choice;
    return `<div class="opts">${q.options.map((o, i) => {
      let cls = d.choice === i ? "picked" : "";
      if (judged && d.choice === i) cls = res.status === "correct" ? "right" : "wrong";
      return `<button class="opt ${cls}" data-act="pick" data-q="${q.id}" data-i="${i}"><span class="letter">${"ABCDEFGH"[i]}</span><span class="lab">${md(o, true)}</span></button>`;
    }).join("")}</div>`;
  }
  if (q.type === "fill") {
    const parts = q.template.split(/\[\[(\d+)\]\]/);
    let html = "", b = 0;
    parts.forEach((p, i) => {
      if (i % 2 === 0) { html += md(p, true); return; }
      const ok = res?.blanks && JSON.stringify(a.value?.blanks) === JSON.stringify(d.blanks) ? (res.blanks[b] ? "right" : "wrong") : "";
      const w = Math.max(4, ...q.blanks[b].map((x) => x.length)) + 2;
      html += `<input class="${ok}" style="width:${w}ch" data-in="blank" data-q="${q.id}" data-k="${b}" value="${esc(d.blanks[b] || "")}" placeholder="?" autocomplete="off" spellcheck="false">`;
      b++;
    });
    return `<div class="fill">${html}</div>`;
  }
  if (q.type === "free") {
    const words = (d.text.match(/\S+/g) || []).length;
    return `<div class="stack" style="gap:6px"><textarea class="answer-area" rows="5" data-in="free" data-q="${q.id}" placeholder="Write your answer in your own words…">${esc(d.text)}</textarea>
      <span class="small muted" style="align-self:flex-end" data-words="${q.id}">${words} words</span></div>`;
  }
  if (q.type === "math") {
    const steps = q.working ? `<div class="stack" style="gap:6px"><span class="small muted">Working, one step per line</span>
      <div class="steps">${d.working.map((w, i) => `<div class="step"><span class="n">${i + 1}</span><math-field data-in="step" data-q="${q.id}" data-k="${i}">${esc(w)}</math-field>
        <button class="icon-btn" data-act="del-step" data-q="${q.id}" data-k="${i}" title="Remove step" ${d.working.length < 2 ? "disabled" : ""}>✕</button></div>`).join("")}</div>
      <button class="btn sm" style="align-self:flex-start" data-act="add-step" data-q="${q.id}">+ Add step</button></div>` : "";
    return `${steps}<div class="final">${q.answer_label ? md(q.answer_label, true) : "Answer:"}<math-field data-in="final" data-q="${q.id}">${esc(d.final)}</math-field></div>`;
  }
  if (q.type === "python") {
    return `<div class="code"><div class="nums" data-nums="${q.id}"></div><textarea data-in="code" data-q="${q.id}" spellcheck="false" wrap="off">${esc(d.code)}</textarea></div>`;
  }
  return "";
}

function feedback(res) {
  let extra = "";
  if (res.rubric?.length) extra = `<div class="checks">${res.rubric.map((r) => `<div><span class="${r.met ? "y" : "x"}">${r.met ? "✓" : "✗"}</span><span>${md(r.point, true)}</span><span></span></div>`).join("")}</div>`;
  if (res.steps?.length) extra = `<div class="checks">${res.steps.map((s) => `<div><span class="${s.ok ? "y" : "x"}">${s.ok ? "✓" : "✗"}</span><span class="mono" style="font-size:13px">${md(s.text, true)}</span><span class="muted" style="font-size:12.5px">${md(s.note || "", true)}</span></div>`).join("")}</div>`;
  return `<div class="feedback ${res.status}"><div>${md(res.feedback || "", true)}</div>${extra}</div>`;
}

function renderCard(qid) {
  const el = $(`[data-card="${qid}"]`);
  const q = S.ch?.questions.find((x) => x.id === qid);
  if (!el || !q) return;
  el.innerHTML = cardInner(q);
  el.classList.toggle("active", S.activeQ === qid);
  $$(".code textarea", el).forEach(sizeCode);
}

function sizeCode(ta) {
  const lines = ta.value.split("\n").length;
  ta.rows = Math.max(lines + 1, 6);
  const nums = ta.parentElement.querySelector(".nums");
  if (nums) nums.textContent = Array.from({ length: Math.max(lines, 1) }, (_, i) => i + 1).join("\n");
}

const autosave = debounce(async (qid, chid, cid) => {
  if (S.ch?.id !== chid) return;
  try { await api("PUT", `/api/courses/${cid}/ch/${chid}/answers/${qid}`, { value: draft(qid) }); } catch (e) { console.warn(e); }
}, 900);

const norm = (s) => String(s ?? "").toLowerCase().replace(/\s+/g, "").replace(/[−–]/g, "-").replace(/\*\*/g, "^").replace(/[′']/g, "").replace(/\.$/, "");
function sameAnswer(given, accepted) {
  const g = norm(given);
  if (!g) return false;
  return accepted.some((a) => { const n = norm(a); return n === g || (!isNaN(+n) && !isNaN(+g) && Math.abs(+n - +g) < 1e-9); });
}

async function check(qid) {
  const q = S.ch.questions.find((x) => x.id === qid), d = draft(qid), k = dkey(qid);
  const { id: cid } = S.course, chid = S.ch.id;
  let result;
  try {
    if (q.type === "mcq") {
      if (d.choice == null) return toast("Pick an answer first");
      result = d.choice === q.correct
        ? { status: "correct", feedback: CHEERS[Math.floor(Math.random() * CHEERS.length)] }
        : { status: "incorrect", feedback: "Not quite. Have another go, or grab a hint." };
    } else if (q.type === "fill") {
      if (d.blanks.every((b) => !b.trim())) return toast("Fill in the blanks first");
      const ok = q.blanks.map((acc, i) => sameAnswer(d.blanks[i], acc));
      const n = ok.filter(Boolean).length;
      result = { status: n === ok.length ? "correct" : n ? "partial" : "incorrect", blanks: ok,
        feedback: n === ok.length ? CHEERS[Math.floor(Math.random() * CHEERS.length)] : n ? `${n} of ${ok.length} blanks right. The red ones need another look.` : "Not quite. A hint might help." };
    } else if (q.type === "python") {
      const run = await runTests(qid);
      if (!run) return;
      const pass = run.results.filter((r) => r.ok).length, total = run.results.length;
      result = run.error || !total
        ? { status: "incorrect", feedback: "Your code raised an error before the tests could finish. Check the output above." }
        : { status: pass === total ? "correct" : pass ? "partial" : "incorrect",
            feedback: pass === total ? `All ${total} tests pass. ${CHEERS[Math.floor(Math.random() * CHEERS.length)]}` : `${pass} of ${total} tests pass.` };
    } else {
      if (q.type === "free" && !d.text.trim()) return toast("Write an answer first");
      if (q.type === "math" && !d.final.trim()) return toast("Enter your final answer first");
      S.grading[k] = true;
      renderCard(qid);
      const out = await api("POST", `/api/courses/${cid}/ch/${chid}/grade/${qid}`, { value: d });
      delete S.grading[k];
      return applyAnswer(qid, chid, out);
    }
    const out = await api("PUT", `/api/courses/${cid}/ch/${chid}/answers/${qid}`, { value: d, result });
    applyAnswer(qid, chid, out);
  } catch (e) {
    delete S.grading[k];
    renderCard(qid);
    fail(e);
  }
}

function applyAnswer(qid, chid, out) {
  if (S.ch?.id !== chid) return;
  S.ch.answers = S.ch.answers || {};
  S.ch.answers[qid] = out.answer;
  updateProfile(out.profile);
  const entry = S.course.chapters.find((x) => x.id === chid);
  if (entry) {
    const graded = S.ch.questions.map((q) => S.ch.answers[q.id]?.result?.status).filter(Boolean);
    entry.answered = graded.length;
    entry.score = graded.reduce((n, s) => n + (s === "correct" ? 1 : s === "partial" ? 0.5 : 0), 0);
    entry.missed = graded.filter((s) => s !== "correct").length;
  }
  renderCard(qid);
  renderSide();
  renderTop();
  if (out.answer.result?.status === "correct") celebrate();
  if (out.xp) toast(`+${out.xp} XP`, "xp");
}

function updateProfile(p) {
  if (!p) return;
  const i = S.profiles.findIndex((x) => x.id === p.id);
  if (i >= 0) S.profiles[i] = p;
}

// ---- python -----------------------------------------------------------------

let worker = null, runSeq = 0;

function runTests(qid) {
  const q = S.ch.questions.find((x) => x.id === qid), k = dkey(qid);
  S.running[k] = true;
  S.pyOut[k] = worker ? "Running…" : "Loading Python (first run downloads ~10 MB)…";
  renderCard(qid);
  if (!worker) worker = new Worker("/pyworker.js");
  const id = ++runSeq, w = worker;
  return new Promise((resolve) => {
    let timer;
    const finish = (res) => {
      clearTimeout(timer);
      w.removeEventListener("message", onMsg);
      delete S.running[k];
      S.pyOut[k] = formatRun(res);
      renderCard(qid);
      resolve(res);
    };
    const onMsg = (e) => {
      if (e.data.id !== id) return;
      if (e.data.status === "loading") { S.pyOut[k] = "Loading packages…"; renderCard(qid); }
      else if (e.data.status === "running") {
        timer = setTimeout(() => {
          w.terminate();
          if (worker === w) worker = null;
          finish({ results: [], stdout: "", error: "Stopped after 15 seconds. Is there an infinite loop?" });
        }, 15000);
      } else if (e.data.status === "done") finish(e.data);
    };
    w.addEventListener("message", onMsg);
    w.postMessage({ id, code: draft(qid).code, tests: q.tests });
  });
}

function formatRun(res) {
  let html = res.results.map((r) => r.ok ? `<span class="ok">✓ ${esc(r.name)}</span>` : `<span class="no">✗ ${esc(r.name)}: ${esc(r.msg)}</span>`).join("\n");
  if (res.stdout?.trim()) html += `${html ? "\n\n" : ""}${esc(res.stdout.trimEnd())}`;
  if (res.error) html += `${html ? "\n\n" : ""}<span class="no">${esc(res.error.trimEnd())}</span>`;
  return html || "No tests ran.";
}

// ---- summary & review -------------------------------------------------------

function viewSummary() {
  const c = S.course, ch = S.ch;
  if (!ch) return "";
  const i = c.chapters.findIndex((x) => x.id === ch.id);
  const rows = ch.questions.map((q) => ({ q, a: ch.answers?.[q.id] }));
  const score = rows.reduce((n, r) => n + (r.a?.result?.status === "correct" ? 1 : r.a?.result?.status === "partial" ? 0.5 : 0), 0);
  const pct = ch.questions.length ? Math.round((score / ch.questions.length) * 100) : 0;
  const verdict = pct >= 90 ? "Superb! 🏆" : pct >= 70 ? "Solid work 💪" : pct >= 40 ? "Getting there 🌱" : "Worth another pass 🔁";
  const concepts = [...new Set(rows.filter((r) => r.a?.result && r.a.result.status !== "correct" && r.q.concept).map((r) => r.q.concept))];
  const next = c.chapters[i + 1];
  return `<div class="page" style="max-width:780px;gap:28px">
    <div class="stack"><span class="eyebrow">Chapter ${i + 1} · Summary</span><h1 class="title" style="font-size:40px">${esc(ch.title)}</h1></div>
    <div class="row" style="align-items:flex-end;gap:24px;padding-bottom:24px;border-bottom:1px solid var(--line)">
      <div class="score">${score}<span> / ${ch.questions.length}</span></div>
      <div class="stack" style="gap:4px;padding-bottom:6px"><span style="font-size:17px;font-weight:500">${pct}% · ${verdict}</span>
        <span class="small muted">Partial credit counts as half, and hints never cost points.</span></div>
    </div>
    <div class="stack" style="gap:0">${rows.map(({ q, a }) => `<div class="sum-row">
      <span class="mono small muted" style="padding-top:3px">${q.id.toUpperCase()}</span>
      <div class="stack" style="gap:5px;min-width:0"><span class="q-type">${TYPE_LABEL[q.type]}</span>
        <span class="serif" style="font-size:17px;line-height:1.4">${md(q.prompt, true)}</span>
        ${a?.result?.feedback ? `<span class="small" style="color:var(--ink2);line-height:1.5">${md(a.result.feedback, true)}</span>` : ""}</div>
      <span>${pill(a?.result?.status) || `<span class="small muted">Skipped</span>`}</span>
      <button class="btn sm" data-act="nav" data-to="#/c/${c.id}/${ch.id}/${q.id}">Revisit</button>
    </div>`).join("")}</div>
    <div class="stack"><span style="font-size:14px;font-weight:600">Concepts to revisit</span>
      ${concepts.length ? `<div class="row" style="gap:8px">${concepts.map((x) => `<span class="tag">${esc(x)}</span>`).join("")}</div>` : `<span class="small muted">Nothing. Everything you answered was right.</span>`}</div>
    <div class="row">
      ${next ? `<button class="btn primary" data-act="nav" data-to="#/c/${c.id}/${next.id}">Continue to Chapter ${i + 2} →</button>` : `<button class="btn primary" data-act="nav" data-to="#/c/${c.id}">Back to the course</button>`}
      <button class="btn" data-act="nav" data-to="#/c/${c.id}/${ch.id}">Re-read the chapter</button>
    </div>
  </div>`;
}

async function loadReview() {
  S.review = null;
  try {
    await loadCourses();
    const items = [];
    await Promise.all(S.courses.flatMap((c) => c.chapters.filter((x) => x.missed).map(async (x) => {
      const ch = await api("GET", `/api/courses/${c.id}/ch/${x.id}`);
      for (const q of ch.questions) {
        const a = ch.answers?.[q.id];
        if (a?.result && a.result.status !== "correct") items.push({ c, x, q, a, at: a.at });
      }
    })));
    S.review = items.sort((a, b) => b.at - a.at);
  } catch (e) { fail(e); S.review = []; }
  if (S.route.view === "review") { renderMain(); renderSide(); }
}

function answerText(q, v) {
  if (!v) return "";
  if (q.type === "mcq") return v.choice == null ? "" : md(q.options[v.choice], true);
  if (q.type === "fill") return esc(v.blanks.join("  ·  "));
  if (q.type === "free") return esc(v.text);
  if (q.type === "math") return [...(v.working || []).filter(Boolean), v.final].filter(Boolean).map((l) => tex(l)).join("<br>");
  if (q.type === "python") return `<pre class="mono" style="margin:0;font-size:12.5px;white-space:pre-wrap">${esc(v.code)}</pre>`;
  return "";
}

function viewReview() {
  const items = S.review;
  return `<div class="page narrow" style="gap:22px">
    <div class="stack"><h1 class="title">Review mistakes</h1>
      <p class="lede">Questions ${esc(profile().name)} missed or got partly right, newest first. Open one in its chapter to try again, or ask the tutor what went wrong.</p></div>
    ${items == null ? `<div class="row"><span class="pulse"></span><span class="small muted">Gathering…</span></div>`
      : !items.length ? `<div class="panel" style="align-items:center;text-align:center;padding:40px"><span style="font-size:40px">🌟</span><span class="serif" style="font-size:21px">Nothing to review</span><span class="small muted">Every checked answer is correct.</span></div>`
      : items.map(({ c, x, q, a }) => `<div class="review-item">
        <div class="row"><span class="mono small muted">${esc(c.emoji || "")} ${esc(c.title)} · ${esc(x.title)} · ${q.id.toUpperCase()}</span><span class="grow"></span>${pill(a.result.status)}</div>
        <div class="q-prompt" style="font-size:19px">${md(q.prompt)}</div>
        <div class="stack" style="gap:4px"><span class="small muted">Your answer</span><div style="font-size:15px">${answerText(q, a.value)}</div></div>
        ${a.result.feedback ? `<div class="small" style="color:var(--ink2);line-height:1.55">${md(a.result.feedback, true)}</div>` : ""}
        <div class="row"><button class="btn primary sm" data-act="nav" data-to="#/c/${c.id}/${x.id}/${q.id}">Retry in chapter</button>
          <button class="btn sm" style="color:var(--accent)" data-act="ask-why" data-c="${c.id}" data-x="${x.id}" data-q="${q.id}">Ask tutor why</button></div>
      </div>`).join("")}
  </div>`;
}

// ---- settings -----------------------------------------------------------------

function effortOptions(model, current) {
  const list = model.startsWith("claude:") ? CLAUDE_EFFORT : PI_THINKING;
  return list.map((e) => `<option value="${e}" ${e === (current || "") ? "selected" : ""}>${e || "default"}</option>`).join("");
}

function viewSettings() {
  const cfg = S.config, tasks = cfg.tasks;
  const models = cfg.models;
  const groups = [["Claude (via Claude Code, your subscription)", models.filter((m) => m.backend === "claude")], ["Pi", models.filter((m) => m.backend === "pi")]];
  const modelSelect = (task, cur) => `<select data-set="model" data-task="${task}">
    ${groups.filter(([, ms]) => ms.length).map(([label, ms]) => `<optgroup label="${esc(label)}">${ms.map((m) => `<option value="${esc(m.id)}" ${m.id === cur ? "selected" : ""}>${esc(m.label)}</option>`).join("")}</optgroup>`).join("")}
    ${models.some((m) => m.id === cur) ? "" : `<option value="${esc(cur)}" selected>${esc(cur)} (unavailable)</option>`}
  </select>`;
  const desc = { outline: "Course outlines", chapter: "Lessons & questions", grade: "Grading free-form & math", tutor: "Tutor chat" };
  const p = S.prompts?.find((x) => x.name === S.promptSel);
  return `<div class="page mid">
    <div class="stack"><h1 class="title">Settings</h1><p class="lede">Saved to <span class="mono small">${esc(cfg.data)}/config.json</span> and <span class="mono small">prompts/</span>, so they survive app updates. Claude models always run through Claude Code on your subscription, never the paid API.</p></div>
    <div class="panel"><h2 class="sub">Models</h2>
      <div class="task-grid">
        <span class="small muted">Task</span><span class="small muted">Model</span><span class="small muted">Effort</span><span class="small muted">Timeout (s)</span>
        ${Object.keys(desc).map((t) => `<span class="small" title="${esc(desc[t])}">${esc(desc[t])}</span>${modelSelect(t, tasks[t].model)}
          <select data-set="effort" data-task="${t}">${effortOptions(tasks[t].model, tasks[t].effort)}</select>
          <input type="number" min="20" max="1800" data-set="timeout" data-task="${t}" value="${tasks[t].timeout}">`).join("")}
      </div>
      <span class="small muted">Cheapest setup: a small model (Claude haiku, or a local LM Studio model through Pi) for tutor chat and grading, and a stronger one for writing chapters.</span>
    </div>
    <div class="panel"><h2 class="sub">Courses</h2>
      <div class="row" style="gap:18px">
        <label class="row small">Chapters <input class="field" type="number" min="1" max="25" data-set="chapters" value="${cfg.course.chapters}" style="width:70px"></label>
        <label class="row small">Questions per chapter <input class="field" type="number" min="1" max="15" data-set="questions" value="${cfg.course.questions_per_chapter}" style="width:70px"></label>
        <label class="row small">Default depth <select class="field" data-set="depth" style="width:auto">${cfg.course.depths.map((d) => `<option ${d === cfg.course.default_depth ? "selected" : ""}>${esc(d)}</option>`).join("")}</select></label>
      </div>
      <div class="stack"><label class="lbl">Suggestions on the New course page (one per line)</label><textarea class="field" rows="4" data-set="suggestions">${esc((cfg.suggestions || []).join("\n"))}</textarea></div>
    </div>
    <div class="panel"><h2 class="sub">Fun</h2>
      <div class="row" style="gap:18px">
        <label class="row small" style="cursor:pointer"><input type="checkbox" data-set="confetti" ${cfg.fun.confetti ? "checked" : ""}> Confetti on correct answers</label>
        ${["correct", "partial", "attempt", "chapter"].map((k) => `<label class="row small">XP ${k} <input class="field" type="number" min="0" max="1000" data-set="xp-${k}" value="${cfg.fun.xp[k]}" style="width:70px"></label>`).join("")}
      </div>
    </div>
    <div class="row"><button class="btn primary" data-act="save-settings">Save settings</button></div>
    <div class="panel"><h2 class="sub">Prompts</h2>
      <div class="row" style="gap:6px">${(S.prompts || []).map((x) => `<button class="chip ${x.name === S.promptSel ? "on" : ""}" data-act="prompt-sel" data-v="${x.name}">${x.name}${x.overridden ? " •" : ""}</button>`).join("")}</div>
      ${p ? `<span class="small muted">${p.overridden ? "Customised (•). Reset to go back to the shipped version." : "Shipped default."} Placeholders like <span class="mono">{{learner}}</span> are filled in by the app.</span>
        <textarea class="prompt-edit" id="prompt-text" spellcheck="false">${esc(p.text)}</textarea>
        <div class="row"><button class="btn primary" data-act="save-prompt">Save prompt</button>${p.overridden ? `<button class="btn" data-act="reset-prompt">Reset to default</button>` : ""}</div>` : ""}
    </div>
  </div>`;
}

async function saveSettings() {
  const v = (sel) => $(`[data-set="${sel}"]`);
  const tasks = {};
  for (const t of ["outline", "chapter", "grade", "tutor"]) {
    tasks[t] = { model: $(`[data-set="model"][data-task="${t}"]`).value, effort: $(`[data-set="effort"][data-task="${t}"]`).value,
      timeout: +$(`[data-set="timeout"][data-task="${t}"]`).value || 180 };
  }
  const xp = {};
  for (const k of ["correct", "partial", "attempt", "chapter"]) xp[k] = +v(`xp-${k}`).value || 0;
  try {
    S.config = await api("PUT", "/api/settings", {
      tasks,
      course: { chapters: +v("chapters").value || 6, questions_per_chapter: +v("questions").value || 5, default_depth: v("depth").value },
      fun: { confetti: v("confetti").checked, xp },
      suggestions: v("suggestions").value.split("\n").map((s) => s.trim()).filter(Boolean),
    });
    S.startForm = null;
    toast("Settings saved");
    renderMain();
  } catch (e) { fail(e); }
}

// ---- tutor panel ------------------------------------------------------------

function openTutor(qid) {
  S.tutor.open = true;
  S.tutor.qid = qid || S.activeQ || "lesson";
  if (qid && qid !== "lesson") setActive(qid);
  renderTutor();
  renderTop();
  setTimeout(() => $("#tutor textarea")?.focus(), 30);
}

function setActive(qid) {
  if (S.activeQ === qid) return;
  const prev = S.activeQ;
  S.activeQ = qid;
  $(`[data-card="${prev}"]`)?.classList.remove("active");
  $(`[data-card="${qid}"]`)?.classList.add("active");
  $$(".side-q").forEach((b) => b.classList.toggle("on", b.dataset.q === qid));
  if (S.tutor.open && !S.tutor.pending && S.tutor.qid !== qid) { S.tutor.qid = qid; renderTutor(); }
}

const stripActions = (t) => t.replace(/```action[\s\S]*?(```|$)/g, "").trim();

function renderTutor() {
  const el = $("#tutor");
  const t = S.tutor;
  if (!t.open || S.route.view !== "chapter" || !S.ch) { el.hidden = true; return; }
  el.hidden = false;
  const q = S.ch.questions.find((x) => x.id === t.qid);
  const thread = S.ch.chats?.[t.qid] || [];
  const label = q ? `${q.id.toUpperCase()} · ${TYPE_LABEL[q.type]}` : "Lesson";
  const ctx = q ? q.prompt : S.ch.title;
  const msg = (m) => m.role === "user" ? `<div class="t-user">${esc(m.text)}</div>`
    : `<div class="t-ai"><div class="who">TUTOR</div><div class="prose">${md(m.text)}</div>${(m.actions || []).map((a) => `<div class="t-act">✓ ${esc(a)}</div>`).join("")}</div>`;
  let pending = "";
  if (t.pending) {
    pending = `<div class="t-user">${esc(t.pending.user)}</div><div class="t-ai"><div class="who">TUTOR</div><div class="prose" id="t-stream">${t.pending.reply ? md(stripActions(t.pending.reply)) : `<span class="small muted">Thinking…</span>`}</div>
      <div id="t-acts">${t.pending.actions.map((a) => `<div class="t-act ${a.cls}">${esc(a.text)}</div>`).join("")}</div></div>`;
  }
  el.innerHTML = `
    <div class="t-head">
      <div class="row"><span class="serif" style="font-size:19px;font-weight:500">Tutor</span><span class="grow"></span><button class="icon-btn" data-act="close-tutor" title="Close">✕</button></div>
      <div class="t-ctx"><span class="eyebrow">${esc(label)}</span><span class="p">${esc(ctx.replace(/[$*_`#]/g, ""))}</span></div>
    </div>
    <div class="t-msgs" id="t-msgs">
      ${!thread.length && !t.pending ? `<span class="small muted" style="line-height:1.55">Ask anything about ${q ? "this question" : "the lesson"}. The tutor sees ${q ? "the question and your current answer" : "the lesson"}, and gives hints before solutions. It can also add questions, rewrite the lesson or add chapters if you ask.</span>` : ""}
      ${thread.map(msg).join("")}${pending}
    </div>
    <div class="t-quick">${(q ? QUICK_Q : QUICK_LESSON).map((s) => `<button data-act="quick" data-v="${esc(s)}" ${t.pending ? "disabled" : ""}>${esc(s)}</button>`).join("")}</div>
    <div class="t-input"><textarea rows="2" id="t-input" placeholder="Ask about ${q ? "this question" : "the lesson"}…" ${t.pending ? "disabled" : ""}></textarea>
      <button class="btn primary" data-act="send" ${t.pending ? "disabled" : ""}>Send</button></div>`;
  const box = $("#t-msgs");
  box.scrollTop = box.scrollHeight;
}

async function sendTutor(text) {
  text = (text || "").trim();
  if (!text || S.tutor.pending || !S.ch) return;
  const qid = S.tutor.qid, cid = S.course.id, chid = S.ch.id;
  const current = qid !== "lesson" ? draft(qid) : null;
  S.tutor.pending = { user: text, reply: "", actions: [] };
  renderTutor();
  let changed = false;
  try {
    await sse(`/api/courses/${cid}/ch/${chid}/chat/${qid}`, { message: text, current }, (ev) => {
      const p = S.tutor.pending;
      if (ev.type === "delta") {
        p.reply += ev.text;
        const el = $("#t-stream");
        if (el) { el.innerHTML = md(stripActions(p.reply)); const box = $("#t-msgs"); box.scrollTop = box.scrollHeight; }
      } else if (ev.type.startsWith("action")) {
        const verb = { add_questions: "Adding questions", rewrite_lesson: "Rewriting the lesson", add_chapter: "Adding a chapter" }[ev.op] || ev.op;
        if (ev.type === "action_start") p.actions.push({ cls: "busy", text: `${verb}…` });
        else { p.actions.pop(); p.actions.push(ev.type === "action" ? { cls: "", text: `✓ ${ev.summary}` } : { cls: "err", text: `${verb} failed: ${ev.message}` }); changed = changed || ev.type === "action"; }
        const acts = $("#t-acts");
        if (acts) acts.innerHTML = p.actions.map((a) => `<div class="t-act ${a.cls}">${esc(a.text)}</div>`).join("");
      }
    });
  } catch (e) { fail(e); }
  S.tutor.pending = null;
  try {
    const [ch, course] = await Promise.all([api("GET", `/api/courses/${cid}/ch/${chid}`), api("GET", `/api/courses/${cid}`)]);
    S.course = course;
    if (S.ch?.id === chid) {
      S.ch = ch;
      seedDrafts();
      if (changed) { renderMain(); toast("Course updated"); }
      renderSide();
      renderTop();
    }
  } catch (e) { fail(e); }
  renderTutor();
  setTimeout(() => $("#t-input")?.focus(), 30);
}

// ---- events -----------------------------------------------------------------

const ACTS = {
  nav: (el) => go(el.dataset.to),
  menu: () => { S.menu = !S.menu; renderSide(); },
  switch: async (el) => {
    S.pid = el.dataset.id; store.set("margin-profile", S.pid);
    S.course = null; S.ch = null; S.review = null; S.tutor.open = false;
    go("#/");
  },
  theme: () => {
    const cur = document.documentElement.dataset.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    const next = cur === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next; store.set("margin-theme", next); renderSide();
  },
  "pick-emoji": (el) => { const f = el.closest("form"); f.emoji.value = el.dataset.v; $$(".emoji-pick button", f).forEach((b) => b.classList.toggle("on", b === el)); },
  "pick-color": (el) => { const f = el.closest("form"); f.color.value = el.dataset.v; $$(".swatches button", f).forEach((b) => b.classList.toggle("on", b === el)); },
  "edit-profile": (el) => { S.editingProfile = el.dataset.id; renderMain(); },
  "cancel-profile": () => { S.editingProfile = null; renderMain(); },
  "del-profile": async (el) => {
    const p = S.profiles.find((x) => x.id === el.dataset.id);
    if (!confirm(`Delete ${p.name}'s profile? Their notebooks stay on disk but won't be listed.`)) return;
    S.profiles = await api("DELETE", `/api/profiles/${p.id}`);
    if (S.pid === p.id) { S.pid = S.profiles[0]?.id || null; store.set("margin-profile", S.pid || ""); }
    S.editingProfile = null; renderAll();
  },
  "del-course": async (el, ev) => {
    ev.stopPropagation();
    const c = S.courses.find((x) => x.id === el.dataset.id);
    if (!confirm(`Delete "${c.title}" with all its answers and tutor notes?`)) return;
    await api("DELETE", `/api/courses/${c.id}`);
    if (S.course?.id === c.id) S.course = null;
    await loadCourses(); renderAll();
  },
  depth: (el) => { startForm().depth = el.dataset.v; renderMain(); },
  type: (el) => {
    const f = startForm(), t = el.dataset.v;
    f.types = f.types.includes(t) ? f.types.filter((x) => x !== t) : [...f.types, t];
    if (!f.types.length) f.types = [t];
    renderMain();
  },
  lessons: (el) => { startForm().lessons = el.checked; },
  suggest: (el) => { startForm().topic = el.dataset.v; renderMain(); $('[data-in="topic"]').focus(); },
  build: () => buildCourse(),
  "edit-outline": () => { S.editOutline = true; S.outline = null; renderMain(); },
  "ol-move": (el) => {
    const i = +el.dataset.k, j = i + +el.dataset.d, a = S.outline.chapters;
    [a[i], a[j]] = [a[j], a[i]]; renderMain();
  },
  "ol-del": (el) => { S.outline.chapters.splice(+el.dataset.k, 1); renderMain(); },
  "ol-add": () => { S.outline.chapters.push({ title: "", desc: "" }); renderMain(); $$('[data-in="ol-title"]').pop()?.focus(); },
  "ol-save": () => saveOutline(),
  "ol-cancel": () => { S.editOutline = false; S.outline = null; renderMain(); },
  regen: () => { const r = S.route; delete S.chGen[`${r.cid}/${r.chid}`]; generateChapter(r.cid, r.chid); },
  "toggle-lesson": () => { S.lessonOpen = !(S.lessonOpen ?? true); renderMain(); },
  "ask-lesson": () => openTutor("lesson"),
  jump: (el) => { setActive(el.dataset.q); $(`#q-${el.dataset.q}`)?.scrollIntoView({ behavior: "smooth", block: "start" }); },
  pick: (el) => { draft(el.dataset.q).choice = +el.dataset.i; renderCard(el.dataset.q); autosave(el.dataset.q, S.ch.id, S.course.id); },
  check: (el) => check(el.dataset.q),
  run: (el) => runTests(el.dataset.q),
  hint: async (el) => {
    const qid = el.dataset.q, k = dkey(qid), q = S.ch.questions.find((x) => x.id === qid);
    S.hints[k] = Math.min((S.hints[k] || 0) + 1, q.hints.length);
    renderCard(qid);
    try { const out = await api("PUT", `/api/courses/${S.course.id}/ch/${S.ch.id}/answers/${qid}`, { value: draft(qid), hints: S.hints[k] }); S.ch.answers[qid] = out.answer; } catch (e) { console.warn(e); }
  },
  solution: (el) => { S.solution[dkey(el.dataset.q)] = true; renderCard(el.dataset.q); },
  "add-step": (el) => { draft(el.dataset.q).working.push(""); renderCard(el.dataset.q); setTimeout(() => $$(`[data-card="${el.dataset.q}"] .step math-field`).pop()?.focus(), 50); },
  "del-step": (el) => { draft(el.dataset.q).working.splice(+el.dataset.k, 1); renderCard(el.dataset.q); autosave(el.dataset.q, S.ch.id, S.course.id); },
  ask: (el) => openTutor(el.dataset.q),
  "ask-why": async (el) => {
    go(`#/c/${el.dataset.c}/${el.dataset.x}/${el.dataset.q}`);
    const wait = () => new Promise((r) => setTimeout(r, 60));
    for (let i = 0; i < 50 && S.ch?.id !== el.dataset.x; i++) await wait();
    openTutor(el.dataset.q);
    sendTutor("Why was my answer wrong?");
  },
  finish: async () => {
    const { id: cid } = S.course, chid = S.ch.id;
    try {
      if (!S.ch.finished) {
        const out = await api("POST", `/api/courses/${cid}/ch/${chid}/finish`);
        updateProfile(out.profile);
        S.ch.finished = Date.now();
        const e = S.course.chapters.find((x) => x.id === chid); if (e) e.finished = true;
        celebrate(true);
        if (out.xp) toast(`Chapter complete! +${out.xp} XP`, "xp");
      }
      go(`#/c/${cid}/${chid}/summary`);
    } catch (e) { fail(e); }
  },
  "open-tutor": () => openTutor(),
  "close-tutor": () => { S.tutor.open = false; renderTutor(); renderTop(); },
  quick: (el) => sendTutor(el.dataset.v),
  send: () => sendTutor($("#t-input").value),
  "save-settings": () => saveSettings(),
  "prompt-sel": (el) => { S.promptSel = el.dataset.v; renderMain(); },
  "save-prompt": async () => { try { S.prompts = await api("PUT", `/api/prompts/${S.promptSel}`, { text: $("#prompt-text").value }); toast("Prompt saved"); renderMain(); } catch (e) { fail(e); } },
  "reset-prompt": async () => { if (!confirm("Reset this prompt to the shipped default?")) return; S.prompts = await api("DELETE", `/api/prompts/${S.promptSel}`); renderMain(); },
};

document.addEventListener("click", (ev) => {
  const el = ev.target.closest("[data-act]");
  if (S.menu && !ev.target.closest(".who")) { S.menu = false; renderSide(); }
  const card = ev.target.closest("[data-card]");
  if (card) setActive(card.dataset.card);
  if (!el || el.disabled) return;
  if (el.tagName === "INPUT" && el.type === "checkbox") { ACTS[el.dataset.act]?.(el, ev); return; }
  ev.preventDefault();
  Promise.resolve(ACTS[el.dataset.act]?.(el, ev)).catch(fail);
});

document.addEventListener("input", (ev) => {
  const el = ev.target.closest("[data-in]");
  if (!el) return;
  const kind = el.dataset.in, qid = el.dataset.q;
  if (kind === "topic") { startForm().topic = el.value; return; }
  if (kind === "chapters") { startForm().chapters = +el.value || 6; const o = $("[data-chapters-out]"); if (o) o.textContent = el.value; return; }
  if (kind === "ol-course-title") { S.outline.title = el.value; return; }
  if (kind === "ol-summary") { S.outline.summary = el.value; return; }
  if (kind === "ol-title") { S.outline.chapters[+el.dataset.k].title = el.value; return; }
  if (kind === "ol-desc") { S.outline.chapters[+el.dataset.k].desc = el.value; return; }
  if (!qid || !S.ch) return;
  const d = draft(qid);
  if (kind === "blank") d.blanks[+el.dataset.k] = el.value;
  else if (kind === "free") { d.text = el.value; const w = $(`[data-words="${qid}"]`); if (w) w.textContent = `${(el.value.match(/\S+/g) || []).length} words`; }
  else if (kind === "step") d.working[+el.dataset.k] = el.value;
  else if (kind === "final") d.final = el.value;
  else if (kind === "code") { d.code = el.value; sizeCode(el); }
  autosave(qid, S.ch.id, S.course.id);
});

document.addEventListener("change", (ev) => {
  const el = ev.target.closest('[data-set="model"]');
  if (!el) return;
  const eff = $(`[data-set="effort"][data-task="${el.dataset.task}"]`);
  eff.innerHTML = effortOptions(el.value, eff.value);
});

document.addEventListener("keydown", (ev) => {
  const t = ev.target;
  if (t.matches?.(".code textarea") && ev.key === "Tab") {
    ev.preventDefault();
    const s = t.selectionStart, e = t.selectionEnd;
    t.value = t.value.slice(0, s) + "    " + t.value.slice(e);
    t.selectionStart = t.selectionEnd = s + 4;
    t.dispatchEvent(new Event("input", { bubbles: true }));
  } else if (t.id === "t-input" && ev.key === "Enter" && !ev.shiftKey) {
    ev.preventDefault(); sendTutor(t.value);
  } else if (t.matches?.('[data-in="topic"]') && ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) {
    ev.preventDefault(); buildCourse();
  } else if (t.matches?.(".fill input") && ev.key === "Enter") {
    ev.preventDefault(); check(t.dataset.q);
  }
});

document.addEventListener("submit", async (ev) => {
  const f = ev.target.closest('[data-form="profile"]');
  if (!f) return;
  ev.preventDefault();
  try {
    const p = await api("POST", "/api/profiles", { id: f.dataset.id || undefined, name: f.name.value.trim(), emoji: f.emoji.value, color: f.color.value, about: f.about.value.trim() });
    S.profiles = await api("GET", "/api/profiles");
    S.editingProfile = null;
    if (!S.pid || !profile()) { S.pid = p.id; store.set("margin-profile", p.id); go("#/new"); return; }
    renderAll();
  } catch (e) { fail(e); }
});

window.addEventListener("hashchange", onRoute);

// ---- boot -------------------------------------------------------------------

(async function boot() {
  marked.use({ gfm: true, breaks: false });
  try {
    [S.config, S.profiles] = await Promise.all([api("GET", "/api/config"), api("GET", "/api/profiles")]);
  } catch (e) { fail(e); return; }
  const want = store.get("margin-profile");
  S.pid = S.profiles.some((p) => p.id === want) ? want : S.profiles[0]?.id || null;
  if (S.pid) await loadCourses().catch(fail);
  onRoute();
})();
