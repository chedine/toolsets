// Parsing, indexing and search over notes. Pure functions; keep RE/TAG in sync with vault.py.
window.TB = (() => {
  const RE = /\[\[([^\[\]\n]+)\]\]/g;
  const TAG = /(^|[\s(\/])#([\p{L}\p{N}_-]+)/gu;
  const WORD = /[\p{L}\p{N}]+/gu;
  const STOP = new Set(('a an and are as at be by can could did do does for from had has have how i if in into is it its me my ' +
    'of on or our so than that the their them then there these they this to was we were what when where which who whom why will with ' +
    'would you your about any all also get got just know much many more most some tell show give find list notes note say said').split(' '));

  const norm = s => s.trim().replace(/\s+/g, ' ');
  const keyOf = s => norm(s).toLowerCase();
  const words = s => s.toLowerCase().match(WORD) || [];
  function keys(text) { return new Set([...text.matchAll(RE)].map(m => keyOf(m[1]))); }
  function names(text) { return [...new Set([...text.matchAll(RE)].map(m => norm(m[1])))]; }
  function plain(text) { return text.replace(/\[\[|\]\]/g, ''); }
  function tags(text) { return [...new Set([...text.matchAll(TAG)].map(m => m[2].toLowerCase()))]; }
  function stripTags(text) {
    return text.split('\n').map(l => l.replace(TAG, '$1').replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+$/, '')).join('\n');
  }
  function tagIndex(notes) {
    const m = {};
    notes.forEach(n => tags(n.text).forEach(k => { m[k] = (m[k] || 0) + 1; }));
    return Object.entries(m).map(([key, count]) => ({ key, name: key, count })).sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
  }
  // Entities are bare strings, matched case-insensitively; the most used spelling wins.
  function entityIndex(notes) {
    const map = {};
    for (const n of notes) {
      const seen = new Set();
      for (const m of n.text.matchAll(RE)) {
        const name = norm(m[1]), key = name.toLowerCase();
        if (seen.has(key)) continue; seen.add(key);
        const e = map[key] || (map[key] = { key, count: 0, names: {}, ids: [] });
        e.count++; e.ids.push(n.id); e.names[name] = (e.names[name] || 0) + 1;
      }
    }
    return Object.values(map).map(e => ({ key: e.key, count: e.count, ids: e.ids,
      name: Object.entries(e.names).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? 1 : -1))[0][0] }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }

  // ---- search index (memoised per notes array) ------------------------------------
  let memo = { notes: null, ix: null };
  function index(notes) {
    if (memo.notes === notes) return memo.ix;
    const docs = new Map(), df = new Map();
    let total = 0;
    for (const n of notes) {
      const body = plain(stripTags(n.text)).toLowerCase(), ws = words(body), tf = new Map();
      ws.forEach(w => tf.set(w, (tf.get(w) || 0) + 1));
      tf.forEach((_, w) => df.set(w, (df.get(w) || 0) + 1));
      const entWords = new Set([...keys(n.text)].flatMap(words));
      docs.set(n.id, { n, body, tf, len: ws.length, ents: keys(n.text), tags: tags(n.text), entWords });
      total += ws.length;
    }
    const ix = { docs, df, N: notes.length, avgdl: total / Math.max(1, notes.length), vocab: [...df.keys()], ents: entityIndex(notes) };
    memo = { notes, ix };
    return ix;
  }

  function lev(a, b, max) {
    if (Math.abs(a.length - b.length) > max) return max + 1;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i]; let best = i;
      for (let j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        best = Math.min(best, cur[j]);
      }
      if (best > max) return max + 1;
      prev = cur;
    }
    return prev[b.length];
  }
  // A query word matches vocabulary words exactly, by prefix, or (when nothing else hits) within 1–2 typos.
  function expand(ix, term) {
    const out = new Map();
    for (const w of ix.vocab) {
      if (w === term) out.set(w, 1);
      else if (w.startsWith(term)) out.set(w, term.length >= 3 ? 0.75 : 0.5);
    }
    if (!out.size && term.length >= 4) {
      const max = term.length >= 7 ? 2 : 1;
      for (const w of ix.vocab) if (lev(term, w, max) <= max) out.set(w, 0.6);
    }
    return out;
  }
  function bm25(ix, d, w) {
    const f = d.tf.get(w); if (!f) return 0;
    const df = ix.df.get(w), idf = Math.log(1 + (ix.N - df + 0.5) / (df + 0.5));
    return idf * (f * 2.2) / (f + 1.2 * (0.25 + 0.75 * d.len / ix.avgdl));
  }

  // "/water -arizona \"per day\" [[data center]] #stat"
  function parseQuery(v) {
    let body = v[0] === '/' || v[0] === '?' ? v.slice(1) : v;
    const ents = [...body.matchAll(RE)].map(m => keyOf(m[1]));
    body = body.replace(/\[\[[^\[\]\n]*(\]\])?/g, ' ');
    const phrases = [...body.matchAll(/"([^"]+)"/g)].map(m => m[1].trim().toLowerCase()).filter(Boolean);
    body = body.replace(/"[^"]*"?/g, ' ');
    const tg = [...(' ' + body).matchAll(TAG)].map(m => m[2].toLowerCase());
    body = (' ' + body).replace(TAG, ' ');
    const excludes = [], terms = [];
    body.split(/\s+/).filter(Boolean).forEach(tok => {
      if (tok[0] === '-' && tok.length > 1) excludes.push(...words(tok));
      else terms.push(...words(tok));
    });
    return { ents, tags: tg, phrases, excludes, terms };
  }

  function score(ix, d, exp) {
    let s = 0, hit = 0;
    for (const m of exp) {
      let best = 0;
      m.forEach((wt, w) => { const b = bm25(ix, d, w) * wt * (d.entWords.has(w) ? 1.6 : 1); if (b > best) best = b; });
      if (best > 0) hit++;
      s += best;
    }
    return { s, hit };
  }

  // Ids of notes passing the query's hard filters (entities, tags, phrases, excludes).
  function filtered(notes, v) {
    const ix = index(notes), q = parseQuery(v), out = new Set();
    for (const d of ix.docs.values()) {
      if (!q.ents.every(e => d.ents.has(e)) || !q.tags.every(t => d.tags.includes(t))) continue;
      if (!q.phrases.every(p => d.body.includes(p)) || q.excludes.some(x => d.tf.has(x) || d.ents.has(x))) continue;
      out.add(d.n.id);
    }
    return out;
  }

  // Returns ranked notes plus everything the UI needs to explain the result.
  function search(notes, v) {
    const ix = index(notes), q = parseQuery(v);
    const content = q.terms.filter(t => !STOP.has(t));
    if (content.length) q.terms = content;  // "/H2O usage of server farms": don't let "of" match everything
    const exp = q.terms.map(t => expand(ix, t));
    const pool = [];
    for (const d of ix.docs.values()) {
      if (!q.ents.every(e => d.ents.has(e))) continue;
      if (!q.tags.every(t => d.tags.includes(t))) continue;
      if (!q.phrases.every(p => d.body.includes(p))) continue;
      if (q.excludes.some(x => d.tf.has(x) || [...d.ents].some(e => e === x))) continue;
      pool.push(d);
    }
    let res, partial = false;
    if (!q.terms.length) res = pool.map(d => ({ d, s: 0 }));
    else {
      const scored = pool.map(d => ({ d, ...score(ix, d, exp) }));
      res = scored.filter(r => r.hit === q.terms.length);
      if (!res.length && q.terms.length > 1) { res = scored.filter(r => r.hit > 0); partial = res.length > 0; }
      res.forEach(r => { r.s += r.hit * 2; });
    }
    res.sort((a, b) => b.s - a.s || b.d.n.created - a.d.n.created);
    const hl = [...new Set(exp.flatMap(m => [...m.keys()]))].concat(q.phrases);
    const fuzzy = exp.some((m, i) => m.size && ![...m.keys()].some(w => w.startsWith(q.terms[i])));
    return { res: res.map(r => r.d.n), ents: q.ents, tags: q.tags, terms: hl, groups: exp.map(m => [...m.keys()]), partial, fuzzy, q };
  }

  // Entities whose names match every free-text word (each word given as its expansions, so
  // prefixes and typos pivot too), for jumping from words to an entity filter.
  function entityMatches(notes, groups, exclude) {
    if (!groups.length || groups.some(g => !g.length)) return [];
    return index(notes).ents.filter(e => !exclude.includes(e.key) && groups.every(g => words(e.key).some(w => g.includes(w)))).slice(0, 8);
  }
  function related(res, fEnts, idx) {
    const counts = {};
    res.forEach(n => keys(n.text).forEach(k => { if (!fEnts.includes(k)) counts[k] = (counts[k] || 0) + 1; }));
    return idx.filter(e => counts[e.key]).sort((a, b) => counts[b.key] - counts[a.key]).slice(0, 10)
      .map(e => ({ ...e, count: counts[e.key] }));
  }

  // Notes that match a natural-language question by words (for Ask): free-text BM25, entities
  // named in the question, then their co-occurring neighbours. The server fuses this with embeddings.
  function rankForQuestion(notes, question) {
    const ix = index(notes), ql = ' ' + question.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ') + ' ';
    const explicit = parseQuery(question).ents;
    const named = new Set(explicit);
    ix.ents.forEach(e => { const k = ' ' + words(e.key).join(' '); if (ql.includes(k + ' ') || ql.includes(k + 's ')) named.add(e.key); });
    const neigh = new Set();
    for (const d of ix.docs.values()) if ([...d.ents].some(e => named.has(e))) d.ents.forEach(e => { if (!named.has(e)) neigh.add(e); });
    const exp = words(question).filter(w => !STOP.has(w) && w.length > 1).map(t => expand(ix, t)).filter(m => m.size);
    const scored = [...ix.docs.values()].map(d => {
      let s = score(ix, d, exp).s;
      d.ents.forEach(e => { if (named.has(e)) s += 6; else if (neigh.has(e)) s += 0.5; });
      return { n: d.n, s };
    });
    return scored.filter(r => r.s > 0).sort((a, b) => b.s - a.s || b.n.created - a.n.created).map(r => r.n);
  }

  // [{t:'text'|'entity', text, key, hl}]; hl marks words matching the query.
  function parts(text, terms) {
    const out = [];
    const esc = (terms || []).filter(Boolean).sort((a, b) => b.length - a.length).map(x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const tre = esc.length ? new RegExp('((?<![\\p{L}\\p{N}])(?:' + esc.join('|') + ')[\\p{L}\\p{N}]*)', 'giu') : null;
    const pushPlain = s => {
      if (!s) return;
      if (!tre) { out.push({ t: 'text', text: s, hl: false }); return; }
      s.split(tre).forEach((p, i) => { if (p) out.push({ t: 'text', text: p, hl: i % 2 === 1 }); });
    };
    let last = 0;
    for (const m of text.matchAll(RE)) {
      pushPlain(text.slice(last, m.index));
      out.push({ t: 'entity', text: m[1], key: keyOf(m[1]), hl: !!tre && new RegExp(tre.source, 'iu').test(m[1]) });
      last = m.index + m[0].length;
    }
    pushPlain(text.slice(last));
    return out;
  }
  function lines(text, terms) {
    return text.split('\n').filter(l => l.trim()).map(l => {
      const bm = l.match(/^\s*[-•*]\s+/);
      return { bullet: !!bm, parts: parts(bm ? l.slice(bm[0].length) : l, terms) };
    });
  }
  // Editor mirror: [{kind:'text'|'entity'|'tag'|'prefix', pre, text, post}]
  function inputGroups(v) {
    const g = []; let s = v;
    if (v[0] === '/' || v[0] === '?') { g.push({ kind: 'prefix', pre: '', text: v[0], post: '' }); s = v.slice(1); }
    const pushText = text => {
      let last = 0;
      for (const m of text.matchAll(TAG)) {
        const st = m.index + m[1].length;
        if (st > last) g.push({ kind: 'text', pre: '', text: text.slice(last, st), post: '' });
        g.push({ kind: 'tag', pre: '', text: '#' + m[2], post: '' });
        last = st + m[2].length + 1;
      }
      if (last < text.length) g.push({ kind: 'text', pre: '', text: text.slice(last), post: '' });
    };
    let last = 0;
    for (const m of s.matchAll(/\[\[([^\[\]\n]*)\]\]/g)) {
      if (m.index > last) pushText(s.slice(last, m.index));
      g.push({ kind: 'entity', pre: '[[', text: m[1], post: ']]' });
      last = m.index + m[0].length;
    }
    if (last < s.length) pushText(s.slice(last));
    return g;
  }

  const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  function fmt(ts) {
    const d = new Date(ts);
    const now = new Date(), start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    if (ts >= start) return 'Today';
    if (ts >= start - 864e5) return 'Yesterday';
    return MON[d.getMonth()] + ' ' + d.getDate() + (d.getFullYear() !== now.getFullYear() ? ' ' + d.getFullYear() : '');
  }

  return { RE, TAG, keyOf, keys, names, plain, tags, stripTags, tagIndex, entityIndex, parseQuery, filtered, search, entityMatches, related,
    rankForQuestion, parts, lines, inputGroups, fmt };
})();
