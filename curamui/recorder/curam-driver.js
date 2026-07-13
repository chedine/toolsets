// Curam UI driver — each method maps 1:1 to a high-level recorder verb.
// All selectors are title/label-based (human-readable), scoped to avoid ambiguity.

function globToRegex(pattern) {
  return new RegExp('^' + pattern.split('*').map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
}

class CuramDriver {
  constructor(page) {
    this.page = page;
    this.section = null; // locator of current section content panel (…-sbc or plain stc)
    this.sectionId = null;
  }

  async _settle(ms = 1500) { await this.page.waitForTimeout(ms); }

  // ---- click section <title> ----
  async clickSection(title) {
    const tab = this.page.locator(`#app-sections-container-dc_tablist span[role="tab"][title="${title}"]`);
    await tab.click();
    this.sectionId = (await tab.getAttribute('id')).split('_tablist_')[1];
    this.section = this.page.locator(`[id="${this.sectionId}"]`);
    await this._settle(2500);
    return this;
  }

  _shortcuts() { return this.section.locator('[role="region"][aria-label="Shortcuts"]'); }

  // ---- click shortcut group <title> (expands panel too if collapsed) ----
  async clickShortcutGroup(title) {
    const sc = this._shortcuts();
    if ((await sc.getAttribute('class')).includes('dojoxExpandoClosed')) {
      await sc.locator('.dojoxExpandoIcon').click({ force: true });
      await this._settle();
    }
    const groupTitle = sc.locator(`.dijitAccordionText[title="${title}"]`);
    const pane = sc.locator(`[data-dojo-type="dijit/layout/AccordionPane"][aria-label="${title}"]`);
    if (!(await pane.isVisible())) {
      await groupTitle.click();
      await pane.waitFor({ state: 'visible', timeout: 10000 });
    }
    this._lastGroup = title;
    return this;
  }

  // ---- click shortcutitem <title> (within last group, or pass group explicitly) ----
  async clickShortcutItem(title, group = this._lastGroup) {
    const scope = group ? this._shortcuts().locator(`[aria-label="${group}"]`) : this._shortcuts();
    // titles in DOM end with the ellipsis char '…' when abbreviated; accept both
    const link = scope.locator(`a.curam-content-pane-single-link[title="${title}"], a.curam-content-pane-single-link[title="${title}…"]`).first();
    await link.click();
    await this._settle(3500);
    return this;
  }

  _tabStrip() { return this.page.locator(`[id="${this.sectionId.replace('-sbc', '-stc')}_tablist"]`); }

  // ---- select tab <pattern> ('*' wildcards allowed) ----
  async selectTab(pattern) {
    const re = globToRegex(pattern);
    const tabs = this._tabStrip().locator('span[role="tab"]');
    const n = await tabs.count();
    for (let i = 0; i < n; i++) {
      const t = (await tabs.nth(i).getAttribute('title')) || '';
      if (re.test(t.replace(/\s+/g, ' ').trim())) {
        await tabs.nth(i).click();
        await this._settle(3000);
        return this;
      }
    }
    throw new Error(`No tab matching "${pattern}". Open tabs: ${await tabs.evaluateAll(e => e.map(x => x.title).join(' | '))}`);
  }

  // Panel of the tab that is selected RIGHT NOW. Resolved fresh on every call
  // because content clicks (e.g. a case link) open and activate new tabs.
  // Short timeout: with no tabs open (e.g. a wizard over a clean workspace)
  // this must fail fast, not eat Playwright's default 30s auto-wait.
  async _activePanel(timeout = 2000) {
    const active = this._tabStrip().locator('span[role="tab"][aria-selected="true"]').first();
    const paneId = ((await active.getAttribute('id', { timeout })) || '').split('_tablist_')[1];
    if (!paneId) throw new Error('no active tab in section');
    return this.page.locator(`[id="${paneId}"]`);
  }

  // ---- select nav <title> (navigation bar within active tab) ----
  async selectNav(title) {
    await (await this._activePanel()).locator(`.navigation-bar-tabs span[role="tab"][title="${title}"]`).click();
    await this._settle(3000);
    return this;
  }

  // ---- select navitem <title> (navigation group item in sidebar) ----
  async selectNavItem(title) {
    await (await this._activePanel()).locator(`.child-nav .dijitVisible .child-nav-items li .link[title="${title}"]`).click();
    await this._settle(3500);
    return this;
  }

  // Signature of "where we are": active tab + content document identity +
  // modal-dialog state. timeOrigin distinguishes two documents at the same
  // URL (form posts); the modal flag makes opening/closing a Carbon modal
  // (evidence edit, Add Proof, Apply Changes) count as navigation.
  async _navSignature() {
    try {
      const active = this._tabStrip().locator('span[role="tab"][aria-selected="true"]').first();
      let tabId = '';
      try { tabId = (await active.getAttribute('id', { timeout: 1500 })) || ''; } catch {}
      let doc = '';
      try {
        const panel = this.page.locator(`[id="${tabId.split('_tablist_')[1]}"]`);
        const el = panel.locator('iframe[title^="Content Panel"]').last();
        const f = await (await el.elementHandle({ timeout: 1500 })).contentFrame();
        if (f) doc = f.url() + '#' + await f.evaluate(() => performance.timeOrigin);
      } catch {}
      // wizard buttons (Search/Next/Save) navigate INSIDE the modal frame —
      // track its document identity too, or every modal click waits the
      // full nav timeout
      let modalDoc = '';
      try {
        const el = this._modalFrameEl();
        if (await el.isVisible().catch(() => false)) {
          const f = await (await el.elementHandle()).contentFrame();
          if (f) modalDoc = f.url() + '#' + await f.evaluate(() => performance.timeOrigin);
        }
      } catch { modalDoc = 'modal'; }
      return tabId + '||' + doc + '||' + modalDoc;
    } catch { return ''; }
  }

  _modalFrameEl() { return this.page.locator('.cds--modal-container iframe[title^="Modal Frame"]').last(); }

  // All frames a content action could land in, in priority order: the open
  // modal dialog's frame tree first, then the active tab's content frame
  // tree. Curam nests iframes (an expanded evidence row loads its own
  // iframe), so each root's descendants are included depth-first.
  async _candidateFrames() {
    const frames = [];
    const push = f => {
      if (!f || frames.includes(f)) return;
      frames.push(f);
      for (const ch of f.childFrames()) push(ch);
    };
    try {
      const el = this._modalFrameEl();
      if (await el.isVisible({ timeout: 200 }).catch(() => false)) push(await (await el.elementHandle()).contentFrame());
    } catch {}
    try { push(await this.contentFrame(2500)); } catch {}
    // context panel (banner fields like Decision / Coverage Start Date)
    try {
      const el = (await this._activePanel(1500)).locator('iframe[title^="Context Panel"]').last();
      if (await el.count()) push(await (await el.elementHandle()).contentFrame());
    } catch {}
    return frames;
  }

  // After an action that navigates (link/button/nav click): wait until the
  // signature changes (new tab opened or content doc replaced), then until
  // the new content document is loaded. Falls through after `timeout` for
  // actions that legitimately don't navigate.
  async _waitForNav(pre, timeout = 20000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      await this.page.waitForTimeout(400);
      const sig = await this._navSignature();
      if (sig && sig !== pre) break;
    }
    try { const f = await this.contentFrame(2500); await f.waitForLoadState('domcontentloaded'); } catch {}
    await this._settle(1500);
  }

  // ---- content frame of the active tab ----
  async contentFrame(timeout = 15000) {
    const el = (await this._activePanel(Math.min(timeout, 2000))).locator('iframe[title^="Content Panel"]').last();
    await el.waitFor({ state: 'attached', timeout });
    return await (await el.elementHandle()).contentFrame();
  }

  // ---- enter "<value>" as <field label> ----
  // Searched across the modal frame (if open) and the content frame tree.
  async enter(value, label) {
    const key = label.replace(/ /g, '');
    const sel = `input[title="${label}"], textarea[title="${label}"], input[title="${label} Mandatory"], textarea[title="${label} Mandatory"], [data-testid$=".${key}"], input[data-testid*="${key}"]`;
    const deadline = Date.now() + 10000;
    for (;;) {
      for (const f of await this._candidateFrames()) {
        const input = f.locator(sel).first();
        if (await input.isVisible().catch(() => false)) {
          await input.fill(value);
          // date pickers (flatpickr) parse on blur — Tab commits the value
          // (never Escape: that closes an enclosing modal)
          const cls = (await input.getAttribute('class')) || '';
          if (cls.includes('date-picker')) await input.press('Tab');
          return this;
        }
      }
      if (Date.now() > deadline) throw new Error(`no input "${label}"`);
      await this.page.waitForTimeout(500);
    }
  }

  // ---- select "<option>" for <field label> ----
  // Native <select> or a Carbon combobox (role="combobox" input): click to
  // open the list box, then click the option with matching text.
  async selectOption(value, label) {
    const key = label.replace(/ /g, '');
    const nat = `select[title="${label}"], select[title="${label} Mandatory"], select[data-testid$=".${key}"]`;
    const combo = `input[role="combobox"][title="${label}"], input[role="combobox"][title="${label} Mandatory"], input[role="combobox"][data-testid$=".${key}"]`;
    const deadline = Date.now() + 10000;
    let lastErr = `no field "${label}"`;
    for (;;) {
      for (const f of await this._candidateFrames()) {
        const sel = f.locator(nat).first();
        if (await sel.isVisible().catch(() => false)) { await sel.selectOption({ label: value }); return this; }
        const input = f.locator(combo).first();
        if (!(await input.isVisible().catch(() => false))) continue;
        await input.click();
        // options render into a list box (sometimes portaled); poll for them
        const optDeadline = Date.now() + 5000;
        for (;;) {
          const found = await f.evaluate(want => {
            const norm = s => (s || '').replace(/\s+/g, ' ').trim();
            const eq = (a, b) => a.includes('*')
              ? new RegExp('^' + a.split('*').map(x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$').test(b)
              : a === b;
            for (const m of document.querySelectorAll('[role="listbox"], .cds--list-box__menu')) {
              if (!m.offsetParent) continue;
              for (const o of m.querySelectorAll('[role="option"], li')) {
                if (eq(norm(want), norm(o.textContent))) {
                  document.querySelectorAll('[data-curam-replay-target]').forEach(e => e.removeAttribute('data-curam-replay-target'));
                  o.setAttribute('data-curam-replay-target', '1');
                  return true;
                }
              }
            }
            return false;
          }, value).catch(() => false);
          if (found) {
            await f.locator('[data-curam-replay-target]').click();
            await this.page.waitForTimeout(400);
            return this;
          }
          if (Date.now() > optDeadline) { lastErr = `no option "${value}" for "${label}"`; break; }
          await this.page.waitForTimeout(400);
        }
      }
      if (Date.now() > deadline) throw new Error(lastErr);
      await this.page.waitForTimeout(500);
    }
  }

  // ---- click button <label> ----
  // Modal footer buttons (Save/Cancel of Carbon modals) live in the TOP
  // document; page action buttons live in .action-set inside content frames.
  async clickButton(label) {
    const pre = await this._navSignature();
    const deadline = Date.now() + 15000;
    for (;;) {
      const modalBtn = this.page.locator('.cds--modal-container button.cds--btn', { hasText: label }).last();
      if (await modalBtn.isVisible().catch(() => false)) {
        await modalBtn.click();
        await this._waitForNav(pre);
        return this;
      }
      for (const f of await this._candidateFrames()) {
        const b = f.locator(`.action-set a.first-action-control:has-text("${label}"), .action-set a:has-text("${label}")`).first();
        if (await b.isVisible().catch(() => false)) {
          await b.click();
          await this._waitForNav(pre);
          return this;
        }
      }
      if (Date.now() > deadline) throw new Error(`no button "${label}"`);
      await this.page.waitForTimeout(500);
    }
  }

  // Resolve the list/cluster whose OWN heading is `container`. Two traps:
  // substring matches ("Cases" vs "Pending Cases") and :has() matching
  // ancestor wrappers that merely contain the titled list — so we require
  // the title's nearest container to be the box itself, and mark it in-page.
  // Two heading dialects: Carbon accordion titles owning a data-testid
  // list/cluster box, and decision-page collapse titles owning a
  // .list-with-header box.
  async _containerScope(frame, container, timeout = 10000) {
    if (!container) return frame.locator('body');
    const deadline = Date.now() + timeout;
    for (;;) {
      const found = await frame.evaluate(name => {
        const SEL = '[data-testid^="list_"], [data-testid^="cluster_"]';
        const inner = tid => /^(list|cluster)_(content|heading)_/.test(tid || '');
        const norm = s => (s || '').replace(/\s+/g, ' ').trim();
        const matches = t => norm(t).replace(/\s*\([^)]*\)\s*$/, '') === name;
        const owner = t => {
          let c = t.closest(SEL);
          while (c && inner(c.getAttribute('data-testid'))) c = c.parentElement && c.parentElement.closest(SEL);
          return c || t.closest('.list-with-header') || t.closest('.cds--accordion__item');
        };
        document.querySelectorAll('[data-curam-scope]').forEach(e => e.removeAttribute('data-curam-scope'));
        for (const t of document.querySelectorAll('.cds--accordion__title, .collapse-title')) {
          if (matches(t.textContent)) {
            const box = owner(t);
            if (box) { box.setAttribute('data-curam-scope', '1'); return true; }
          }
        }
        return false;
      }, container);
      if (found) return frame.locator('[data-curam-scope]');
      if (Date.now() > deadline) throw new Error(`container "${container}" not found`);
      await this.page.waitForTimeout(500);
    }
  }

  // Mark a target inside a table row selected by position and/or column
  // predicate. opt.target: 'link' (cell link), 'toggle' (row expander) or
  // 'menu' (row actions dropdown). Marks the element in-page; the caller
  // clicks the mark (locators can't express "cell under header X of the row
  // where header Y = value").
  async _markRowTarget(scope, opt) {
    const res = await scope.evaluate((box, opt) => {
      const norm = s => (s || '').replace(/\s+/g, ' ').trim();
      // "*" in an expected value is a wildcard
      const eq = (want, got) => {
        want = norm(want); got = norm(got);
        if (!want.includes('*')) return want === got;
        return new RegExp('^' + want.split('*').map(x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$').test(got);
      };
      const table = box.querySelector('table');
      if (!table) return { error: 'no table in container' };
      const headers = Array.from(table.querySelectorAll('thead th')).map(h => norm(h.textContent));
      // details rows (expanded row content) are not data rows
      let rows = Array.from(table.querySelectorAll('tbody tr'))
        .filter(r => r.querySelector('td') && r.offsetParent !== null && !r.classList.contains('list-details-row'));
      if (opt.where) {
        rows = rows.filter(r => Object.entries(opt.where).every(([col, val]) => {
          const i = headers.indexOf(col);
          return i >= 0 && r.children[i] && eq(val, r.children[i].textContent);
        }));
        if (!opt.row && rows.length > 1 && opt.target !== 'assert') return { error: `ambiguous: predicate matches ${rows.length} rows (add "at row N")` };
      }
      if (opt.row) rows = rows.slice(opt.row - 1, opt.row);
      const row = rows[0];
      if (!row) return { error: 'no matching row' };
      let target = null;
      if (opt.target === 'toggle') {
        target = row.querySelector('a.list-details-row-toggle');
        if (!target) return { error: 'no expander in matched row' };
        if (opt.expand !== undefined && String(opt.expand) === target.getAttribute('aria-expanded')) return { noop: true };
      } else if (opt.target === 'menu') {
        target = row.querySelector('.cds--list-row-menu .dijitButtonNode') || row.querySelector('.dijitDropDownButton .dijitButtonNode');
        if (!target) return { error: 'no row menu in matched row' };
      } else if (opt.target === 'checkbox') {
        target = row.querySelector('input[type="checkbox"]');
        if (!target) return { error: 'no checkbox in matched row' };
      } else if (opt.target === 'assert') {
        target = row; // existence of the matched row is the assertion
      } else {
        if (opt.column) { const i = headers.indexOf(opt.column); if (i >= 0 && row.children[i]) target = row.children[i].querySelector('a'); }
        // default: first link with visible text (expander icons are links too)
        target = target || Array.from(row.querySelectorAll('a')).find(a => norm(a.textContent));
        if (!target) return { error: 'no link in matched row' };
      }
      document.querySelectorAll('[data-curam-replay-target]').forEach(e => e.removeAttribute('data-curam-replay-target'));
      target.setAttribute('data-curam-replay-target', '1');
      return { ok: true };
    }, opt);
    if (res.error) throw new Error(res.error);
    return res;
  }

  // Find the frame + row that satisfies container/row/where and mark the
  // requested target in it. Sweeps every candidate frame (nested evidence
  // iframes included) and retries the sweep while content renders.
  async _rowOp(container, opt, timeout = 10000) {
    const deadline = Date.now() + timeout;
    let errs = [];
    for (;;) {
      errs = [];
      for (const f of await this._candidateFrames()) {
        let scope;
        try { scope = container ? await this._containerScope(f, container, 0) : f.locator('body'); }
        catch (e) { errs.push(e.message.split('\n')[0]); continue; }
        try { return { frame: f, res: await this._markRowTarget(scope, opt) }; }
        catch (e) { errs.push(e.message.split('\n')[0]); }
      }
      // every frame's failure matters — an "ambiguous" in the content frame
      // must not be shadowed by "no matching row" from the context panel
      if (Date.now() > deadline) throw new Error([...new Set(errs)].join(' | ') || 'no content frames');
      await this.page.waitForTimeout(500);
    }
  }

  // Row selection options from a step's chosen strategy (or captured ctx).
  _rowOpt(step, target) {
    const s = step.strategy || {};
    const ctx = step.ctx || {};
    const opt = { target };
    if (s.type === 'row') opt.row = s.row;
    else if (s.type === 'predicate') { opt.where = s.where; if (s.row) opt.row = s.row; }
    else if (ctx.row) opt.row = ctx.row;
    return opt;
  }

  // Normalized menu-item click in an already-open dijit popup within `frame`.
  // Item labels carry decorations ("Add Proof… +") — both sides are cleaned.
  async _clickMenuItem(frame, item, timeout = 8000) {
    const deadline = Date.now() + timeout;
    for (;;) {
      const found = await frame.evaluate(want => {
        const clean = s => (s || '').replace(/\s+/g, ' ').trim().replace(/\s*\+$/, '').replace(/…$/, '');
        for (const m of document.querySelectorAll('.dijitMenuPopup')) {
          const st = getComputedStyle(m);
          if (st.display === 'none' || st.visibility === 'hidden') continue;
          for (const i of m.querySelectorAll('.dijitMenuItem')) {
            if (clean(i.textContent) === clean(want)) {
              document.querySelectorAll('[data-curam-replay-target]').forEach(e => e.removeAttribute('data-curam-replay-target'));
              i.setAttribute('data-curam-replay-target', '1');
              return true;
            }
          }
        }
        return false;
      }, item).catch(() => false);
      if (found) { await frame.locator('[data-curam-replay-target]').click(); return; }
      if (Date.now() > deadline) throw new Error(`no menu item "${item}" in open menu`);
      await this.page.waitForTimeout(400);
    }
  }

  // ---- select pagetab <title> (in-page navigation tabs inside content) ----
  async selectPageTab(title) {
    const deadline = Date.now() + 10000;
    for (;;) {
      for (const f of await this._candidateFrames()) {
        const found = await f.evaluate(name => {
          const norm = s => (s || '').replace(/\s+/g, ' ').trim();
          for (const t of document.querySelectorAll('.in-page-nav-tabContainer span[role="tab"], span.tabLabel[role="tab"]')) {
            if (!t.offsetParent) continue;
            if (norm(t.title || t.textContent) === name) {
              document.querySelectorAll('[data-curam-replay-target]').forEach(e => e.removeAttribute('data-curam-replay-target'));
              t.setAttribute('data-curam-replay-target', '1');
              return true;
            }
          }
          return false;
        }, title).catch(() => false);
        if (found) {
          await f.locator('[data-curam-replay-target]').click();
          await this._settle(2500);
          return this;
        }
      }
      if (Date.now() > deadline) throw new Error(`no page tab "${title}"`);
      await this.page.waitForTimeout(500);
    }
  }

  // ---- expand/collapse row [in <container>] [at row N] [where ...] ----
  async expandRow(container, step = {}, expand = true) {
    const opt = this._rowOpt(step, 'toggle');
    opt.expand = expand;
    const { frame, res } = await this._rowOp(container, opt);
    if (res.noop) return this; // already in the desired state
    await frame.locator('[data-curam-replay-target]').click();
    await this._settle(3500); // details row lazy-loads its own iframe
    return this;
  }

  // ---- check/uncheck row [in <container>] [at row N] [where ...] ----
  async checkRow(container, step = {}, on = true) {
    const opt = this._rowOpt(step, 'checkbox');
    const { frame } = await this._rowOp(container, opt);
    const cb = frame.locator('[data-curam-replay-target]');
    on ? await cb.check({ force: true }) : await cb.uncheck({ force: true });
    await this._settle(800);
    return this;
  }

  // ---- click rowmenu <item> [in <container>] [at row N] [where ...] ----
  async clickRowMenu(item, container, step = {}) {
    const pre = await this._navSignature();
    const opt = this._rowOpt(step, 'menu');
    const { frame } = await this._rowOp(container, opt);
    await frame.locator('[data-curam-replay-target]').click();
    await this._clickMenuItem(frame, item);
    await this._waitForNav(pre);
    return this;
  }

  // ---- click pagemenu <item> (page-level "..." action menu) ----
  async clickPageMenu(item) {
    const pre = await this._navSignature();
    const deadline = Date.now() + 10000;
    for (;;) {
      for (const f of await this._candidateFrames()) {
        const btn = f.locator('[widgetid="page-level-action-menu"] .dijitButtonNode').first();
        if (await btn.isVisible().catch(() => false)) {
          await btn.click();
          await this._clickMenuItem(f, item);
          await this._waitForNav(pre);
          return this;
        }
      }
      if (Date.now() > deadline) throw new Error('no page-level action menu');
      await this.page.waitForTimeout(500);
    }
  }

  // ---- expect "<label>" is "<value>" (read-only display field) ----
  async expectField(label, value) {
    const deadline = Date.now() + 10000;
    let lastErr = `no display field "${label}"`;
    for (;;) {
      for (const f of await this._candidateFrames()) {
        const res = await f.evaluate(want => {
          const norm = s => (s || '').replace(/\s+/g, ' ').trim();
          for (const item of document.querySelectorAll('.cds--cluster__item--read-only-field')) {
            if (!item.offsetParent) continue;
            // group wrappers nest further read-only fields and would match
            // with a concatenated garbage value — leaf fields only
            if (item.querySelector('.cds--cluster__item--read-only-field')) continue;
            const l = item.querySelector('label');
            if (l && norm(l.textContent) === want) {
              const v = item.querySelector('.cds--field');
              return { found: true, actual: norm(v ? v.textContent : '') };
            }
          }
          return { found: false };
        }, label).catch(() => ({ found: false }));
        if (res.found) {
          const want = value.replace(/\s+/g, ' ').trim();
          const pass = want.includes('*') ? globToRegex(want).test(res.actual) : res.actual === want;
          if (pass) return this;
          lastErr = `"${label}" expected "${value}" but is "${res.actual}"`;
        }
      }
      if (Date.now() > deadline) throw new Error(lastErr);
      await this.page.waitForTimeout(500);
    }
  }

  // ---- expect row [in <container>] [at row N] where Col = "V" ... ----
  // Asserts a data row matching the selection exists in some content table.
  async expectRow(container, step = {}) {
    const opt = this._rowOpt(step, 'assert');
    if (!opt.where && !opt.row) throw new Error('expect row needs "at row N" and/or "where ..."');
    try { await this._rowOp(container, opt); } catch (e) {
      const want = Object.entries(opt.where || {}).map(([k, v]) => `${k} = "${v}"`).join(' and ');
      throw new Error(`no row${container ? ` in "${container}"` : ''}${opt.row ? ` at row ${opt.row}` : ''}${want ? ` where ${want}` : ''} (${e.message})`);
    }
    return this;
  }

  // ---- click link <text> [in <container>] inside content ----
  // step.strategy: {type:'literal'|'row'|'predicate', row?, where?} — tried
  // first, then the other strategies as fallbacks (logged when used).
  async clickContentLink(text, container, step = {}) {
    const strategy = step.strategy || { type: 'literal' };
    const ctx = step.ctx || {};
    const attempts = [strategy.type];
    if (!attempts.includes('literal') && text) attempts.push('literal');
    if (!attempts.includes('row') && ctx.row) attempts.push('row');

    const pre = await this._navSignature();
    let used = null, lastErr = '';
    for (const t of attempts) {
      try {
        if (t === 'literal') {
          const deadline = Date.now() + 8000;
          for (let done = false; !done;) {
            for (const f of await this._candidateFrames()) {
              let scope;
              try { scope = container ? await this._containerScope(f, container, 0) : f.locator('body'); }
              catch { continue; }
              if (text.includes('*')) {
                // wildcard link text ("Bo Stokes - *"): glob-match in-page
                const found = await scope.evaluate((box, pattern) => {
                  const norm = s => (s || '').replace(/\s+/g, ' ').trim();
                  const re = new RegExp('^' + pattern.split('*').map(x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
                  for (const a of box.querySelectorAll('a')) {
                    if (a.offsetParent && re.test(norm(a.textContent))) {
                      document.querySelectorAll('[data-curam-replay-target]').forEach(e => e.removeAttribute('data-curam-replay-target'));
                      a.setAttribute('data-curam-replay-target', '1');
                      return true;
                    }
                  }
                  return false;
                }, text).catch(() => false);
                if (found) { await f.locator('[data-curam-replay-target]').click(); done = true; break; }
                continue;
              }
              // exact text first ("Income" must not hit "Income Discrepancy"),
              // then substring as fallback
              let link = scope.locator(`a:text-is("${text}")`).first();
              if (!(await link.isVisible().catch(() => false))) link = scope.locator(`a:has-text("${text}")`).first();
              if (await link.isVisible().catch(() => false)) { await link.click(); done = true; break; }
            }
            if (!done) {
              if (Date.now() > deadline) throw new Error(`link "${text}" not found`);
              await this.page.waitForTimeout(500);
            }
          }
        } else {
          const opt = { target: 'link', column: ctx.column || '' };
          if (t === 'row') opt.row = strategy.type === 'row' ? strategy.row : ctx.row;
          if (t === 'predicate') { opt.where = strategy.where; if (strategy.row) opt.row = strategy.row; }
          const { frame } = await this._rowOp(container, opt, 8000);
          await frame.locator('[data-curam-replay-target]').click({ timeout: 8000 });
        }
        used = t;
        break;
      } catch (e) { lastErr = e.message.split('\n')[0]; }
    }
    if (!used) throw new Error(`link not found via ${attempts.join(', ')} — ${lastErr}`);
    if (used !== strategy.type) console.log(`    ("${strategy.type}" failed: ${lastErr} — fell back to "${used}")`);
    await this._waitForNav(pre);
    return this;
  }
}

module.exports = { CuramDriver };
