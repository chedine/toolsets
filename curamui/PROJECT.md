# Curam UI Automation — Project Notes

_Last updated: 2026-07-10_

## Motivation

Curam (Merative Social Program Management) test automation is notoriously
brittle: the UI is a deep Dojo/Carbon hybrid, almost all page content is
served inside iframes, and most generated ids are creation-order counters
(`dijit_layout_AccordionPane_3`, `dojox_layout_ContentPane_7`, `__o3id5`)
that change between sessions. Hand-written scripts against those ids rot
immediately.

Goals, in order:

1. **Prove the UI is automatable** with *durable* selectors (done).
2. **Record user actions as high-level, human-readable steps** — the kind a
   business analyst could read and edit (done, first iteration):

   ```
   click section "HCR Cases and Outcomes"
   click shortcutgroup "Searches"
   click shortcutitem Searches > Person
   enter "bo" as First Name
   click button "Search"
   click link "10000401" in "Current Cases"
   select nav "Determinations"
   ```

3. **Replay recordings** as smoke/regression tests (done, first iteration).
4. Later: assertions/verification steps, parameterized recordings (test
   data separated from the script), suites.

Deliberately **not** a Chrome extension — a Node script launches the browser
(Playwright) and injects the recorder, which keeps installation trivial and
gives us the full Playwright API for replay.

## Environment

- Local Curam app exposed via ngrok: configured in `recorder/config.json`
  (`url`). ngrok free tier needs the `ngrok-skip-browser-warning` request
  header (configured as `extraHTTPHeaders`).
- Single route: everything happens under `Curam/AppController.do`. Session
  state (open tabs, collapsed panels) is restored server-side per user, so
  scripts always start by **closing all tabs** (right-click a tab → "Close
  All") and reloading. Recorder and replayer both do this (`--no-clean` to
  skip).
- Test user: HCR CASE WORKER; dummy data (Francis Mertz, Bo Stokes, case
  refs 10000387/10000401/10000402…).

## UI anatomy & durable selectors (verified against the live app)

Terminology follows the Curam Web Client Reference Manual.

**Key discovery: all application chrome lives in the TOP document.** Only
leaf page content is iframed. Sections, shortcuts, tab strips, navigation
bars, and navigation groups are all directly reachable — no frame juggling
for navigation.

| Concept | What it is | Durable selector |
|---|---|---|
| Application section | Top tabs (Home, HCR Cases and Outcomes, Inbox, Calendar) | `#app-sections-container-dc_tablist span[role="tab"][title="<label>"]` |
| Shortcuts panel | Left sidecar per section | section panel → `[role="region"][aria-label="Shortcuts"]`; collapsed state = class `dojoxExpandoClosed`, expand via `.dojoxExpandoIcon` (force click) |
| Shortcut group | Accordion in shortcuts panel | `.dijitAccordionText[title="<label>"]`; pane = `[data-dojo-type="dijit/layout/AccordionPane"][aria-label="<label>"]` |
| Shortcut item | Link in a group | `a.curam-content-pane-single-link[title="<label>…"]` **scoped to its group** — titles duplicate across groups ("Person…" is under both Searches and Registration). The `onclick` carries the UIM page id (e.g. `Person_search1`) as an alternative durable hook |
| Dynamic tab | Case/person tabs in a section | section's `…-stc_tablist span[role="tab"]` by `title`; **never** match on reference numbers — generalize to `*` ("Insurance Affordability * - Bo Stokes"). Tab id suffix after `_tablist_` = its panel id (`dojox_layout_ContentPane_N`) |
| Navigation bar | Tabs inside a tab (Home, Evidence…) | active panel → `.navigation-bar-tabs span[role="tab"][title="<label>"]`; id suffixes are config-derived (`-EvidenceFolder`) |
| Navigation group | Sidebar inside a nav item | active panel → `.child-nav .dijitVisible .child-nav-items li .link[title="<label>"]`; li ids are config ids (`EvidenceFolder-Active`) but must be panel-scoped (duplicate across same-type tabs) |
| Content iframe | Page content of active tab | active panel → `iframe[title^="Content Panel"]`. **Iframe titles are "Content Panel - <SECTION title>", not the page title, and duplicate across tabs** — never match by title alone. Context panel iframe: `title^="Context Panel"`; smart panel: `name="curam_tab_SmartPanelIframe"` |
| Form fields | Inside content iframes | `data-testid` derived from UIM label keys: `textinput_Cluster.Field.Label.LastName`, `checkbox_Field.Label.Nickname`, `date_Field.Label.DateOfBirth`, `dropdown_Cluster.Field.Label.Gender`. Input `title` = visible label |
| Action buttons | Search/Save/etc. | the real `<input type="submit">` is hidden (`aria-hidden`, has `data-rawtestid`); click the visible `.action-set a.first-action-control` anchor by text |
| Lists/clusters | Tables & sections in content | container `div[data-testid^="list_"]` / `[data-testid^="cluster_"]` with `.cds--accordion__title` heading. Inner divs share the prefix (`list_content_…`, `list_heading_…`) — climb to the outer one |

