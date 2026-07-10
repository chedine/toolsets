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
        this._activeTabPaneId = (await tabs.nth(i).getAttribute('id')).split('_tablist_')[1];
        return this;
      }
    }
    throw new Error(`No tab matching "${pattern}". Open tabs: ${await tabs.evaluateAll(e => e.map(x => x.title).join(' | '))}`);
  }

  _activePanel() {
    if (this._activeTabPaneId) return this.page.locator(`[id="${this._activeTabPaneId}"]`);
    return this.section.locator('.appTabContainer .dijitTabContainerTopChildWrapper.dijitVisible').last();
  }

  // ---- select nav <title> (navigation bar within active tab) ----
  async selectNav(title) {
    await this._activePanel().locator(`.navigation-bar-tabs span[role="tab"][title="${title}"]`).click();
    await this._settle(3000);
    return this;
  }

  // ---- select navitem <title> (navigation group item in sidebar) ----
  async selectNavItem(title) {
    await this._activePanel().locator(`.child-nav .dijitVisible .child-nav-items li .link[title="${title}"]`).click();
    await this._settle(3500);
    return this;
  }

  // ---- content frame of the active tab ----
  async contentFrame() {
    const el = this._activePanel().locator('iframe[title^="Content Panel"]').last();
    await el.waitFor({ state: 'attached', timeout: 15000 });
    return await (await el.elementHandle()).contentFrame();
  }

  // ---- enter "<value>" as <field label> ----
  async enter(value, label) {
    const frame = await this.contentFrame();
    const input = frame.locator(
      `input[title="${label}"], [data-testid$=".${label.replace(/ /g, '')}"], input[data-testid*="${label.replace(/ /g, '')}"]`
    ).first();
    await input.fill(value);
    return this;
  }

  // ---- click button <label> ----
  async clickButton(label) {
    const frame = await this.contentFrame();
    await frame.click(`.action-set a.first-action-control:has-text("${label}"), .action-set a:has-text("${label}")`);
    await this._settle(4000);
    return this;
  }

  // ---- click link <text> inside content (e.g. search result) ----
  async clickContentLink(text) {
    const frame = await this.contentFrame();
    await frame.locator(`a:has-text("${text}")`).first().click();
    await this._settle(5000);
    return this;
  }
}

module.exports = { CuramDriver };
