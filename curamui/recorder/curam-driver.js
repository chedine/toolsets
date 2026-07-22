// Curam UI driver — each method maps 1:1 to a high-level recorder verb.
// All selectors are title/label-based (human-readable), scoped to avoid ambiguity.

function globToRegex(pattern) {
  return new RegExp('^' + pattern.split('*').map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
}

// `until` polling defaults (ms) — overridable per step via "timeout N interval N"
const UNTIL_TIMEOUT = 600000;  // 10 min — async case processing can take a while
const UNTIL_INTERVAL = 15000;  // 15 s between refresh+recheck

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
    // observable transition: the section's content panel becomes visible
    await this.section.waitFor({ state: 'visible', timeout: 15000 });
    return this;
  }

  _shortcuts() { return this.section.locator('[role="region"][aria-label="Shortcuts"]'); }

  // ---- click shortcut group <title> (expands panel too if collapsed) ----
  async clickShortcutGroup(title) {
    const sc = this._shortcuts();
    if ((await sc.getAttribute('class')).includes('dojoxExpandoClosed')) {
      await sc.locator('.dojoxExpandoIcon').click({ force: true });
      // observable transition: the panel expanded, so its accordion titles show
      await sc.locator('.dijitAccordionText').first().waitFor({ state: 'visible', timeout: 10000 });
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
    const pre = await this._navSignature();
    await link.click();
    await this._waitForNav(pre); // opens a new content tab
    return this;
  }

  _tabStrip() { return this.page.locator(`[id="${this.sectionId.replace('-sbc', '-stc')}_tablist"]`); }

  // ---- select tab <pattern> ('*' wildcards allowed) ----
  async selectTab(pattern) {
    const re = globToRegex(pattern);
    const tabs = this._tabStrip().locator('span[role="tab"]');
    const n = await tabs.count();
    for (let i = 0; i < n; i++) {
      const tab = tabs.nth(i);
      const t = (await tab.getAttribute('title')) || '';
      if (re.test(t.replace(/\s+/g, ' ').trim())) {
        if ((await tab.getAttribute('aria-selected')) === 'true') return this; // already active
        const pre = await this._navSignature();
        await tab.click();
        await this._waitForNav(pre);
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
    const pre = await this._navSignature();
    await (await this._activePanel()).locator(`.navigation-bar-tabs span[role="tab"][title="${title}"]`).click();
    await this._waitForNav(pre); // reloads the tab's content document
    return this;
  }

  // ---- select navitem <title> (navigation group item in sidebar) ----
  async selectNavItem(title) {
    const pre = await this._navSignature();
    await (await this._activePanel()).locator(`.child-nav .dijitVisible .child-nav-items li .link[title="${title}"]`).click();
    await this._waitForNav(pre); // reloads the tab's content document
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
      // short timeouts: a present tab/panel resolves in a few ms; during a
      // wizard (no case content tab) these are ABSENT, and a long timeout here
      // is paid on every snapshot — including the poll loop in _waitForNav
      try { tabId = (await active.getAttribute('id', { timeout: 400 })) || ''; } catch {}
      let doc = '';
      try {
        const panel = this.page.locator(`[id="${tabId.split('_tablist_')[1]}"]`);
        const el = panel.locator('iframe[title^="Content Panel"]').last();
        const f = await (await el.elementHandle({ timeout: 400 })).contentFrame();
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
    let modal = false;
    try {
      const el = this._modalFrameEl();
      if (await el.isVisible().catch(() => false)) { push(await (await el.elementHandle()).contentFrame()); modal = true; }
    } catch {}
    // IEG wizard player + registration wizard — the live frame is reliably in
    // page.frames() by URL; resolving it via the modal iframe element can lag
    // after rapid Next clicks, so include it directly.
    for (const f of this.page.frames()) {
      if (/Screening\.do|IEGPlayer|_ieg|\/ieg\/|RegisterPerson_/i.test(f.url())) { push(f); modal = true; }
    }
    // A modal/wizard owns the form, so the content & context panels behind it
    // aren't involved — skip their active-tab lookups, which otherwise wait
    // out a ~2s timeout PER FIELD when no case tab is open (the wizard case).
    if (!modal) {
      try { push(await this.contentFrame(2500)); } catch {}
      // context panel (banner fields like Decision / Coverage Start Date)
      try {
        const el = (await this._activePanel(1500)).locator('iframe[title^="Context Panel"]').last();
        if (await el.count()) push(await (await el.elementHandle()).contentFrame());
      } catch {}
    }
    return frames;
  }

  // After an action that navigates (link/button/nav click): wait until the
  // signature changes (new tab opened or content doc replaced), then until
  // the new content document is loaded. Falls through after `timeout` for
  // actions that legitimately don't navigate.
  async _waitForNav(pre, timeout = 20000) {
    const deadline = Date.now() + timeout;
    // The observable transition is not "signature differs from pre" — that
    // fires on the transient mid-navigation state (old frame detaching) too.
    // Wait until the signature settles to a NEW, STABLE value (unchanged
    // across consecutive polls), i.e. the new document has actually arrived.
    let last = null, stable = 0;
    while (Date.now() < deadline) {
      await this.page.waitForTimeout(200);
      const sig = await this._navSignature();
      if (!sig || sig === pre) { last = null; stable = 0; continue; }
      if (sig === last) { if (++stable >= 2) break; } else { last = sig; stable = 0; }
    }
    // new DOM parsed; downstream actions poll for their target element, so no
    // fixed settle is needed after this. When a modal/wizard owns the form
    // there is no content panel to wait on — skip it, else contentFrame() burns
    // its full timeout every wizard nav.
    const modalUp = await this._modalFrameEl().isVisible().catch(() => false)
      || this.page.frames().some(f => /Screening\.do|IEGPlayer|_ieg|\/ieg\/|RegisterPerson_/i.test(f.url()));
    if (!modalUp) { try { const f = await this.contentFrame(2500); await f.waitForLoadState('domcontentloaded'); } catch {} }
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
  // Three dialects: native <select>, Carbon combobox (role="combobox"
  // input), and dijit FilteringSelect (IEG wizards: .dijitComboBox wrapper,
  // titled .dijitInputInner, .dijitComboBoxMenu popup).
  async selectOption(value, label) {
    // Title/label matching happens in-page (normalized, tolerant of the
    // " Mandatory" suffix and special chars like parens/periods) rather than
    // via brittle CSS `[title="…"]` selectors. Marks the field, then Playwright
    // clicks the mark.
    const deadline = Date.now() + 18000;
    let lastErr = `no field "${label}"`;
    for (;;) {
      for (const f of await this._candidateFrames()) {
        const kind = await f.evaluate(want => {
          const norm = s => (s || '').replace(/\s+/g, ' ').trim().replace(/ Mandatory$/, '');
          const w = norm(want);
          const key = w.replace(/ /g, '');
          document.querySelectorAll('[data-curam-select-target]').forEach(e => e.removeAttribute('data-curam-select-target'));
          // native <select>
          for (const s of document.querySelectorAll('select')) {
            if (!s.offsetParent) continue;
            const tid = s.getAttribute('data-testid') || '';
            if (norm(s.title) === w || tid.endsWith('.' + key)) { s.setAttribute('data-curam-select-target', '1'); return 'native'; }
          }
          // combobox (Carbon role=combobox or dijit FilteringSelect inner input)
          for (const i of document.querySelectorAll('input[role="combobox"], .dijitComboBox input.dijitInputInner')) {
            if (!i.offsetParent) continue;
            const tid = i.getAttribute('data-testid') || '';
            if (norm(i.title) === w || tid.endsWith('.' + key)) { i.setAttribute('data-curam-select-target', '1'); return 'combo'; }
          }
          return null;
        }, label).catch(() => null);
        if (kind === 'native') { await f.locator('[data-curam-select-target]').selectOption({ label: value }); return this; }
        if (kind !== 'combo') continue;
        const input = f.locator('[data-curam-select-target]');
        // dijit FilteringSelect opens via its arrow button
        const arrow = input.locator('xpath=ancestor::*[contains(@class,"dijitComboBox")][1]//*[contains(@class,"dijitDownArrowButton")]').first();
        if (await arrow.count()) await arrow.click(); else await input.click();
        // options render into a list box (sometimes portaled); poll for them
        const optDeadline = Date.now() + 5000;
        for (;;) {
          const found = await f.evaluate(want => {
            const norm = s => (s || '').replace(/\s+/g, ' ').trim();
            const eq = (a, b) => a.includes('*')
              ? new RegExp('^' + a.split('*').map(x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$').test(b)
              : a === b;
            for (const m of document.querySelectorAll('[role="listbox"], .cds--list-box__menu, .dijitComboBoxMenu')) {
              if (!m.offsetParent) continue;
              for (const o of m.querySelectorAll('[role="option"], li, .dijitMenuItem')) {
                const t = norm(o.textContent);
                if (/^(Previous choices|More choices)$/.test(t)) continue;
                if (eq(norm(want), t)) {
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
      if (Date.now() > deadline) {
        // self-diagnosis: what fields WERE visible?
        const seen = [];
        for (const f of await this._candidateFrames()) {
          const ts = await f.evaluate(() => Array.from(document.querySelectorAll('select, input[role="combobox"], .dijitComboBox input.dijitInputInner')).filter(i => i.offsetParent).map(i => (i.title || '').replace(/ Mandatory$/, '')).filter(Boolean)).catch(() => []);
          seen.push(...ts);
        }
        throw new Error(`${lastErr} — visible fields: [${[...new Set(seen)].map(s => `"${s.slice(0, 45)}"`).join(', ') || 'none'}]`);
      }
      await this.page.waitForTimeout(500);
    }
  }

  // ---- select radio "<label>" ----
  // A radio is identified by its own label (a person name on a tax-dependent
  // page, or an option). The recorded input is a native radio, so check() it.
  // Match title / associated <label> / wrapping label / aria-label, normalized;
  // fall back to a contained-text match.
  async selectRadio(label) {
    const deadline = Date.now() + 12000;
    let lastErr = `no radio "${label}"`;
    for (;;) {
      for (const f of await this._candidateFrames()) {
        const marked = await f.evaluate(want => {
          const norm = s => (s || '').replace(/\s+/g, ' ').trim().replace(/ Mandatory$/, '');
          const w = norm(want);
          const labelOf = r => {
            if (r.title) return norm(r.title);
            if (r.id) { const l = document.querySelector(`label[for="${CSS.escape(r.id)}"]`); if (l) return norm(l.textContent); }
            const wrap = r.closest('label'); if (wrap) return norm(wrap.textContent);
            return norm(r.getAttribute('aria-label'));
          };
          const radios = Array.from(document.querySelectorAll('input[type="radio"]'));
          const vis = radios.filter(r => r.offsetParent !== null);
          const pool = vis.length ? vis : radios; // dijit may hide the input
          const hit = pool.find(r => labelOf(r) === w) || pool.find(r => labelOf(r).includes(w));
          if (!hit) return false;
          document.querySelectorAll('[data-curam-replay-target]').forEach(e => e.removeAttribute('data-curam-replay-target'));
          hit.setAttribute('data-curam-replay-target', '1');
          return true;
        }, label).catch(e => { lastErr = e.message.split('\n')[0]; return false; });
        if (marked) { await f.locator('[data-curam-replay-target]').check({ force: true }); return this; }
      }
      if (Date.now() > deadline) throw new Error(lastErr);
      await this.page.waitForTimeout(500);
    }
  }

  // The IEG wizard player frame + its current page heading, if a wizard is
  // open. IEG swaps page content in place, so the frame's URL/timeOrigin
  // signature doesn't change between pages — the heading text is the only
  // reliable "did we advance?" signal.
  _iegFrame() { return this.page.frames().find(f => /Screening\.do|IEGPlayer|_ieg|\/ieg\//i.test(f.url())); }
  async _iegHeading() {
    const f = this._iegFrame();
    if (!f) return null;
    return f.evaluate(() => (document.querySelector('#ieg-root h1, .page-title-bar .title, h1, h2') || {}).textContent || '').then(s => s.replace(/\s+/g, ' ').trim()).catch(() => null);
  }

  // ---- advance to "<page heading>" ----
  // IEG wizards interleave data pages with intro/summary/pass-through pages
  // whose count varies with earlier answers. Rather than hardcode Next
  // clicks, click Next until the target page heading is reached. Every
  // page in between must have no unfilled mandatory fields (intros/summaries
  // don't) or it will stall.
  async advanceTo(target, timeout = 90000) {
    // exact (normalized, case-insensitive) heading match — substring would
    // stop early on e.g. "... Section" intro pages that contain the target
    const want = target.replace(/\s+/g, ' ').trim().toLowerCase();
    const deadline = Date.now() + timeout;
    let last = null, sameCount = 0;
    for (;;) {
      const h = await this._iegHeading();
      if (h == null) throw new Error(`advance to "${target}": no IEG wizard open`);
      if (h.toLowerCase() === want) return this;
      if (h === last) {
        if (++sameCount > 3) throw new Error(`advance to "${target}": stuck on "${h}" (unfilled mandatory?)`);
      } else { sameCount = 0; last = h; }
      if (Date.now() > deadline) throw new Error(`advance to "${target}": not reached (last "${h}")`);
      // click the IEG Next and wait for the heading to change
      const f = this._iegFrame();
      const clicked = await f.evaluate(() => {
        const n = s => (s || '').replace(/\s+/g, ' ').trim();
        document.querySelectorAll('[data-curam-replay-target]').forEach(e => e.removeAttribute('data-curam-replay-target'));
        const b = Array.from(document.querySelectorAll('a.buttonLink, button, input[type=submit]')).filter(x => x.offsetParent).find(x => /^next$/i.test(n(x.textContent) || x.value || ''));
        if (!b) return false;
        b.setAttribute('data-curam-replay-target', '1');
        return true;
      }).catch(() => false);
      if (!clicked) throw new Error(`advance to "${target}": no Next on "${h}"`);
      await f.locator('[data-curam-replay-target]').click();
      await this._waitForIegAdvance(h);
    }
  }

  // ---- click button <label> ----
  // Modal footer buttons (Save/Cancel of Carbon modals) live in the TOP
  // document; page action buttons live in .action-set inside content frames;
  // IEG wizard buttons are a.buttonLink inside the player frame.
  async clickButton(label) {
    const iegBefore = await this._iegHeading();
    // IEG Next/Back settle on the heading change, not the nav signature — skip
    // the signature snapshot (a few costly timeouts) when we won't use it
    const pre = iegBefore === null ? await this._navSignature() : null;
    const deadline = Date.now() + 15000;
    for (;;) {
      const modalBtn = this.page.locator('.cds--modal-container button.cds--btn', { hasText: label }).last();
      if (await modalBtn.isVisible().catch(() => false)) {
        await modalBtn.click();
        await this._waitForNav(pre);
        return this;
      }
      for (const f of await this._candidateFrames()) {
        // .action-set = normal Curam pages; a.buttonLink = IEG wizards
        const b = f.locator(`.action-set a.first-action-control:has-text("${label}"), .action-set a:has-text("${label}"), a.buttonLink:text-is("${label}")`).first();
        if (await b.isVisible().catch(() => false)) {
          await b.click();
          // IEG Next/Back: wait until the page heading changes (content
          // swaps in place) or a validation banner appears, since the nav
          // signature can't see an in-place content swap.
          if (iegBefore !== null && /^(next|back|continue)$/i.test(label)) await this._waitForIegAdvance(iegBefore);
          else await this._waitForNav(pre);
          return this;
        }
      }
      if (Date.now() > deadline) throw new Error(`no button "${label}"`);
      await this.page.waitForTimeout(500);
    }
  }

  // Wait for an IEG page transition to complete: the heading changes (moved
  // to a new page) or an error notification appears (validation blocked us
  // on the same page). Falls through after the timeout.
  async _waitForIegAdvance(before, timeout = 15000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      await this.page.waitForTimeout(400);
      const f = this._iegFrame();
      if (!f) break; // wizard closed (submitted / exited)
      const state = await f.evaluate(() => {
        const n = s => (s || '').replace(/\s+/g, ' ').trim();
        const h = document.querySelector('#ieg-root h1, .page-title-bar .title, h1, h2');
        const err = document.querySelector('[class*="error"]');
        return { title: h ? n(h.textContent) : '', hasErr: !!(err && err.offsetParent) };
      }).catch(() => null);
      if (!state) break;
      if (state.title && state.title !== before) break; // advanced
      if (state.hasErr) break; // blocked by validation on the same page
    }
    // IEG swaps the whole page DOM in place, so a changed heading means the
    // new fields are already present — downstream passes read them directly.
  }

  // ===================================================================
  // IEG application wizard: profile-driven filler (`fill application ...`)
  //
  // Drives an already-open New Application wizard to submission from a
  // declarative profile:
  //   answers:       { "<question regex>": "<value>" }  (dropdowns & text)
  //   checks:        [ "<checkbox regex>" ]             (checkboxes to tick)
  //   members:       [ { firstName, lastName, gender, maritalStatus, dob } ]
  //   relationships: [ { between: [A, B], value } ]
  //   strict:        true (default) -> error on any unmapped mandatory field
  // Questions embed member names ("Does Mara have any income?"), so answer
  // keys are regexes matched name-agnostically.
  // ===================================================================

  _norm(s) { return (s || '').replace(/[​‌‍]/g, '').replace(/\s+/g, ' ').trim().replace(/[.?!:;]+$/, ''); }

  // profile answer for a field label (regex keys, first match wins)
  _profileAnswer(profile, label) {
    const L = this._norm(label);
    for (const [pat, val] of Object.entries(profile.answers || {})) {
      let ok = false;
      try { ok = new RegExp(pat, 'i').test(L); } catch { ok = L.toLowerCase().includes(pat.toLowerCase()); }
      if (ok) return String(val);
    }
    return null;
  }

  // tick any checkbox matching a profile.checks pattern (in-page, fast)
  async _tickChecks(profile) {
    if (!(profile.checks || []).length) return;
    const f = this._iegFrame(); if (!f) return;
    const n = await f.evaluate(pats => {
      const norm = s => (s || '').replace(/\s+/g, ' ').trim();
      let c = 0;
      for (const cb of document.querySelectorAll('input[type="checkbox"]')) {
        if (!cb.offsetParent || cb.checked) continue;
        let t = cb.title || '';
        if (!t && cb.id) { const l = document.querySelector(`label[for="${CSS.escape(cb.id)}"]`); t = l ? l.textContent : ''; }
        t = norm(t);
        if (pats.some(p => { try { return new RegExp(p, 'i').test(t); } catch { return t.toLowerCase().includes(p.toLowerCase()); } })) { cb.click(); c++; }
      }
      return c;
    }, profile.checks).catch(() => 0);
  }

  // First-name slot empty on a Household Member Details page?
  async _memberSlotEmpty() {
    const f = this._iegFrame(); if (!f) return false;
    return f.evaluate(() => { const i = document.querySelector('input.dijitInputInner[title^="First Name"]') || document.querySelector('input[title^="First Name"]'); return i ? !i.value.trim() : false; }).catch(() => false);
  }

  async _fillMemberIdentity(m) {
    await this.enter(m.firstName, 'First Name');
    if (m.lastName) await this.enter(m.lastName, 'Last Name');
    if (m.gender) await this.selectOption(m.gender, 'Gender');
    if (m.maritalStatus) await this.selectOption(m.maritalStatus, 'Marital Status');
    if (m.dob) await this.enter(m.dob, 'Date of Birth');
  }

  // Answer the household add-loop combo if present: Yes while members remain.
  async _answerAddLoop(hasMore) {
    const f = this._iegFrame(); if (!f) return;
    const q = await f.evaluate(() => {
      for (const i of document.querySelectorAll('.dijitComboBox input.dijitInputInner')) {
        if (!i.offsetParent) continue;
        const t = (i.title || '').replace(/ Mandatory$/, '');
        if (/anyone else in the household|add any more people/i.test(t)) return t;
      }
      return null;
    }).catch(() => null);
    if (q) await this.selectOption(hasMore ? 'Yes' : 'No', q);
  }

  // Fill visible text/date inputs (e.g. Application Date) from the profile.
  async _answerVisibleTexts(profile) {
    const f = this._iegFrame(); if (!f) return;
    const fields = await f.evaluate(() => Array.from(document.querySelectorAll('input[type=text]:not(.dijitInputInner), textarea')).filter(i => i.offsetParent && i.title).map(i => (i.title || '').replace(/ Mandatory$/, ''))).catch(() => []);
    for (const label of fields) {
      const val = this._profileAnswer(profile, label);
      if (val != null) { try { await this.enter(val, label); } catch {} }
    }
  }

  // Fill every visible uncommitted mandatory dropdown from the profile.
  // Multi-pass to handle dependent dropdowns (County depends on State) that
  // reset when their parent changes.
  async _answerVisibleDropdowns(profile) {
    for (let pass = 0; pass < 4; pass++) {
      const f = this._iegFrame(); if (!f) return;
      const pending = await f.evaluate(() => {
        const out = [];
        for (const box of document.querySelectorAll('.dijitComboBox')) {
          const disp = box.querySelector('input.dijitInputInner');
          if (!disp || !disp.offsetParent) continue;
          const row = box.closest('tr') || box.parentElement;
          const mand = (!!row && !!(row.querySelector('.mandatory') || row.querySelector('img[alt="Mandatory"]'))) || / Mandatory$/.test(disp.title || '');
          if (!mand) continue;
          const hidden = box.querySelector('input[type=hidden]');
          const committed = hidden ? !!(hidden.value || '').trim() : !!(disp.value || '').trim();
          if (!committed) out.push((disp.title || '').replace(/ Mandatory$/, ''));
        }
        return out;
      }).catch(() => []);
      if (!pending.length) return;
      let did = 0;
      for (const label of pending) {
        const val = this._profileAnswer(profile, label);
        if (val != null) { try { await this.selectOption(val, label); did++; } catch {} }
      }
      if (!did) return;
    }
  }

  // Resolve a field named in a "must be entered" error, given its value.
  // Locates by title, then by visible label text -> table row -> control.
  async _resolveNamedField(label, value) {
    const f = this._iegFrame(); if (!f) return false;
    const kind = await f.evaluate(lbl => {
      const strip = t => (t || '').replace(/[​‌‍]/g, '').replace(/\s+/g, ' ').trim().replace(/ Mandatory$/, '').replace(/[.?!:;]+$/, '');
      const L = strip(lbl);
      document.querySelectorAll('[data-curam-resolve]').forEach(e => e.removeAttribute('data-curam-resolve'));
      const byTitle = sel => Array.from(document.querySelectorAll(sel)).find(i => i.offsetParent && strip(i.title) === L);
      let el = byTitle('.dijitComboBox input.dijitInputInner');
      if (el) { el.closest('.dijitComboBox').setAttribute('data-curam-resolve', '1'); return 'combo'; }
      el = byTitle('select'); if (el) { el.setAttribute('data-curam-resolve', '1'); return 'select'; }
      el = byTitle('input[type=text]:not(.dijitInputInner), textarea'); if (el) { el.setAttribute('data-curam-resolve', '1'); return /date/i.test(el.title) ? 'date' : 'text'; }
      // by label element -> row -> control
      let lblEl = null;
      for (const e of document.querySelectorAll('label,span,td,div,legend')) if (strip(e.textContent) === L) lblEl = e;
      if (!lblEl) return null;
      const row = lblEl.closest('tr') || lblEl.parentElement; if (!row) return null;
      const combo = row.querySelector('.dijitComboBox'); if (combo) { combo.setAttribute('data-curam-resolve', '1'); return 'combo'; }
      const sel = row.querySelector('select'); if (sel) { sel.setAttribute('data-curam-resolve', '1'); return 'select'; }
      const cb = row.querySelector('input[type=checkbox]'); if (cb) { cb.setAttribute('data-curam-resolve', '1'); return 'checkbox'; }
      const txt = row.querySelector('input[type=text], textarea'); if (txt) { txt.setAttribute('data-curam-resolve', '1'); return /date/i.test(txt.title || '') ? 'date' : 'text'; }
      return null;
    }, label).catch(() => null);
    if (!kind) return false;
    try {
      if (kind === 'combo') return await this._selectMarkedCombo(value);
      if (kind === 'select') { await f.locator('[data-curam-resolve]').selectOption({ label: value }); return true; }
      if (kind === 'checkbox') { await f.locator('[data-curam-resolve]').check({ force: true }); return true; }
      if (kind === 'date') { await f.locator('[data-curam-resolve]').fill(value); await f.locator('[data-curam-resolve]').press('Tab'); return true; }
      if (kind === 'text') { await f.locator('[data-curam-resolve]').fill(value); return true; }
    } catch { return false; }
    return false;
  }

  // Open the marked dijit combo and pick the option whose text matches value
  // ('*' wildcard supported).
  async _selectMarkedCombo(value) {
    const f = this._iegFrame();
    const arrow = f.locator('[data-curam-resolve] .dijitDownArrowButton');
    if (await arrow.count()) await arrow.click(); else await f.locator('[data-curam-resolve] input.dijitInputInner').click();
    await this.page.waitForTimeout(500);
    const found = await f.evaluate(want => {
      const norm = s => (s || '').replace(/\s+/g, ' ').trim();
      const eq = (a, b) => a.includes('*') ? new RegExp('^' + a.split('*').map(x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i').test(b) : a.toLowerCase() === b.toLowerCase();
      document.querySelectorAll('[data-curam-opt]').forEach(e => e.removeAttribute('data-curam-opt'));
      for (const m of document.querySelectorAll('.dijitComboBoxMenu')) {
        if (!m.offsetParent) continue;
        for (const o of m.querySelectorAll('.dijitMenuItem')) {
          const t = norm(o.textContent);
          if (/^(Previous choices|More choices|--Please Select--)$/.test(t)) continue;
          if (eq(norm(want), t)) { o.setAttribute('data-curam-opt', '1'); return true; }
        }
      }
      return false;
    }, value).catch(() => false);
    if (found) {
      await f.locator('[data-curam-opt]').click();
      await this.page.waitForTimeout(300);
      return true;
    }
    // fallback: type the value into the FilteringSelect input and commit with
    // Enter (robust when the option menu is paged/virtualized or the label is
    // very long). Verify the hidden value committed.
    try {
      const inp = f.locator('[data-curam-resolve] input.dijitInputInner');
      await inp.click();
      await inp.fill(value);
      await this.page.waitForTimeout(400);
      await inp.press('Enter');
      await this.page.waitForTimeout(300);
      const committed = await f.evaluate(() => { const b = document.querySelector('[data-curam-resolve]'); const h = b && b.querySelector('input[type=hidden]'); return h ? !!(h.value || '').trim() : true; }).catch(() => false);
      return committed;
    } catch { return false; }
  }

  // Relationships page: set each dropdown the page shows, matched to a profile
  // relationship by the two names in its title. IEG only asks the applicant's
  // relationship to each member (member-to-member is inferred) and renders all
  // those dropdowns on the applicant's tab, so no tab-walking is needed. If a
  // larger household ever splits dropdowns across person tabs, re-add tab
  // iteration here with an observable wait for the switch.
  async _fillRelationships(profile) {
    const rels = profile.relationships || [];
    if (!rels.length) return;
    const f = this._iegFrame();
    const relRe = ([A, B]) => {
      const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`\\b${esc(A)}\\b.*\\b${esc(B)}\\b|\\b${esc(B)}\\b.*\\b${esc(A)}\\b`, 'i');
    };
    const titles = await f.evaluate(() => Array.from(document.querySelectorAll('.dijitComboBox input.dijitInputInner')).filter(i => i.offsetParent && /between .* and /i.test(i.title || '')).map(i => (i.title || '').replace(/ Mandatory$/, ''))).catch(() => []);
    for (const title of titles) {
      const rel = rels.find(r => relRe(r.between).test(title));
      if (!rel) {
        if (profile.strict !== false) throw new Error(`no profile relationship for "${title}" — add it to relationships`);
        continue;
      }
      try { await this.selectOption(rel.value, title); } catch (e) { throw new Error(`could not set "${title}" = "${rel.value}": ${e.message.split('\n')[0]}`); }
    }
  }

  // Click Next; if blocked, resolve every "must be entered" field from the
  // profile. Strict: an unmapped mandatory field aborts with a clear error.
  async _advanceApplication(profile) {
    for (let tri = 0; tri < 8; tri++) {
      const before = await this._iegHeading();
      await this.clickButton('Next');
      const after = await this._iegHeading();
      if (after === null) return 'closed';
      if (after !== before) return true;
      const missing = await this._iegFrame().evaluate(() => {
        const clean = s => (s || '').replace(/[​‌‍]/g, '').replace(/\s+/g, ' ').trim();
        return [...new Set((document.body.textContent.match(/'[^']+' must be entered/g) || []).map(m => clean(m.replace(/^'/, '').replace(/' must be entered$/, ''))))];
      }).catch(() => []);
      if (!missing.length) return false;
      let progress = false;
      const unmapped = [];
      for (const label of missing) {
        const val = this._profileAnswer(profile, label);
        if (val == null) { unmapped.push(label); continue; }
        if (await this._resolveNamedField(label, val)) progress = true;
      }
      // a "Select all the reasons..." style requirement is satisfied by the
      // profile's checkboxes, not a value — tick them and treat as progress
      if (unmapped.length) {
        const before = unmapped.length;
        await this._answerVisibleDropdowns(profile);
        await this._tickChecks(profile);
        const still = await this._iegFrame().evaluate(() => {
          const clean = s => (s || '').replace(/[​‌‍]/g, '').replace(/\s+/g, ' ').trim();
          return [...new Set((document.body.textContent.match(/'[^']+' must be entered/g) || []).map(m => clean(m.replace(/^'/, '').replace(/' must be entered$/, ''))))];
        }).catch(() => unmapped);
        const stillUnmapped = still.filter(l => this._profileAnswer(profile, l) == null);
        if (stillUnmapped.length < before || still.length < missing.length) { progress = true; unmapped.length = 0; unmapped.push(...stillUnmapped); }
      }
      if (unmapped.length && profile.strict !== false) {
        throw new Error(`unmapped mandatory field(s) on "${before}": ${unmapped.map(l => `"${l}"`).join(', ')} — add to the profile's answers`);
      }
      if (!progress) return false;
    }
    return false;
  }

  // The two Carbon consent dialogs after the IEG wizard closes.
  async _submitApplicationDialogs() {
    for (let i = 0; i < 2; i++) {
      await this.checkAll();
      await this.clickButton('Submit');
    }
  }

  // ---- fill application from <profile> ----
  async fillApplication(profile) {
    const queue = [...(profile.members || [])];
    let prev = null, sameCount = 0;
    for (let step = 0; step < 120; step++) {
      const h = await this._iegHeading();
      if (h == null) { await this._submitApplicationDialogs(); return this; }
      // structural handlers for the current page
      if (/Household Member Details/i.test(h) && await this._memberSlotEmpty() && queue.length) {
        await this._fillMemberIdentity(queue.shift());
      }
      await this._answerAddLoop(queue.length > 0);
      if (/^Relationships$/i.test(h)) await this._fillRelationships(profile);
      await this._answerVisibleTexts(profile);
      await this._answerVisibleDropdowns(profile);
      // checks after dropdowns: a dropdown answer can reveal a checkbox group
      // (e.g. "meet an exception = Yes" -> "Select all the reasons that apply")
      await this._tickChecks(profile);
      // advance (error-driven, strict)
      const res = await this._advanceApplication(profile);
      if (res === 'closed') { await this._submitApplicationDialogs(); return this; }
      if (!res) {
        if (h === prev && ++sameCount > 2) throw new Error(`stuck on IEG page "${h}"`);
      } else sameCount = 0;
      prev = h;
    }
    throw new Error('fillApplication: exceeded page limit');
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
      const mark = t => { document.querySelectorAll('[data-curam-replay-target]').forEach(e => e.removeAttribute('data-curam-replay-target')); t.setAttribute('data-curam-replay-target', '1'); };
      // Positional checkbox (no column predicate): pick the Nth VISIBLE
      // checkbox in the scope directly. IEG agreement/confirmation checkboxes
      // sit in a tbody tr among several layout tables, so resolving "row N" via
      // the first table misses them.
      if (opt.target === 'checkbox' && !opt.where) {
        const cbs = Array.from(box.querySelectorAll('input[type="checkbox"]')).filter(c => c.offsetParent !== null);
        let target;
        if (opt.cbIndex) {
          // recorder captured this checkbox's ordinal among the scope's boxes
          target = cbs[opt.cbIndex - 1];
        } else {
          // legacy recordings (no cbIndex): several steps can target the same
          // position to select multiple boxes in one row. A box already in the
          // desired state makes check()/uncheck() a no-op, so count only boxes
          // still needing the toggle and take the Nth of those.
          const want = opt.on !== false;
          const pending = cbs.filter(c => c.checked !== want);
          target = pending[(opt.row || 1) - 1] || cbs[(opt.row || 1) - 1];
        }
        if (!target) return { error: `no visible checkbox at position ${opt.cbIndex || opt.row || 1}` };
        mark(target);
        return { ok: true };
      }
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
    if (ctx.cbIndex) opt.cbIndex = ctx.cbIndex;
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
          const tab = f.locator('[data-curam-replay-target]');
          await tab.click();
          // observable: the clicked in-page tab becomes selected
          await tab.and(f.locator('[aria-selected="true"]')).waitFor({ timeout: 8000 }).catch(() => {});
          return this;
        }
      }
      if (Date.now() > deadline) throw new Error(`no page tab "${title}"`);
      await this.page.waitForTimeout(300);
    }
  }

  // ---- expand/collapse row [in <container>] [at row N] [where ...] ----
  async expandRow(container, step = {}, expand = true) {
    const opt = this._rowOpt(step, 'toggle');
    opt.expand = expand;
    const { frame, res } = await this._rowOp(container, opt);
    if (res.noop) return this; // already in the desired state
    const toggle = frame.locator('[data-curam-replay-target]');
    await toggle.click();
    // observable: the toggle reaches the target expanded state. On expand the
    // details row lazy-loads a nested iframe; downstream actions poll that
    // frame, so we only need the state flip here, not a fixed wait.
    await frame.locator(`[data-curam-replay-target][aria-expanded="${expand}"]`).waitFor({ state: 'attached', timeout: 10000 }).catch(() => {});
    return this;
  }

  // ---- check/uncheck row [in <container>] [at row N] [where ...] ----
  async checkRow(container, step = {}, on = true) {
    const opt = this._rowOpt(step, 'checkbox');
    opt.on = on; // lets legacy positional resolution skip already-set boxes
    const { frame } = await this._rowOp(container, opt);
    const cb = frame.locator('[data-curam-replay-target]');
    // check()/uncheck() resolve once the box is in the target state; no wait
    on ? await cb.check({ force: true }) : await cb.uncheck({ force: true });
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

  // ---- check/uncheck "<label>" ----
  // Checkbox by title or associated <label for>. Long labels (IEG agreement
  // text) match by prefix; '*' wildcards allowed.
  async setCheckbox(label, on = true) {
    const deadline = Date.now() + 10000;
    for (;;) {
      for (const f of await this._candidateFrames()) {
        const found = await f.evaluate(([want, on]) => {
          const norm = s => (s || '').replace(/\s+/g, ' ').trim();
          const w = norm(want);
          const match = t => {
            t = norm(t);
            if (w.includes('*')) return new RegExp('^' + w.split('*').map(x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$').test(t);
            return t === w || t.startsWith(w);
          };
          // resolve a checkbox's label the same way the recorder does
          // (checkboxLabel): title / testid Label.X / label[for] / wrapping
          // label / aria-label
          const labelOf = cb => {
            if (cb.title) return cb.title.replace(/\s+Mandatory$/, '');
            const tid = cb.getAttribute('data-testid') || cb.getAttribute('data-rawtestid') || '';
            const m = tid.match(/Label\.([A-Za-z0-9]+)$/);
            if (m) return m[1].replace(/([a-z])([A-Z])/g, '$1 $2');
            if (cb.id) { const l = document.querySelector(`label[for="${CSS.escape(cb.id)}"]`); if (l && l.textContent.trim()) return l.textContent; }
            const wrap = cb.closest('label'); if (wrap && wrap.textContent.trim()) return wrap.textContent;
            return cb.getAttribute('aria-label') || '';
          };
          const matches = Array.from(document.querySelectorAll('input[type="checkbox"]'))
            .filter(cb => cb.offsetParent && match(labelOf(cb)));
          if (!matches.length) return false;
          // several checkboxes can share a label (repeated consent lines on a
          // submit page) — one already in the desired state would no-op, so tick
          // the first still needing the toggle
          const target = matches.find(cb => cb.checked !== on) || matches[0];
          if (target.checked !== on) target.click();
          return true;
        }, [label, on]).catch(() => false);
        if (found) return this;
      }
      if (Date.now() > deadline) throw new Error(`no checkbox "${label}"`);
      await this.page.waitForTimeout(500);
    }
  }

  // ---- check all [checkboxes] ----
  // Ticks every visible checkbox in content (consent/signature pages where
  // labels repeat, so per-label matching can't disambiguate). Returns the
  // count so callers can assert something was actually checked.
  async checkAll() {
    const deadline = Date.now() + 8000;
    for (;;) {
      let total = 0;
      // top-document Carbon modal checkboxes (submit/consent dialogs)
      total += await this.page.evaluate(() => {
        let n = 0;
        for (const cb of document.querySelectorAll('.cds--modal-container input[type="checkbox"]')) {
          if (cb.offsetParent && !cb.checked) { cb.click(); n++; }
        }
        return n;
      }).catch(() => 0);
      for (const f of await this._candidateFrames()) {
        total += await f.evaluate(() => {
          let n = 0;
          for (const cb of document.querySelectorAll('input[type="checkbox"]')) {
            if (cb.offsetParent && !cb.checked) { cb.click(); n++; }
          }
          return n;
        }).catch(() => 0);
      }
      if (total > 0) return this;
      if (Date.now() > deadline) throw new Error('no checkboxes to check');
      await this.page.waitForTimeout(500);
    }
  }

  // ---- click tabmenu <item> (tab actions "..." menu, top right of tab) ----
  async clickTabMenu(item) {
    const pre = await this._navSignature();
    const panel = await this._activePanel();
    const btn = panel.locator('[widgetid^="actionsButton"] .dijitButtonNode, .dijitDropDownButton .dijitButtonNode').first();
    await btn.click();
    await this._clickMenuItem(this.page, item); // popup renders in the top document
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
  // Read a read-only display field's value from the current content, once.
  async _readDisplayField(label) {
    for (const f of await this._candidateFrames()) {
      const res = await f.evaluate(want => {
        const norm = s => (s || '').replace(/\s+/g, ' ').trim();
        for (const item of document.querySelectorAll('.cds--cluster__item--read-only-field')) {
          if (!item.offsetParent) continue;
          // group wrappers nest further read-only fields and would match with a
          // concatenated garbage value — leaf fields only
          if (item.querySelector('.cds--cluster__item--read-only-field')) continue;
          const l = item.querySelector('label');
          if (l && norm(l.textContent) === want) {
            const v = item.querySelector('.cds--field');
            return { found: true, actual: norm(v ? v.textContent : '') };
          }
        }
        return { found: false };
      }, label).catch(() => ({ found: false }));
      if (res.found) return res;
    }
    return { found: false, actual: '' };
  }

  _valueMatches(want, actual) {
    want = (want || '').replace(/\s+/g, ' ').trim();
    return want.includes('*') ? globToRegex(want).test(actual) : actual === want;
  }

  async expectField(label, value) {
    const deadline = Date.now() + 10000;
    let lastErr = `no display field "${label}"`;
    for (;;) {
      const res = await this._readDisplayField(label);
      if (res.found) {
        if (this._valueMatches(value, res.actual)) return this;
        lastErr = `"${label}" expected "${value}" but is "${res.actual}"`;
      }
      if (Date.now() > deadline) throw new Error(lastErr);
      await this.page.waitForTimeout(500);
    }
  }

  // Click the content-panel refresh control (Curam pageRefresh) and wait for
  // the content document to reload. Returns false if the page has none.
  async _refreshContent() {
    const pre = await this._navSignature();
    for (const f of await this._candidateFrames()) {
      const clicked = await f.evaluate(() => {
        const vis = e => e.offsetParent !== null || (e.getClientRects && e.getClientRects().length > 0);
        const cands = Array.from(document.querySelectorAll('a.refresh')).filter(vis);
        // the active control carries the pageRefresh handler; a disabled twin
        // may share the class
        const hit = cands.find(a => /pageRefresh/.test(a.getAttribute('onclick') || '')) || cands[0];
        if (!hit) return false;
        hit.click();
        return true;
      }).catch(() => false);
      if (clicked) { await this._waitForNav(pre); return true; }
    }
    return false;
  }

  // ---- until "<label>" is "<value>" ----
  // Poll a display field until it reaches the value, clicking the content-panel
  // refresh between polls (async server processing doesn't push updates). Fails
  // if the page has no refresh control, or on timeout.
  async until(label, value, opts = {}) {
    const timeout = opts.timeout || UNTIL_TIMEOUT;
    const interval = opts.interval || UNTIL_INTERVAL;
    const deadline = Date.now() + timeout;
    for (;;) {
      const res = await this._readDisplayField(label);
      if (res.found && this._valueMatches(value, res.actual)) return this;
      if (Date.now() >= deadline) {
        throw new Error(res.found
          ? `until "${label}" is "${value}" timed out after ${Math.round(timeout / 1000)}s (last: "${res.actual}")`
          : `until: no display field "${label}"`);
      }
      await this.page.waitForTimeout(Math.min(interval, Math.max(0, deadline - Date.now())));
      if (!await this._refreshContent()) throw new Error('until: no content-panel refresh control on this page');
    }
  }

  // ---- until row [in "<container>"] [at row N] where Col = "V" ... ----
  // Poll until a row matching the selection exists, refreshing between polls.
  async untilRow(container, step = {}, opts = {}) {
    const opt = this._rowOpt(step, 'assert');
    if (!opt.where && !opt.row) throw new Error('until row needs "at row N" and/or "where ..."');
    const timeout = opts.timeout || UNTIL_TIMEOUT;
    const interval = opts.interval || UNTIL_INTERVAL;
    const deadline = Date.now() + timeout;
    for (;;) {
      try { await this._rowOp(container, opt, 3000); return this; }
      catch (e) {
        if (Date.now() >= deadline) {
          const want = Object.entries(opt.where || {}).map(([k, v]) => `${k} = "${v}"`).join(' and ');
          throw new Error(`until row${container ? ` in "${container}"` : ''}${opt.row ? ` at row ${opt.row}` : ''}${want ? ` where ${want}` : ''} timed out after ${Math.round(timeout / 1000)}s (${e.message})`);
        }
      }
      await this.page.waitForTimeout(Math.min(interval, Math.max(0, deadline - Date.now())));
      if (!await this._refreshContent()) throw new Error('until: no content-panel refresh control on this page');
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