Anti-patterns (all verified brittle): iframe `name` attrs (GUIDs),
`dijit_layout_*` / `dojox_layout_*` / `__o3id*` / `__o3uid*` ids, matching
tabs by full title with reference numbers, iframe title equality.

## Recorder / replayer (`recorder/`)

```
recorder/
  config.json       url, dataDir, cleanTabsOnStart, extraHTTPHeaders, viewport
  record.js         CLI: launch browser, clean tabs, inject recorder, save recordings
  injected.js       runs in every frame: classifies DOM events -> verbs; overlay UI (top frame)
  curam-driver.js   verb-per-method Playwright driver (used by replay)
  replay.js         CLI: replay a saved recording
  test-e2e.js       headless round trip: person search flow
  test-case-links.js headless round trip: Enter-key search + case links across tables/new tabs
  data/             <name>.json (structured) + <name>.dsl (readable steps)
```

Usage: `node record.js` → overlay bottom-left (Start/Pause/Stop → name →
Save). `node replay.js <name> [--headless]`.

### Design decisions & hard-won details

- **Verbs, not selectors, in recordings.** The recording stores
  `{verb, args}`; all selector knowledge lives in `curam-driver.js`. When
  Curam markup changes, fix the driver, recordings survive.
- **Titles/labels over ids** (user preference): everything user-facing is
  matched by visible text; scoping (section panel → group → item) resolves
  ambiguity instead of ids.
- **Tab titles are generalized at capture**: reference numbers (≥5 digits)
  become `*`; replay matches with whitespace-normalized glob (Curam titles
  contain double spaces).
- **Enter-key submits**: Curam fires the default action with no click event.
  Recorder captures keydown Enter in a field and emits the pending `enter`
  step plus `click button "<default action title>"`; the input's later
  native change event is deduped (2-step lookback window).
- **Link context**: link clicks record the containing list/cluster title
  (`in "Current Cases"`), with dynamic suffixes stripped
  ("(Number of Items: 3)"). Replay matches the heading **exactly**
  (+ optional parenthetical) via `:text-matches` — substring matching
  confuses "Cases" with "Pending Cases".
- **Navigation waits, not sleeps**: after link/button clicks the driver
  polls a signature of (active tab id, content frame URL,
  `performance.timeOrigin` of the frame document) and proceeds when it
  changes. This handles links that open new case tabs, form posts to the
  same URL, and slow loads; falls through after 20s for non-navigating
  clicks.
- **Active panel is resolved fresh on every step** (from the
  `aria-selected` tab) because content clicks open and activate new tabs
  mid-recording.
- **Overlay** is attached to `<html>` (Curam styles/clips `<body>`),
  fixed bottom-left, and re-created by a watchdog interval because Curam
  rebuilds the DOM during boot. Recording state lives in the Node process,
  so page reloads don't lose steps.
- **Noise filters**: invisible/`aria-hidden` inputs (flatpickr mirror
  fields) are ignored; duplicate events within 1.5s are deduped.

### Dynamic data: link strategies + review UI

