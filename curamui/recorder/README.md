# Curam Action Recorder

Records user actions in the Curam web client as high-level, human-readable
steps (`click section "HCR Cases and Outcomes"`, `enter "Mertz" as Last Name`,
`select navitem "Dashboard"`, …) and replays them. No Chrome extension — a
Node script launches the browser and injects the recorder.

## Usage

```sh
node record.js                 # launch browser + overlay, record, save
node record.js --no-clean      # skip the close-all-tabs cleanup on start
node record.js --url https://host/Curam/AppController.do --data ./data

node replay.js <name>          # replay data/<name>.json
node replay.js <name> --headless
node replay.js scenario.dsl --param firstName=fra --param person="Francis Mertz"
```

Config defaults live in `config.json` (`url`, `dataDir`, `cleanTabsOnStart`,
`maximized`, `extraHTTPHeaders`, `viewport`). CLI flags override. Headed
windows open maximized by default (`"maximized": false` to use the fixed
`viewport` instead); headless runs always use the `viewport`.

## How it works

- `record.js` launches Chromium, and (by default) right-clicks each section's
  tab strip and picks **Close All** so the session starts clean, then reloads.
- `injected.js` runs in the top document and every content iframe. It
  classifies raw clicks/changes into Curam verbs using the app chrome
  structure (sections / shortcuts / tabs / nav bar / nav groups live in the
  top document; only page content is iframed). It also renders the
  start/pause/stop overlay (bottom right).
- Tab titles are generalized on capture: reference numbers become `*`
  (`Insurance Affordability 10000387 - X` → `Insurance Affordability * - X`)
  so recordings aren't tied to transactional ids.
- Stop → name the recording in the overlay → saved to `data/<name>.json`
  (structured steps) + `data/<name>.dsl` (plain-text step list). Closing the
  browser with unsaved steps prompts for a name in the terminal.
- `replay.js` maps each verb onto `curam-driver.js`, the title/label-based
  Playwright driver (wildcard tab matching, group-scoped shortcuts,
  visible-panel-scoped iframe resolution).

## Verbs

