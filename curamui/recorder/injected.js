// Injected into every frame (top document + Curam content iframes).
// Classifies raw DOM events into high-level Curam verbs and reports them to
// the Node side via the __curamRec* bindings. The overlay UI lives only in
// the top frame.
//
// This file is stringified and passed to page.addInitScript, so it must be a
// single self-contained function with no outer requires.

module.exports = function curamRecorderInit() {
  const IS_TOP = window === window.top;

  function frameTitle() {
    try { return window.frameElement ? (window.frameElement.title || '') : ''; } catch (e) { return ''; }
  }

  function txt(el) { return (el && el.textContent || '').replace(/\s+/g, ' ').trim(); }
  function norm(s) { return (s || '').replace(/\s+/g, ' ').trim(); }

  // Generalize transactional reference numbers in tab titles into wildcards:
  // "Insurance Affordability 10000387  - Francis Mertz" -> "Insurance Affordability * - Francis Mertz"
  function generalizeTitle(title) {
    return norm(title).replace(/\b\d{5,}\b/g, '*').replace(/\*( \*)+/g, '*');
  }

  function fieldLabel(input) {
    // edit-form inputs are titled "<Label> Mandatory" — keep the label only
    if (input.title) return input.title.replace(/\s+Mandatory$/, '');
    const tid = input.getAttribute('data-testid') || input.getAttribute('data-rawtestid') || '';
    const m = tid.match(/Label\.([A-Za-z0-9]+)$/);
    if (m) return m[1].replace(/([a-z])([A-Z])/g, '$1 $2');
    if (input.id) {
      const lbl = document.querySelector(`label[for="${CSS.escape(input.id)}"]`);
      if (lbl) return txt(lbl);
    }
    return input.name || input.id || 'unknown field';
  }

  function report(verb, args, ctx) {
    if (window.__curamRecEvent) window.__curamRecEvent({ verb, args, ctx: ctx || undefined, frame: IS_TOP ? 'top' : frameTitle(), ts: Date.now() });
  }

  // ---------- classification: top frame (application chrome) ----------
  function classifyTopClick(e) {
    const el = e.target;
    if (el.closest && el.closest('#__curam_rec_overlay')) return; // our own UI

    // Carbon modal (evidence edit etc.): footer Save/Cancel live in the top
    // document, outside the modal's iframe.
    const modalBtn = el.closest && el.closest('.cds--modal-container button');
    if (modalBtn && txt(modalBtn)) { report('click button', [txt(modalBtn)]); return; }

    const closeBtn = el.closest && el.closest('button.dijitTabCloseButton');
    if (closeBtn) {
      const tab = closeBtn.closest('.dijitTab');
      const label = tab && tab.querySelector('span[role="tab"]');
      report('close tab', [generalizeTitle(label ? label.title || txt(label) : '')]);
      return;
    }

    const dijitTab = el.closest && el.closest('.dijitTab');
    if (dijitTab && !dijitTab.classList.contains('tabStripButton')) {
      const label = dijitTab.querySelector('span[role="tab"]');
      if (!label) return;
      const title = label.title || txt(label);
      if (dijitTab.closest('#app-sections-container-dc_tablist')) { report('click section', [norm(title)]); return; }
      if (dijitTab.closest('.navigation-bar-tabs')) { report('select nav', [norm(title)]); return; }
      if (dijitTab.closest('[id$="-stc_tablist"]')) { report('select tab', [generalizeTitle(title)]); return; }
      return;
    }

    const accTitle = el.closest && el.closest('.dijitAccordionTitle');
    if (accTitle && accTitle.closest('.shortcuts-panel')) {
      const t = accTitle.querySelector('.dijitAccordionText');
      report('click shortcutgroup', [norm(t ? t.title || txt(t) : '')]);
      return;
    }

    const shortcut = el.closest && el.closest('a.curam-content-pane-single-link');
    if (shortcut) {
      const pane = shortcut.closest('[data-dojo-type="dijit/layout/AccordionPane"]');
      const group = pane ? pane.getAttribute('aria-label') : '';
      report('click shortcutitem', [group, norm((shortcut.title || txt(shortcut)).replace(/…$/, ''))]);
      return;
    }

    const navItem = el.closest && el.closest('.child-nav-items li .link');
    if (navItem) { report('select navitem', [norm(navItem.title || txt(navItem))]); return; }

    const expando = el.closest && el.closest('.dojoxExpandoIcon');
    if (expando) { report('toggle shortcuts panel', []); return; }
  }

  // ---------- classification: content iframes ----------
  // Label of the list/cluster the element sits in ("Current Cases", "Search
  // Results", …) so link clicks carry their table context.
  function containerLabel(el) {
    let box = el.closest && el.closest('[data-testid^="list_"], [data-testid^="cluster_"]');
    // Inner content/heading divs share the prefix (list_content_…); climb to
    // the outer container that actually holds the title.
    while (box && /^(list|cluster)_(content|heading)_/.test(box.getAttribute('data-testid'))) {
      box = box.parentElement && box.parentElement.closest('[data-testid^="list_"], [data-testid^="cluster_"]');
    }
    // decision pages title their lists with a collapse header instead
    if (!box) box = el.closest && el.closest('.list-with-header');
    if (!box) return '';
    const h = box.querySelector('.cds--accordion__title, .cds--accordion__heading, .collapse-title');
    // Drop dynamic decorations like "(Number of Items: 3)".
    return h ? txt(h).replace(/\s*\([^)]*\d[^)]*\)\s*$/, '') : '';
  }

  // Row context for links inside tables: position, clicked column, and the
  // full row's header->value map. Costs nothing at capture time and lets the
  // user (or replay fallbacks) re-target the click when data changes.
  function rowContext(link) {
    const cell = link.closest && link.closest('td, th');
    const row = link.closest && link.closest('tr');
    const table = link.closest && link.closest('table');
    if (!cell || !row || !table) return null;
    const headers = Array.from(table.querySelectorAll('thead th')).map(th => txt(th));
    // details rows (expanded row content) are not data rows
    const dataRows = Array.from(table.querySelectorAll('tbody tr'))
      .filter(r => r.querySelector('td') && r.offsetParent !== null && !r.classList.contains('list-details-row'));
    const cells = Array.from(row.children);
    const rowValues = {};
    headers.forEach((h, i) => { const v = cells[i] ? txt(cells[i]).slice(0, 80) : ''; if (h && v) rowValues[h] = v; });
    return { row: dataRows.indexOf(row) + 1, rowCount: dataRows.length, column: headers[cells.indexOf(cell)] || '', rowValues };
  }

  // Menu items carry decorations ("Add Proof… +" — accel span + ellipsis).
  function menuItemText(el) { return txt(el).replace(/\s*\+$/, '').replace(/…$/, ''); }

  // A dijit dropdown click (row actions "▼" or the page-level "..." menu)
  // doesn't produce a step by itself: the following .dijitMenuItem click is
  // classified against this pending opener.
  let pendingMenu = null;

  function classifyFrameClick(e) {
    const el = e.target;

    // in-page navigation tabs (Outstanding / Verified / Not Applicable, ...)
    const pageTab = el.closest && el.closest('.dijitTab');
    if (pageTab && !pageTab.classList.contains('tabStripButton')) {
      const label = pageTab.querySelector('span[role="tab"]');
      if (label) { report('select pagetab', [norm(label.title || txt(label))]); return; }
    }

    // row expander (aria-expanded read BEFORE the toggle flips it)
    const toggle = el.closest && el.closest('a.list-details-row-toggle');
    if (toggle) {
      const expanding = toggle.getAttribute('aria-expanded') !== 'true';
      report(expanding ? 'expand row' : 'collapse row', ['', containerLabel(toggle)], rowContext(toggle));
      return;
    }

    // dropdown openers: row actions menu vs page-level action menu
    const dd = el.closest && el.closest('.dijitDropDownButton');
    if (dd) {
      pendingMenu = dd.closest('tr')
        ? { kind: 'row', container: containerLabel(dd), ctx: rowContext(dd), ts: Date.now() }
        : { kind: 'page', ts: Date.now() };
      return;
    }

    const menuItem = el.closest && el.closest('.dijitMenuItem');
    if (menuItem) {
      const item = menuItemText(menuItem);
      const p = pendingMenu && Date.now() - pendingMenu.ts < 15000 ? pendingMenu : null;
      pendingMenu = null;
      if (p && p.kind === 'row') { report('click rowmenu', [item, p.container], p.ctx); return; }
      if (p && p.kind === 'page') { report('click pagemenu', [item]); return; }
      report('click menuitem', [item]);
      return;
    }

    const actionBtn = el.closest && el.closest('.action-set a');
    if (actionBtn) { report('click button', [txt(actionBtn)]); return; }
    const link = el.closest && el.closest('a');
    if (link && txt(link)) { report('click link', [txt(link), containerLabel(link)], rowContext(link)); return; }
    const button = el.closest && el.closest('button');
    if (button && txt(button)) { report('click button', [txt(button), containerLabel(button)]); return; }
  }

  // Right-click on a read-only display field records an assertion on its
  // current value. The native context menu is suppressed and the field is
  // flashed as feedback.
  function flash(el) {
    const prev = el.style.outline;
    el.style.outline = '2px solid #24a148';
    setTimeout(() => { el.style.outline = prev; }, 700);
  }

  function classifyFrameContextMenu(e) {
    // display field -> expect "<label>" is "<value>"
    const item = e.target.closest && e.target.closest('.cds--cluster__item--read-only-field');
    if (item) {
      // group wrappers nest further fields; only leaf fields are assertable
      if (item.querySelector('.cds--cluster__item--read-only-field')) return;
      e.preventDefault();
      e.stopPropagation();
      const label = txt(item.querySelector('label'));
      const value = txt(item.querySelector('.cds--field'));
      if (!label) return;
      report('expect', [label, value]);
      flash(item);
      return;
    }
    // table row -> expect row [in "<container>"] where <all row values>
    const cell = e.target.closest && e.target.closest('tbody td');
    if (cell && !cell.closest('tr.list-details-row')) {
      e.preventDefault();
      e.stopPropagation();
      const ctx = rowContext(cell);
      if (!ctx || !Object.keys(ctx.rowValues).length) return;
      report('expect row', ['', containerLabel(cell)], ctx);
      flash(cell.closest('tr'));
    }
  }

  // Enter in a text field triggers Curam's default action (form submit)
  // without any click event — record it as the button press it stands for.
  function classifyFrameKeydown(e) {
    if (e.key !== 'Enter') return;
    const el = e.target;
    if (!el || el.tagName !== 'INPUT' || ['checkbox', 'radio', 'button', 'submit'].includes(el.type)) return;
    const def = document.querySelector('input.curam-default-action[type="submit"]');
    if (!def) return;
    // The change event for the field fires after this keydown (on submit), so
    // record the pending field value first; the later change dedupes away.
    if (el.value) report('enter', [el.value, fieldLabel(el)]);
    report('click button', [def.title || def.value || 'Enter']);
  }

  function classifyChange(e) {
    const el = e.target;
    if (!el || !el.tagName) return;
    const tag = el.tagName.toLowerCase();
    if (tag !== 'input' && tag !== 'select' && tag !== 'textarea') return;
    if (el.type === 'hidden') return;
    // Widget-internal mirrors (flatpickr alt inputs etc.) are invisible or
    // aria-hidden; a real user can only change visible fields.
    if (el.offsetParent === null || el.getAttribute('aria-hidden') === 'true') return;
    if (el.type === 'checkbox') {
      // row-selection checkboxes have no meaningful label — record them as
      // row verbs with table context instead
      const row = el.closest('tbody tr');
      if (row && !IS_TOP) { report(el.checked ? 'check row' : 'uncheck row', ['', containerLabel(el)], rowContext(el)); return; }
      report(el.checked ? 'check' : 'uncheck', [fieldLabel(el)]);
      return;
    }
    if (el.type === 'radio') { report('select radio', [fieldLabel(el)]); return; }
    if (tag === 'select') {
      const opt = el.selectedOptions && el.selectedOptions[0];
      report('select option', [opt ? txt(opt) : el.value, fieldLabel(el)]);
      return;
    }
    // Carbon combobox dropdowns are text inputs with role=combobox; date
    // pickers share the role but should replay as plain value entry
    if (el.getAttribute('role') === 'combobox' && !((el.className || '').toString().includes('date-picker'))) {
      report('select option', [el.value, fieldLabel(el)]);
      return;
    }
    report('enter', [el.value, fieldLabel(el)]);
  }

  document.addEventListener('click', IS_TOP ? classifyTopClick : classifyFrameClick, true);
  document.addEventListener('change', classifyChange, true);
  if (!IS_TOP) {
    document.addEventListener('keydown', classifyFrameKeydown, true);
    document.addEventListener('contextmenu', classifyFrameContextMenu, true);
  }

  // ---------- overlay UI (top frame only) ----------
  if (!IS_TOP) return;

  function buildOverlay() {
    if (document.getElementById('__curam_rec_overlay')) return;
    const box = document.createElement('div');
    box.id = '__curam_rec_overlay';
    // Attached to <html>, not <body>: Curam styles/clips body, which cut the
    // panel off. Left-anchored so an oversized containing block can't push it
    // off-screen.
    box.style.cssText = 'position:fixed;bottom:16px;left:16px;z-index:2147483647;background:#161616;color:#f4f4f4;font:12px/1.4 "IBM Plex Sans",sans-serif;border:1px solid #393939;border-radius:8px;padding:10px 12px;box-shadow:0 4px 16px rgba(0,0,0,.4);width:250px;box-sizing:border-box';
    box.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
        <span id="__rec_dot" style="width:10px;height:10px;border-radius:50%;background:#525252;display:inline-block"></span>
        <b style="flex:1">Curam Recorder</b>
        <span id="__rec_count" style="color:#a8a8a8">0 steps</span>
      </div>
      <div id="__rec_controls" style="display:flex;gap:6px">
        <button id="__rec_start" style="flex:1">Start</button>
        <button id="__rec_pause" style="flex:1" disabled>Pause</button>
        <button id="__rec_stop"  style="flex:1" disabled>Stop</button>
      </div>
      <div id="__rec_save" style="display:none;margin-top:8px">
        <div id="__rec_review" style="display:none;max-height:300px;overflow-y:auto;margin-bottom:6px"></div>
        <input id="__rec_name" placeholder="recording name" style="width:100%;box-sizing:border-box;margin-bottom:6px;background:#262626;color:#f4f4f4;border:1px solid #525252;padding:4px 6px;border-radius:4px">
        <div style="display:flex;gap:6px">
          <button id="__rec_savebtn" style="flex:1">Save</button>
          <button id="__rec_discard" style="flex:1">Discard</button>
        </div>
      </div>
      <div id="__rec_last" style="margin-top:6px;color:#a8a8a8;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"></div>`;
    for (const b of box.querySelectorAll('button')) {
      b.style.cssText += ';background:#393939;color:#f4f4f4;border:none;border-radius:4px;padding:4px 8px;cursor:pointer';
    }
    document.documentElement.appendChild(box);

    const $ = id => document.getElementById(id);
    function render(st) {
      $('__rec_dot').style.background = st.recording ? (st.paused ? '#f1c21b' : '#fa4d56') : '#525252';
      $('__rec_count').textContent = st.steps + ' steps';
      $('__rec_start').disabled = st.recording && !st.paused;
      $('__rec_start').textContent = st.paused ? 'Resume' : 'Start';
      $('__rec_pause').disabled = !st.recording || st.paused;
      $('__rec_stop').disabled = !st.recording;
      if (st.last) $('__rec_last').textContent = st.last;
    }
    window.__curamRecRender = render;

    // Review UI for data-dependent link clicks: per step, choose how replay
    // should find the link — exact text, row position, or column predicate.
    function renderReview(flagged) {
      const host = $('__rec_review');
      host.innerHTML = '';
      host.style.display = flagged && flagged.length ? 'block' : 'none';
      if (!flagged || !flagged.length) return;
      const title = document.createElement('div');
      title.style.cssText = 'margin-bottom:4px;color:#f4f4f4';
      title.innerHTML = '<b>Dynamic steps — how should replay find the row?</b>';
      host.appendChild(title);
      for (const f of flagged) {
        const cols = Object.keys(f.rowValues || {}).filter(c => c !== f.column && f.rowValues[c] && f.rowValues[c] !== f.text);
        const prefCol = cols.find(c => /participant|type|status|name/i.test(c)) || cols[0];
        // expand-row / rowmenu steps have no meaningful literal text to match
        const hasLiteral = f.verb === 'click link' && f.text;
        const d = document.createElement('div');
        d.className = '__rec_flag';
        d.dataset.i = f.i;
        d.style.cssText = 'border-top:1px solid #393939;padding:6px 0;color:#c6c6c6';
        const radio = (val, checked, label) =>
          `<label style="display:block;cursor:pointer"><input type="radio" name="__rec_st_${f.i}" value="${val}" ${checked ? 'checked' : ''}> ${label}</label>`;
        const what = hasLiteral ? `"${f.text}"` : f.verb + (f.text ? ` "${f.text}"` : '');
        let html = `<div style="color:#f4f4f4;margin-bottom:2px">${what}${f.container ? ` in "${f.container}"` : ''}</div>`;
        if (hasLiteral) html += radio('literal', !cols.length, `exact text "${f.text}"`);
        html += radio('row', !hasLiteral && !cols.length, `row ${f.row} of ${f.rowCount}`);
        if (cols.length) {
          const opts = cols.map(c => `<option value="${c}" ${c === prefCol ? 'selected' : ''}>${c} = "${f.rowValues[c]}"</option>`).join('');
          html += radio('predicate', true, `row where <select style="background:#262626;color:#f4f4f4;border:1px solid #525252;max-width:150px">${opts}</select>`);
        }
        d.innerHTML = html;
        host.appendChild(d);
      }
    }

    function collectStrategies() {
      return Array.from(document.querySelectorAll('.__rec_flag')).map(d => {
        const i = Number(d.dataset.i);
        const sel = d.querySelector(`input[name="__rec_st_${i}"]:checked`);
        const type = sel ? sel.value : 'literal';
        const col = type === 'predicate' ? d.querySelector('select').value : undefined;
        return { i, type, col };
      });
    }

    $('__rec_start').onclick = async () => render(await window.__curamRecCtl('start'));
    $('__rec_pause').onclick = async () => render(await window.__curamRecCtl('pause'));
    $('__rec_stop').onclick = async () => {
      const st = await window.__curamRecCtl('stop');
      render(st);
      renderReview(st.flagged);
      box.style.width = st.flagged && st.flagged.length ? '360px' : '250px';
      $('__rec_save').style.display = 'block';
      $('__rec_controls').style.display = 'none';
      $('__rec_name').focus();
    };
    $('__rec_savebtn').onclick = async () => {
      const name = $('__rec_name').value.trim() || 'recording-' + Date.now();
      await window.__curamRecCtl('applyStrategies', collectStrategies());
      await window.__curamRecCtl('save', name);
      $('__rec_save').style.display = 'none';
      $('__rec_controls').style.display = 'flex';
      box.style.width = '250px';
      render(await window.__curamRecCtl('state'));
    };
    $('__rec_discard').onclick = async () => {
      await window.__curamRecCtl('discard');
      $('__rec_save').style.display = 'none';
      $('__rec_controls').style.display = 'flex';
      box.style.width = '250px';
      render(await window.__curamRecCtl('state'));
    };

    window.__curamRecCtl('state').then(render).catch(() => {});
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', buildOverlay);
  else buildOverlay();
  // Curam replaces body content during boot; re-add overlay if it vanishes.
  setInterval(() => { if (document.body && !document.getElementById('__curam_rec_overlay')) buildOverlay(); }, 2000);
};