Case reference numbers and person links ("10000401", "Bo Stokes -
091551122") change per build, so literal replay breaks on fresh data. The
solution has three parts:

- **Silent rich-context capture.** Every link click in a table records
  `ctx`: row position, row count, the clicked column, and the full row's
  header→value map. Recording is never interrupted.
- **Post-stop review UI.** On Stop, steps whose link text looks
  data-dependent (contains ≥4 digits, has table context) are listed in the
  overlay with three choices each: keep exact text (**literal**), match by
  row position (**row**), or match by a column value (**predicate**, column
  select preselects Type/Status/Name-ish columns). The choice is written
  into the step as `strategy` before saving.
- **Strategy fallback chain at replay.** The chosen strategy is tried
  first; if it fails, the others that have enough information (literal if
  text exists, row if ctx.row exists) are tried and the fallback is logged.
  A predicate matching multiple rows errors as ambiguous rather than
  guessing (add `at row N` to disambiguate).

DSL forms (hand-editable — `.dsl` files parse back for replay):

```
click link "10000401" in "Current Cases"                      # literal
click link in "Current Cases" at row 1                        # row
click link in "Current Cases" where Type = "Insurance Affordability"
click link in "X" at row 2 where Status = "Open" and Applicant = "No"
```

Container resolution gotcha: `:has()`-style matching finds *ancestor*
wrappers too — Curam nests titled lists inside unlabeled `cluster_NO_LABEL`
wrappers, so "Current Cases" first resolved to a wrapper whose first table
was the empty "Pending Application Cases". The driver now walks
`.cds--accordion__title` elements in-page, requires the title's *owning*
list/cluster box, marks it with a `data-curam-scope` attribute, and scopes
row lookups to the mark (retrying up to 10s while content renders). Row
links default to the first anchor **with visible text** — expander icons
are anchors too.

This makes fully id-free scenarios possible; `data/bo-stokes-generic.dsl`
is a hand-written example that replays 9/9 with no literal ids anywhere.

### Rows, menus, modals, assertions (2026-07-10)

Verbs covering the common evidence/verification workflows:

- `select pagetab "Outstanding"` — in-page navigation tabs inside content
  (Verifications' Outstanding/Verified/Not Applicable are page tabs, not
  separate titled lists; their table container is `list_NO_LABEL`).
- `expand row` / `collapse row` / `check row` / `uncheck row` /
  `click rowmenu "<item>"` — all take the shared row selection
  (`in "C"`, `at row N`, `where Col = "V" and ...`). The row menu is a dijit
  DropDownButton in `.cds--list-row-menu`; its popup opens inside the same
  frame. Expanders are `a.list-details-row-toggle` with `aria-expanded`
  (replay no-ops if the row is already in the desired state); expanded
  details rows (`tr.list-details-row`) are excluded from row counting.
- `click pagemenu "Apply Changes"` — the page-level "…" menu
  (`[widgetid="page-level-action-menu"]`).
- `expect "Amount" is "$589.00"` — asserts a read-only display field
  (`.cds--cluster__item--read-only-field`: `label` + `.cds--field` value).
  **Recorded by right-clicking the field** (suppresses the native menu,
  flashes the field green). A mismatch fails the step with
  expected-vs-actual in the message.

Frame architecture discovered along the way, now baked into the driver:

- Expanding an evidence row lazy-loads a **nested iframe**
  (`Evidence_listEvdInstanceChangesPage.do`) holding the change-record
  table; expanding one of those rows loads a further view iframe. All
  content verbs therefore sweep a candidate-frame tree: the open modal's
  frame first, then the active tab's content frame and all descendants.
- Evidence Edit opens a **Carbon modal in the top document**
  (`.cds--modal-container` around `iframe[title^="Modal Frame"]`); the form
  is a normal Curam page inside, but **Save/Cancel are top-document
  buttons** outside the iframe. `click button` checks the modal footer
  first; the recorder classifies those clicks in the top-frame handler.
  Modal open/close state is part of the navigation signature, so steps
  wait correctly around modal transitions.
- Edit-form inputs are titled `"<Label> Mandatory"`; the recorder strips
  the suffix and replay matches both.
- Positional selection (`at row N`) with unlabeled nested tables can match
  an outer table's row first — use `where` predicates there (the review
  UI defaults to a predicate when usable columns exist).

### Determination/decision flow + row assertions (2026-07-10)

The "ultimate output" check — Current Determination coverage periods and
decision-page validation — added two things:

- `expect row [in "C"] [at row N] where Col = "V" and ...` — asserts a
  matching data row exists (multiple matches pass; failure message repeats
  the predicate). Recorded by **right-clicking a table cell**: the whole
  row becomes the predicate (junk columns like the actions "▼" dropped).
- Second heading dialect: decision pages (`StreamlineMedicaidPDDecision_*`,
  Financial Units) title their lists with `span.collapse-title` inside a
  `div.list.list-with-header` box — no `data-testid`/accordion markup.
  `_containerScope` and the recorder's `containerLabel` handle both
  dialects.