| verb | example |
|---|---|
| click section | `click section "HCR Cases and Outcomes"` |
| click shortcutgroup | `click shortcutgroup "Searches"` |
| click shortcutitem | `click shortcutitem Searches > Person` |
| select tab | `select tab "Insurance Affordability * - Francis Mertz"` |
| select pagetab | `select pagetab "Outstanding"` (in-page tabs, e.g. Verifications' Outstanding/Verified/Not Applicable) |
| select nav | `select nav "Evidence"` |
| select navitem | `select navitem "Dashboard"` |
| enter | `enter "Mertz" as Last Name` |
| click button / menuitem | `click button "Search"` |
| click link | `click link "10000401" in "Current Cases"` (`in <list/cluster title>` scopes the search) |
| click link (row) | `click link in "Cases" at row 1` |
| click link (predicate) | `click link in "Current Cases" where Type = "Insurance Affordability"` (combine: `at row 2 where Status = "Open" and …`) |
| select (combobox) | `select "Minnesota" for State` (native selects and Carbon comboboxes) |
| check / uncheck | `check "Show Nicknames"` |
| expand / collapse row | `expand row where Participant = "Bo Stokes"` (row expander ">") |
| check / uncheck row | `check row where Type = "Income"` (row-selection checkbox) |
| click rowmenu | `click rowmenu "Add Proof" where Items for Verification = "Income Type"` (row "…" menu → item) |
| click pagemenu | `click pagemenu "Apply Changes"` (page-level "…" action menu → item) |
| click tabmenu | `click tabmenu "New Application"` (tab actions "…" menu, top right of a tab) |
| advance to | `advance to "Income Information"` (click wizard Next until the named IEG page is reached — skips variable intro/summary pages) |
| check all | `check all` (tick every visible checkbox — consent/signature pages where labels repeat) |
| expect | `expect "Amount" is "$589.00"` (assert a read-only display field, incl. context-panel banner fields) |
| expect row | `expect row in "Coverage Information" where Name = "Bo Stokes" and Category = "Adult"` (assert a matching table row exists) |
| close tab | `close tab "Person Search"` |

Row verbs (`expand/collapse/check/uncheck row`, `click rowmenu`, and the row
forms of `click link`) all accept the same row selection: `in "<container>"`,
`at row N`, `where Col = "Val" and ...`.

## Profile-driven application filling

Recording every application shape is impractical, so IEG applications can be
driven from a declarative **YAML profile** instead:

```
click tabmenu "New Application"
fill application from family3        # loads data/profiles/family3.yaml
```

The filler walks the wizard to submission, answering each mandatory field
from the profile. It is **strict**: any mandatory field with no profile
answer aborts with a clear error naming the field (so you add it and rerun).

Profile shape (`data/profiles/*.yaml`):

```yaml
answers:                 # question-regex -> value (dropdowns & text fields)
  "^Application Date$": "1/1/2026"
  "Marital Status": "Married"
  "^Does .* have a Social Security Number": "No"   # member questions embed
  "Reason why .* does not have a Social Security Number": "Not eligible for SSN"
  "have any income": "No"
checks:                  # checkbox regexes to tick (agreement, reasons, ...)
  - "I agree"
  - "Family Caregiver of Disabled Individual"
members:                 # each adds a household member + its per-member pages
  - { firstName: Mara, lastName: "${lastName}", gender: Female, maritalStatus: Married, dob: 7/7/1987 }
  - { firstName: Kip,  lastName: "${lastName}", gender: Male,   maritalStatus: "Never Married", dob: 5/5/2015 }
relationships:           # one entry per household pair
  - { between: ["${firstName}", Mara], value: Spouse }
  - { between: ["${firstName}", Kip],  value: Parent }
  - { between: [Mara, Kip],            value: Parent }
strict: true
```

- Answer keys are **regexes** (case-insensitive, first match wins). Member
  questions embed the member's name, so use `.*` where a name appears.
  Anchor keys (`^...`) when a short phrase would match a longer question —
  e.g. `^Application Date$` (not the MA question that mentions "application
  date"), `^Does .* have a Social Security Number` (not the "Reason why ...
  does not have" question).
- `${param}` placeholders in the profile are substituted from `--param`.
- Registering the applicant is a separate step (see `apply-single.dsl` /
  `apply-family3.dsl`, which register then `fill application`).

## Parameters & wildcards

Recordings are taken against concrete data and generalized by editing the
`.dsl`:

- **Parameters**: declare `param firstName = "bo"` at the top, use
  `${firstName}` in any argument or `where` value, override at replay with
  `--param firstName=fra`. An undeclared `${...}` fails at load with a
  clear message. See `data/person-ia-case.dsl`.
- **Wildcards**: a `*` in a link text, `where` value, or `expect` value
  matches anything — `click link "${person} - *"` (reference numbers vary),
  `expect row where Coverage Period = "* - 12/31/2027"`,
  `expect "Coverage Start Date" is "*/2027"`.

Notes:
- Pressing **Enter** in a field is recorded as the default action it triggers
  (`click button "Search"`).
- **Right-click a read-only display field** while recording to capture an
  `expect` assertion on its current value; **right-click a table cell** to
  capture an `expect row` assertion on the whole row (junk columns like the
  actions "▼" are dropped — trim the where clause in the .dsl if it's
  stricter than you want). The asserted element flashes green.
- Replay searches the open modal dialog first, then the content frame and all
  its nested iframes (expanded evidence rows load their own iframes), so
  steps inside modals and nested tables just work. Modal footer Save/Cancel
  (which live outside the modal's iframe) are handled by `click button`.
- When a table sits behind an in-page tab or an expanded row (no list title),
  prefer `where` predicates over `at row N` — positional selection can match
  a row in an outer table first.
- IEG application wizards (New Application etc.) work with the same verbs:
  `select ... for ...` drives their dijit FilteringSelect dropdowns,
  `check` matches long agreement labels by prefix/wildcard, and
  `click button "Next"` / `"Save & Exit"` hit the in-frame wizard buttons.
  Questions appear **conditionally** as earlier answers are set — order the
  script by reveal order, and note Save & Exit validates the current page.
  IEG interleaves data pages with intro/summary/pass-through pages whose
  count varies with earlier answers, so navigate to each data page with
  `advance to "<page heading>"` rather than counting `click button "Next"`.
  A submitted application ends in two Carbon consent dialogs (`check all` +
  `click button "Submit"`, twice). See `data/new-application.dsl` for the
  full single-person, no-income Insurance Affordability application.
- Link clicks capture the containing list/cluster title; replay matches that
  title exactly (ignoring dynamic suffixes like "(Number of Items: 3)"), so
  "Cases" never falls into "Pending Cases".
- Replay waits for actual navigation (tab switch or content document change)
  after links/buttons instead of fixed sleeps, so links that open new case
  tabs work.

## Dynamic data (link strategies)

Link text like case reference numbers changes on every fresh build. When you
Stop a recording, links that look data-dependent are listed in the overlay
for review — choose per link:

- **literal** — keep the exact text (fine for stable data)
- **row** — match by row position (`click link in "Cases" at row 1`)
- **predicate** — match by a column value
  (`click link in "Current Cases" where Type = "Insurance Affordability"`)

At replay the chosen strategy runs first and the others act as fallbacks
(logged when used). An ambiguous predicate (matches several rows) fails
loudly — add `at row N`.

You can also replay a hand-written plain-text scenario directly:
`node replay.js my-scenario.dsl` (see `data/bo-stokes-generic.dsl` for a
fully id-free example).

## Test

Headless round trips (record via simulated user events, then replay):

- `node test-e2e.js` → `node replay.js test-person-search --headless`
- `node test-case-links.js` → `node replay.js test-case-links --headless`
  (Enter-key search, case links across tables, new-tab navigation)
- `node test-record-verbs.js` → `node replay.js test-verif-verbs --headless`
  (page tabs, expand/collapse, row menu, right-click assertion)

- `node test-record-assert-row.js` → `node replay.js test-assert-row
  --headless` (right-click row + banner-field assertions)

Hand-written id-free scenarios: `node replay.js bo-stokes-generic.dsl`,
`bo-verifications.dsl` (Add Proof flow), `bo-evidence-edit.dsl` (evidence
edit modal → save → apply changes, with an `expect` assertion),
`bo-determination.dsl` (current determination → coverage-period assert →
decision tab Summary/Income validation), `register-person.dsl`
(parameterized person registration wizard: name/dob/ssn params, MN
address, post-save search verification; SSN must be digits-only).
