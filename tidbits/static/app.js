// Tidbits UI (port of the "Blocks v3" prototype). State lives here; the vault lives on the server.
// One input, three modes by first char: text = capture, "/" = search, "?" = ask AI.
(() => {
  const $ = id => document.getElementById(id);
  const ta = $('ta');
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k, d) { try { return localStorage.getItem(k) ?? d; } catch (e) { return d; } },
    set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) {} }
  };
  const PAGE = 60;

  let S = {
    notes: [], vault: '', value: store.get('tidbits.draft', ''), selStart: 0, selEnd: 0, sugIndex: 0, sugClosed: false,
    editingId: null, editBase: null, pendingTags: [], status: '', lastSaved: null, loaded: false,
    cursor: -1, limit: PAGE, ask: null, askInfo: null,
    theme: store.get('tidbits.theme', matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
  };
  let statusT, askCtl = null;
  function set(p) { S = { ...S, ...(typeof p === 'function' ? p(S) : p) }; render(); extract(); }
  function flash(msg) { clearTimeout(statusT); set({ status: msg }); statusT = setTimeout(() => set({ status: '' }), 2600); }

  // ---- api -----------------------------------------------------------------
  async function api(method, path, body) {
    const r = await fetch(path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body && JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(j.error || r.statusText); e.status = r.status; e.body = j; throw e; }
    return j;
  }
  async function reload() {
    try { const j = await api('GET', '/api/notes'); set({ notes: j.notes, vault: j.vault, loaded: true }); }
    catch (e) { flash(e.status === 401 ? 'Sign in: open /?t=<token>' : 'Server unreachable'); }
  }
  api('GET', '/api/config').then(c => set({ askInfo: c.ask })).catch(() => {});

  // ---- editor controller -----------------------------------------------------
  const mode = (v = S.value) => v[0] === '/' ? 'search' : v[0] === '?' ? 'ask' : 'write';
  const index = () => TB.entityIndex(S.notes);
  let searchMemo = {};
  function current() {
    if (searchMemo.notes !== S.notes || searchMemo.value !== S.value) searchMemo = { notes: S.notes, value: S.value, r: TB.search(S.notes, S.value) };
    return searchMemo.r;
  }
  function focus(caret) {
    ta.focus(); if (caret != null) ta.setSelectionRange(caret, caret);
  }
  function setValue(v, extra) { set({ value: v, selStart: v.length, selEnd: v.length, sugClosed: false, sugIndex: 0, cursor: -1, limit: PAGE, ...(extra || {}) }); focus(v.length); }
  function clear() { stopAsk(); set({ value: '', editingId: null, editBase: null, pendingTags: [], selStart: 0, selEnd: 0, cursor: -1, ask: null }); }

  function sug() {
    const { value, selStart, selEnd, sugClosed, sugIndex } = S;
    if (sugClosed || selStart !== selEnd) return null;
    const before = value.slice(0, selStart);
    const m = before.match(/\[\[([^\[\]\n]*)$/);
    if (!m) {
      const tm = before.match(/(?:^|[\s(\/])#([\p{L}\p{N}_-]*)$/u);
      if (!tm) return null;
      const q = tm[1].toLowerCase(), all = TB.tagIndex(S.notes);
      const list = all.filter(e => !q || e.key.includes(q))
        .sort((a, b) => (b.key.startsWith(q) - a.key.startsWith(q)) || b.count - a.count).slice(0, 6)
        .map(e => ({ ...e, isNew: false }));
      if (q && mode() === 'write' && !all.some(e => e.key === q)) list.push({ name: q, key: q, count: 0, isNew: true });
      if (!list.length) return null;
      return { kind: 'tag', q, start: selStart - tm[1].length - 1, list, index: Math.min(sugIndex, list.length - 1) };
    }
    const q = TB.keyOf(m[1]), ents = index();
    const list = ents.filter(e => !q || e.key.includes(q))
      .sort((a, b) => (b.key.startsWith(q) - a.key.startsWith(q)) || b.count - a.count).slice(0, 6)
      .map(e => ({ name: e.name, key: e.key, count: e.count, isNew: false }));
    if (q && mode() === 'write' && !ents.some(e => e.key === q)) list.push({ name: m[1].trim(), key: q, count: 0, isNew: true });
    if (!list.length) return null;
    return { kind: 'entity', start: selStart - m[0].length, list, index: Math.min(sugIndex, list.length - 1) };
  }
  function accept(item, s) {
    const { value, selStart } = S;
    if (s.kind === 'tag') {
      const after = value.slice(selStart).replace(/^[\p{L}\p{N}_-]*/u, '').replace(/^ /, '');
      const ins = '#' + item.key + ' ';
      const nv = value.slice(0, s.start) + ins + after, caret = s.start + ins.length;
      set({ value: nv, selStart: caret, selEnd: caret, sugIndex: 0, sugClosed: true, cursor: -1 }); focus(caret); return;
    }
    let after = value.slice(selStart);
    if (after.startsWith(']]')) after = after.slice(2);
    const nv = value.slice(0, s.start) + '[[' + item.name + ']]' + after;
    const caret = s.start + item.name.length + 4;
    set({ value: nv, selStart: caret, selEnd: caret, sugIndex: 0, cursor: -1 }); focus(caret);
  }
  function mark() {
    const { value } = S;
    let s = ta.selectionStart, e = ta.selectionEnd;
    if (s === e) { const nv = value.slice(0, s) + '[[]]' + value.slice(e); set({ value: nv, selStart: s + 2, selEnd: s + 2, sugClosed: false }); focus(s + 2); return; }
    while (s < e && /\s/.test(value[s])) s++;
    while (e > s && /\s/.test(value[e - 1])) e--;
    const nv = value.slice(0, s) + '[[' + value.slice(s, e) + ']]' + value.slice(e);
    set({ value: nv, selStart: e + 4, selEnd: e + 4 }); focus(e + 4);
  }

  // Typing "#tag " pulls the tag out of the sentence into a chip; chips are appended on save.
  function extract() {
    if (mode() !== 'write') return;
    const { value, selStart, pendingTags } = S;
    const m = value.match(/(^|\s)#([\p{L}\p{N}_-]+)(?=[\s.,;:!?)])/u);
    if (!m) return;
    let start = m.index + m[1].length, end = start + 1 + m[2].length;
    if (value[end] === ' ') end++; else if (start > 0 && value[start - 1] === ' ') start--;
    const nv = value.slice(0, start) + value.slice(end);
    let caret = selStart; if (caret >= end) caret -= end - start; else if (caret > start) caret = start;
    const key = m[2].toLowerCase();
    set({ value: nv, selStart: caret, selEnd: caret, sugClosed: false, pendingTags: pendingTags.includes(key) ? pendingTags : [...pendingTags, key] });
    focus(caret);
  }
  function composed() {
    const v = S.value.split('\n').map(l => l.replace(/[ \t]+$/, '')).join('\n').trim();
    if (!v) return '';
    const have = new Set(TB.tags(v)), add = S.pendingTags.filter(k => !have.has(k)).map(k => '#' + k).join(' ');
    return add ? v + (v.includes('\n') ? '\n' : ' ') + add : v;
  }

  async function save() {
    const text = composed();
    if (!text || mode() !== 'write') return;
    const { editingId, editBase } = S;
    try {
      const note = editingId ? await api('PUT', '/api/notes/' + encodeURIComponent(editingId), { text, base: editBase })
        : await api('POST', '/api/notes', { text });
      const notes = editingId ? S.notes.map(n => n.id === editingId ? note : n) : [note, ...S.notes];
      set({ notes, value: '', selStart: 0, selEnd: 0, editingId: null, editBase: null, pendingTags: [], lastSaved: note.id });
      const nm = [...TB.names(text), ...TB.tags(text).map(x => '#' + x)];
      flash((editingId ? 'Updated' : 'Saved') + (nm.length ? ' · ' + nm.join(', ') : ''));
    } catch (e) {
      if (e.status === 409) {
        await reload();
        set({ editBase: e.body.note.updated });
        flash('Changed elsewhere since you opened it. Save again to overwrite.');
      } else flash('Not saved: ' + e.message);
    }
  }
  async function del(n) {
    try { await api('DELETE', '/api/notes/' + encodeURIComponent(n.id)); set({ notes: S.notes.filter(x => x.id !== n.id) }); flash('Deleted · moved to .trash'); }
    catch (e) { flash('Not deleted: ' + e.message); }
  }
  function edit(n) {
    stopAsk();
    setValue(TB.stripTags(n.text).trim(), { editingId: n.id, editBase: n.updated, pendingTags: TB.tags(n.text), ask: null });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  function addFilter(name) {
    const v = S.value, tag = '[[' + name + ']]';
    if (mode(v) === 'search') {
      if (TB.parseQuery(v).ents.includes(TB.keyOf(name))) return;
      setValue((v.length > 1 ? v.replace(/\s*$/, ' ') : v) + tag + ' ');
    } else setValue('/' + tag + ' ', { editingId: null, pendingTags: [] });
  }
  function addTag(key) {
    const v = S.value, tag = '#' + key;
    if (mode(v) === 'search') {
      if (TB.parseQuery(v).tags.includes(key)) return;
      setValue((v.length > 1 ? v.replace(/\s*$/, ' ') : v) + tag + ' ');
    } else setValue('/' + tag + ' ', { editingId: null, pendingTags: [] });
  }
  // Swap the free-text words for the entity they name: "/data cent" -> "/[[data center]]".
  function pivot(name) {
    const v = S.value, keep = [...v.matchAll(TB.RE)].map(m => m[0]).concat([...(' ' + v.slice(1)).matchAll(TB.TAG)].map(m => '#' + m[2]));
    setValue('/' + keep.concat('[[' + name + ']]').join(' ') + ' ');
  }

  // ---- ask ---------------------------------------------------------------------
  function stopAsk() { if (askCtl) { askCtl.abort(); askCtl = null; } }
  async function runAsk() {
    const v = S.value, q = v.slice(1).trim();
    if (!q) return;
    stopAsk();
    const ctl = askCtl = new AbortController();
    const upd = p => { if (askCtl === ctl) set(st => ({ ask: { ...st.ask, ...(typeof p === 'function' ? p(st.ask) : p) } })); };
    const ids = TB.rankForQuestion(S.notes, q).map(n => n.id);
    set({ ask: { v, q, text: '', loading: true, error: '', refs: {}, used: 0 } });
    try {
      const r = await fetch('/api/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ q, ids }), signal: ctl.signal });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
      const rd = r.body.getReader(), dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await rd.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          if (!line.trim()) continue;
          const ev = JSON.parse(line);
          if (ev.type === 'meta') upd({ refs: ev.refs, used: Object.keys(ev.refs).length, model: ev.model, thinking: ev.thinking });
          else if (ev.type === 'delta') upd(a => ({ text: a.text + ev.text }));
          else if (ev.type === 'error') upd({ error: ev.message });
        }
      }
      upd({ loading: false });
    } catch (e) {
      if (e.name !== 'AbortError') upd({ loading: false, error: e.message });
    } finally { if (askCtl === ctl) askCtl = null; }
  }
  const askState = () => S.ask && S.ask.v === S.value ? S.ask : null;

  // ---- input events ------------------------------------------------------------
  ta.addEventListener('input', () => {
    set({ value: ta.value, selStart: ta.selectionStart, selEnd: ta.selectionEnd, sugClosed: false, sugIndex: 0, cursor: -1, limit: PAGE });
    if (askCtl && S.ask && S.ask.v !== S.value) stopAsk();
  });
  ta.addEventListener('select', () => set({ selStart: ta.selectionStart, selEnd: ta.selectionEnd }));
  ta.addEventListener('click', () => set({ selStart: ta.selectionStart, selEnd: ta.selectionEnd }));
  ta.addEventListener('keyup', e => { if (e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End') set({ selStart: ta.selectionStart, selEnd: ta.selectionEnd }); });
  ta.addEventListener('keydown', e => {
    if (e.isComposing) return;
    const s = sug();
    if (s) {
      if (e.key === 'ArrowDown') { e.preventDefault(); set({ sugIndex: (s.index + 1) % s.list.length }); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); set({ sugIndex: (s.index - 1 + s.list.length) % s.list.length }); return; }
      const exactTag = s.kind === 'tag' && s.q && s.list[s.index].key === s.q;
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && !exactTag)) { e.preventDefault(); accept(s.list[s.index], s); return; }
      if (e.key === 'Escape') { e.preventDefault(); set({ sugClosed: true }); return; }
    }
    const m = mode();
    if (m === 'write' && e.key === 'Backspace' && !S.value && S.pendingTags.length) {
      e.preventDefault();
      const v = '#' + S.pendingTags[S.pendingTags.length - 1];
      set({ value: v, selStart: v.length, selEnd: v.length, pendingTags: S.pendingTags.slice(0, -1) }); focus(v.length); return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'e') { e.preventDefault(); mark(); return; }
    if (e.key === 'Escape') { clear(); return; }
    if (m === 'write') {
      if (e.key === 'Enter' && (e.shiftKey || e.metaKey || e.ctrlKey)) { e.preventDefault(); save(); }
      return;
    }
    if (m === 'search') {
      const rows = visibleRows();
      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && rows.length) {
        e.preventDefault();
        const c = e.key === 'ArrowDown' ? Math.min(rows.length - 1, S.cursor + 1) : Math.max(-1, S.cursor - 1);
        set({ cursor: c });
        const el = document.querySelector('.trow.sel');
        if (el) el.scrollIntoView({ block: 'nearest' }); else window.scrollTo({ top: 0 });
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        if (e.shiftKey || e.metaKey || e.ctrlKey) { if (S.value.slice(1).trim()) { setValue('?' + S.value.slice(1).trim()); runAsk(); } }
        else if (S.cursor >= 0 && rows[S.cursor]) edit(rows[S.cursor]);
      }
      return;
    }
    if (e.key === 'Enter') { e.preventDefault(); runAsk(); }
  });
  document.addEventListener('keydown', e => {
    if (document.activeElement === ta || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key.length === 1 || e.key === 'Escape') ta.focus();
  });
  window.addEventListener('focus', reload);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) reload(); });
  $('saveBtn').addEventListener('click', () => { mode() === 'ask' ? runAsk() : save(); focus(); });
  $('theme').addEventListener('click', () => { const th = S.theme === 'dark' ? 'light' : 'dark'; store.set('tidbits.theme', th); set({ theme: th }); focus(); });

  // Each container keeps its own handler table; elements carry data-a="<index>".
  function bindable(el, evt = 'click') {
    const acts = [];
    el.addEventListener(evt, e => {
      const t = e.target.closest('[data-a]');
      if (!t || !el.contains(t)) return;
      if (evt === 'mousedown') e.preventDefault();
      acts[+t.dataset.a] && acts[+t.dataset.a](e);
    });
    return { reset() { acts.length = 0; }, on(fn) { acts.push(fn); return acts.length - 1; } };
  }
  const B = { results: bindable($('results')), spectrum: bindable($('spectrum')), sug: bindable($('sug'), 'mousedown'), pending: bindable($('pending')) };

  // Notes currently listed (for keyboard navigation), in display order.
  function visibleRows() {
    if (mode() !== 'search') return [];
    const q = S.value.slice(1).trim();
    const list = q ? current().res : [...S.notes].sort((a, b) => b.created - a.created);
    return list.slice(0, q ? S.limit : Math.min(S.limit, 30));
  }

  // ---- render --------------------------------------------------------------------
  const sizeFor = text => { const L = TB.plain(TB.stripTags(text)).length; return L < 70 ? '26px' : L < 130 ? '21px' : '18px'; };
  const strip = text => { const n = TB.keys(text).size; return n ? '<div></div>'.repeat(n) : '<div class="none"></div>'; };
  function segs(parts, b) {
    return parts.map(p => p.t === 'entity'
      ? `<span class="seg-ent${p.hl ? ' seg-hl' : ''}"${b ? ` data-a="${b.on(() => addFilter(p.text.trim()))}"` : ''}>${esc(p.text)}</span>`
      : p.hl ? `<span class="seg-hl">${esc(p.text)}</span>` : esc(p.text)).join('');
  }
  const linesHtml = (text, terms, b) => TB.lines(TB.stripTags(text), terms)
    .map(l => `<div class="line">${l.bullet ? '<span class="dot">•</span>' : ''}<div>${segs(l.parts, b)}</div></div>`).join('');
  const chipEnt = (b, e, fn) => `<button class="chip ent" data-a="${b.on(fn)}">${esc(e.name)}<small>${e.count}</small></button>`;
  const chipTag = (b, key, count) => `<button class="chip tag" data-a="${b.on(() => addTag(key))}">#${esc(key)}<small>${count}</small></button>`;

  let lastKey = '', lastNotes = null, lastAsk = null;
  function renderResults(m) {
    const { notes, value, status, lastSaved } = S;
    const just = m === 'write' && !value && status && lastSaved ? notes.find(n => n.id === lastSaved) : null;
    const key = [m, m === 'write' ? '' : value, just ? just.id + status : '', S.cursor, S.limit, JSON.stringify(S.askInfo)].join('\u0001');
    if (key === lastKey && notes === lastNotes && S.ask === lastAsk) return !!just;
    lastKey = key; lastNotes = notes; lastAsk = S.ask;
    const b = B.results; b.reset();
    let html = '';

    if (just) {
      html += `<div class="just"><div class="strip">${strip(just.text)}</div><div class="body" style="font-size:${sizeFor(just.text)}">
        ${linesHtml(just.text, [])}<div class="meta">${TB.tags(just.text).map(x => `<span class="t">#${esc(x)}</span>`).join('')}
        <span class="when">captured just now</span></div></div></div>`;
    }
    if (m === 'search') html += searchHtml(b);
    else if (m === 'ask') html += askHtml(b);
    $('results').innerHTML = html;
    return !!just;
  }

  function searchHtml(b) {
    const { notes, value } = S, q = value.slice(1).trim(), rows = visibleRows();
    let html = '';
    if (!q) {
      const tIndex = TB.tagIndex(notes), idx = index(), maxC = Math.max(1, ...idx.map(e => e.count));
      if (tIndex.length) html += `<div class="chips" style="margin-top:56px"><span class="row-label">tags</span>${tIndex.map(x => chipTag(b, x.key, x.count)).join('')}</div>`;
      if (idx.length) html += `<div class="wall-ents" style="margin-top:${tIndex.length ? 20 : 56}px">${idx.map(e => {
        const r = e.count / maxC;
        return `<button data-a="${b.on(() => addFilter(e.name))}" style="font-size:${Math.round(17 + r * 30)}px; min-width:${Math.round(110 + r * 200)}px; flex-grow:${e.count}">${esc(e.name)}<small>${e.count} ${e.count === 1 ? 'note' : 'notes'}</small></button>`;
      }).join('')}</div>`;
      if (!notes.length) return html + `<div class="empty">Nothing captured yet.</div>`;
      return html + table(rows, [], 'Recent', 40, b, notes.length);
    }
    const r = current(), named = TB.entityMatches(notes, r.groups, r.ents);
    const rel = TB.related(r.res, r.ents.concat(named.map(e => e.key)), index());
    const tc = {};
    r.res.forEach(n => TB.tags(n.text).forEach(x => { if (!r.tags.includes(x)) tc[x] = (tc[x] || 0) + 1; }));
    const relTags = Object.entries(tc).sort((a, b) => b[1] - a[1]).slice(0, 6);
    let top = 52;
    if (named.length) {
      html += `<div class="chips" style="margin-top:${top}px"><span class="row-label">entities</span>${named.map(e => chipEnt(b, e, () => pivot(e.name))).join('')}</div>`;
      top = 12;
    }
    if (rel.length || relTags.length) {
      html += `<div class="chips" style="margin-top:${top}px"><span class="row-label">also linked</span>${
        rel.map(e => chipEnt(b, e, () => addFilter(e.name))).join('')}${relTags.map(([x, n]) => chipTag(b, x, n)).join('')}</div>`;
      top = 20;
    }
    const note = r.partial ? 'No note has every word. Closest matches:' : r.fuzzy ? 'Including close spellings.' : '';
    if (note) { html += `<div class="search-note" style="margin-top:${top + 8}px">${note}</div>`; top = 10; }
    if (r.res.length) html += table(rows, r.terms, r.res.length + (r.res.length === 1 ? ' note' : ' notes'), top, b, r.res.length);
    else html += `<div class="empty">Nothing matches. Yet.</div>`;
    if (S.askInfo && S.askInfo.available) {
      html += `<button class="ask-cta" data-a="${b.on(() => { setValue('?' + q); runAsk(); })}"><b>⇧⏎</b> ask AI: ${esc(TB.plain(q))}</button>`;
    }
    return html;
  }

  function askHtml(b) {
    const a = askState(), info = S.askInfo;
    const model = (a && a.model || info && info.model || '').split('/').pop(), think = a && a.thinking || info && info.thinking || '';
    if (info && !info.available) return `<div class="empty">Ask needs the pi CLI on the server (set TIDBITS_PI_BIN).</div>`;
    if (!a) {
      return `<div class="ask-idle">Ask anything about your ${S.notes.length} notes. <b>⏎</b> to ask${model ? ` · ${esc(model)} · ${esc(think)}` : ''}</div>`;
    }
    const refs = a.refs || {}, cited = [];
    let text = a.text;
    if (a.loading) text = text.replace(/\[\[?[^\]\n]*$/, '');
    text = text.replace(/\[(n\d+(?:\s*,\s*n\d+)*)\]/g, (_, list) => list.split(/\s*,\s*/).map(r => {
      if (refs[r] && !cited.includes(r)) cited.push(r);
      return refs[r] ? '' + r + '' : '';
    }).join(''));
    const body = linesHtml(text, [], b).replace(/(n\d+)/g, (_, r) =>
      `<sup class="cite" data-a="${b.on(() => { const el = document.getElementById('src-' + r); el && el.scrollIntoView({ behavior: 'smooth', block: 'center' }); })}">${cited.indexOf(r) + 1}</sup>`);
    const label = a.error ? 'could not answer' : a.loading ? (a.text ? 'answering' : `reading ${a.used || ''} notes`) + '…'
      : 'answer' + (cited.length ? ' · from ' + cited.length + ' note' + (cited.length > 1 ? 's' : '') : '');
    let html = `<div class="answer${a.loading ? ' loading' : ''}"><div class="answer-label">${esc(label)}<span>${esc(model)} · ${esc(think)}</span></div>
      <div class="answer-body">${a.error ? esc(a.error) : body || '<span class="pulse">…</span>'}</div></div>`;
    const byId = new Map(S.notes.map(n => [n.id, n]));
    const src = cited.map(r => ({ r, n: byId.get(refs[r]) })).filter(x => x.n);
    if (src.length) html += table(src.map(x => x.n), [], 'Sources', 28, b, src.length, src.map((x, i) => ({ id: 'src-' + x.r, num: i + 1 })));
    return html;
  }

  function table(list, terms, label, top, b, total, marks) {
    const more = total > list.length ? `<button class="more" data-a="${b.on(() => set({ limit: S.limit + PAGE }))}">show ${Math.min(PAGE, total - list.length)} more of ${total - list.length}</button>` : '';
    return `<div class="table" style="margin-top:${top}px"><div class="trow thead"><span></span><span>${esc(label)}</span><span>Tags</span><span>Date</span><span></span></div>${
      list.map((n, i) => `<div class="trow${i === S.cursor && !marks ? ' sel' : ''}"${marks ? ` id="${marks[i].id}"` : ''}><div class="tstrip">${strip(n.text)}</div>
        <div class="ttext">${marks ? `<sup class="cite static">${marks[i].num}</sup>` : ''}${linesHtml(n.text, terms, b)}</div>
        <div class="ttags">${TB.tags(n.text).map(x => `<button data-a="${b.on(() => addTag(x))}">#${esc(x)}</button>`).join('')}</div>
        <div class="tdate" title="${esc(n.path)}">${TB.fmt(n.created)}</div>
        <div class="tacts"><button data-a="${b.on(() => edit(n))}">edit</button><button data-a="${b.on(() => del(n))}">delete</button></div></div>`).join('')}${more}</div>`;
  }

  function render() {
    const m = mode(), { value, editingId, pendingTags, notes } = S;
    document.documentElement.dataset.theme = S.theme;
    store.set('tidbits.draft', m === 'write' && !editingId ? value || null : null);

    if (ta.value !== value) { ta.value = value; ta.setSelectionRange(S.selStart, S.selEnd); }
    const lenV = value.length;
    document.documentElement.style.setProperty('--input-size', m === 'write' ? (lenV > 160 ? '36px' : 'clamp(30px, 7vw, 54px)') : 'clamp(26px, 5.5vw, 42px)');
    $('mirror').innerHTML = TB.inputGroups(value).map(g => g.kind === 'entity'
      ? `<span class="edge">${g.pre}</span><span class="ent">${esc(g.text)}</span><span class="edge">${g.post}</span>`
      : `<span class="${g.kind}">${esc(g.text)}</span>`).join('') + '​';
    $('placeholder').style.display = value ? 'none' : '';

    B.pending.reset();
    $('pending').innerHTML = m === 'write' ? pendingTags.map(k =>
      `<button title="Remove tag" data-a="${B.pending.on(() => { set(st => ({ pendingTags: st.pendingTags.filter(x => x !== k) })); focus(); })}">#${esc(k)}</button>`).join('') : '';

    const s = sug();
    B.sug.reset();
    $('sug').innerHTML = s ? s.list.map((o, i) => `<div class="${s.kind === 'tag' ? 'tag' : ''} ${i === s.index ? 'on' : ''}" data-a="${B.sug.on(() => accept(o, s))}">${
      s.kind === 'tag' ? '#' : ''}${esc(o.name)}<small>${o.isNew ? 'new' : o.count}</small></div>`).join('') : '';
    $('saveBtn').classList.toggle('show', (m === 'write' || m === 'ask') && !!value.slice(m === 'ask' ? 1 : 0).trim());
    $('saveBtn').textContent = m === 'ask' ? 'ask' : editingId ? 'update' : 'save';

    const showedJust = renderResults(m);
    $('inputWrap').classList.toggle('up', !(m === 'write' && !showedJust));

    const idx = index();
    B.spectrum.reset();
    $('spectrum').innerHTML = idx.map(e => `<div title="${esc(e.name)}" style="flex:${e.count}" data-a="${B.spectrum.on(() => addFilter(e.name))}"></div>`).join('');

    const hasSel = S.selStart !== S.selEnd;
    const hints = m === 'write' ? [
      ['⇧⏎', editingId ? 'update' : 'save'], ['⏎', 'new line'], ['[[', 'entity'], ['#', 'tag'],
      ['⌘E', hasSel ? 'make selection an entity' : 'mark entity', hasSel], ['/', 'search'], ['?', 'ask AI'], ...(editingId ? [['esc', 'cancel']] : [['esc', 'clear']])
    ] : m === 'search' ? [['↑↓', 'pick'], ['⏎', 'edit'], ['⇧⏎', 'ask AI'], ['[[', 'entity'], ['#', 'tag'], ['"…"', 'phrase'], ['-word', 'exclude'], ['esc', 'clear']]
      : [['⏎', 'ask'], ['esc', 'clear']];
    $('hints').innerHTML = hints.map(([k, l, hot]) => `<span class="${hot ? 'hot' : ''}"><b>${esc(k)}</b>${esc(l)}</span>`).join('');
    const modeEl = $('mode');
    modeEl.textContent = m === 'write' ? (editingId ? 'Edit' : 'Capture') : m === 'search' ? 'Search' : 'Ask';
    modeEl.classList.toggle('alt', m !== 'write' || !!editingId);
    $('status').textContent = S.status;
    const res = m === 'search' && value.slice(1).trim() ? current().res.length + ' of ' : '';
    $('counts').textContent = res + notes.length + ' notes · ' + idx.length + ' entities · ' + TB.tagIndex(notes).length + ' tags';
    $('counts').title = S.vault;
    $('theme').textContent = S.theme === 'dark' ? 'light' : 'dark';
  }

  render();
  focus(S.value.length);
  reload();
})();