- The decision opens as a top-level tab whose Summary / Non Financial /
  Income / Community Engagement are ordinary nav-bar tabs (`select nav`).
  Banner fields (Decision, Coverage Start Date…) live in the **Context
  Panel iframe** (`iframe[title^="Context Panel"]`), now part of the
  driver's candidate-frame sweep.
- Display-field matching (assert + record) is **leaf-only**: group wrappers
  also carry `.cds--cluster__item--read-only-field` and would match with
  concatenated garbage values.
- `click link` row/predicate forms now work without a container
  (`click link where Decision = "Eligible"`) for unlabeled tables like
  Current Determination.

### Parameterization & wildcards (v1, 2026-07-10)

Recordings capture concrete data; scenarios generalize by editing the .dsl
(the agreed workflow — the parameter is almost always just the person):

- `param firstName = "bo"` lines declare parameters with defaults;
  `${firstName}` substitutes into any argument or `where` value;
  `--param firstName=fra` overrides at replay. Undeclared `${...}` fails at
  load. `data/person-ia-case.dsl` runs unchanged for Bo Stokes and (with
  two --param flags) Francis Mertz.
- `*` wildcards match anywhere in literal link text, `where` values and
  `expect` values: `click link "${person} - *"`,
  `expect row where Coverage Period = "* - 12/31/2027"`,
  `expect "Coverage Start Date" is "*/2027"`.

Lesson from verification: replaying `bo-evidence-edit` (Apply Changes)
triggers reassessment, which **split the determination into two coverage
periods** — exact-value asserts on determination output rot as evidence
changes are applied. Wildcarded timeline asserts are the durable form.
Also: `_rowOp` failures now aggregate errors from every frame swept, so an
"ambiguous: matches 2 rows" isn't shadowed by another frame's
"no matching row".

### Known limitations / next ideas

- Variable binding (capture a value from one step into a parameter for a
  later step, e.g. `$caseRef`) — not needed yet; parameters + wildcards
  cover current flows.
- Assertions cover read-only display fields; table-cell asserts
  (`expect cell ...`) would be a natural extension.
- Carbon dropdowns, date pickers, modal dialogs (wizard iframes) and
  in-page tab menus ("...", Open In New Tab, New Evidence…) are captured
  as generic events but not yet exercised/verified in replay.
- Non-navigating `click link` steps pay the 20s fall-through wait.
- No assertion verbs yet (`expect …`) — needed to make replays real tests.
- `prototype/` contains the earlier exploration scripts (superseded by
  `recorder/`, kept for reference).

## Verification status (2026-07-10)

- `node test-e2e.js` then `node replay.js test-person-search --headless`: 7/7.
- `node test-case-links.js` then `node replay.js test-case-links --headless`:
  10/10 (Enter search, person→case→sub-case link hops, nav select; review UI
  exercised — literal/predicate/row strategies applied and replayed).
- `node replay.js bo-stokes-generic.dsl --headless`: 9/9 — hand-written,
  id-free scenario (row + predicate strategies, no reference numbers).
- `node replay.js bo-verifications.dsl --headless`: 16/16 — page tabs,
  expand/collapse, row menu → Add Proof, modal Cancel.
- `node replay.js bo-evidence-edit.dsl --headless`: 21/21 — Income evidence
  edit in nested iframe (`expect "Amount" is "$589.00"` assert, Edit modal →
  Save), back to dashboard, Apply Changes → check row → Save.
- `node test-record-verbs.js` then `node replay.js test-verif-verbs
  --headless`: 17/17 — recording round trip incl. right-click assertion
  (captured from a third-level nested frame) and review-UI predicates.
- Negative check: a wrong `expect` value fails the step with
  expected-vs-actual in the message.
- `node replay.js bo-determination.dsl --headless`: 19/19 — Current
  Determination coverage-period `expect row`, decision tab banner-field
  asserts (context panel), Coverage Information / Pended Members /
  Medicaid Financial Unit table asserts across Summary + Income navs.
- `node test-record-assert-row.js` then `node replay.js test-assert-row
  --headless`: 15/15 — right-click-recorded row + field assertions; the
  coverage-period link (date text) auto-flagged and predicated.
- Negative check: a non-matching `expect row` predicate fails the step.
- `node replay.js person-ia-case.dsl --headless`: 9/9 with defaults (Bo)
  AND with `--param firstName=fra --param person="Francis Mertz"` — same
  script, two people; wildcard person link (`"${person} - *"`).
- `bo-determination.dsl` re-verified 19/19 after wildcarding the
  coverage-period asserts (determination had split into two periods).
