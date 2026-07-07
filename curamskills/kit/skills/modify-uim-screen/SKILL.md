---
name: modify-uim-screen
description: Create a new UIM page or customize an existing (possibly OOTB) UIM screen in the webclient custom component.
---

# Create or modify a UIM screen

## When to use
Any change to what a screen displays, its fields, links, or actions. NOT for
navigation/tab structure (that is merge-type config — see agency notes) and
NOT for new server data (do `add-server-facade` first if the data isn't
already exposed by an existing facade operation).

## Preconditions
- Identify the page: `xref find uim <PAGE_ID or fragment>` — tells you which
  component owns it and whether a custom override already exists.
- Know which facade operation supplies/receives the page's data:
  `xref refs-from uim <PAGE_ID>` lists its `SERVER_INTERFACE` targets.

## Steps
1. **Modifying an OOTB page:** UIM is **overwrite-type**. Copy the OOTB
   `.uim` AND its paired `.properties` file to the same relative path under
   `webclient/components/{{PRIMARY_COMPONENT}}/`, add a header comment noting
   the source component + date + reason, then edit the copy.
   **If a custom copy already exists, edit it — never create a second copy.**
2. **New page:** create `<PageID>.uim` + `<PageID>.properties` in the custom
   component. PAGE_ID must equal the file name and be unique app-wide
   (`xref find uim <proposed-id>` must return nothing).
3. Wire data: each `SERVER_INTERFACE` names a facade class + operation; every
   displayed field CONNECTs a `DISPLAY` source property; every input field
   CONNECTs an `ACTION` target property. Property names must match the
   facade's struct fields exactly (string-matched, not compiler-checked —
   verify against the generated struct or `xref show facade <Facade>`).
4. All user-visible text goes in the `.properties` file, referenced by key —
   no literals in the UIM.
5. Linking from elsewhere: add/adjust the `LINK`/`ACTION_CONTROL` on source
   pages, or navigation config for tab-level entries.

## DSL cheat sheet
```xml
<PAGE PAGE_ID="MyAgency_viewCase">
  <SERVER_INTERFACE NAME="DISPLAY" CLASS="MyAgencyCaseFacade"
                    OPERATION="viewCaseDetails" PHASE="DISPLAY"/>
  <PAGE_PARAMETER NAME="caseID"/>
  <CONNECT>
    <SOURCE NAME="PAGE" PROPERTY="caseID"/>
    <TARGET NAME="DISPLAY" PROPERTY="key$caseID"/>
  </CONNECT>
  <CLUSTER NUM_COLS="2" TITLE="Cluster.Title.Details">
    <FIELD LABEL="Field.Label.Status">
      <CONNECT><SOURCE NAME="DISPLAY" PROPERTY="result$status"/></CONNECT>
    </FIELD>
  </CLUSTER>
</PAGE>
```
Key elements: `CLUSTER` (field group), `LIST` (table), `FIELD`, `CONTAINER`,
`ACTION_SET`/`ACTION_CONTROL` (buttons/links), `LINK` (navigation with
parameters), `INFORMATIONAL` (messages). `.vim` files are reusable includes.

## Validation
- `python3 agent-kit/tools/validators/validate_xml.py <file>.uim`
- Every CONNECT property verified against the facade struct (step 3).
- Client build: `{{BUILD_CLIENT_COMMAND}}`.
- `check_ootb_untouched.py` passes.
- Rebuild xref: `build_index.py --incremental` so the new page is indexed.

## Common mistakes
- Editing the OOTB UIM in place (change works locally via stale copy, then
  fails `check_ootb_untouched`).
- CONNECT property typos — page renders with silently blank fields; verify
  names, don't trust memory.
- Forgetting the paired `.properties` copy → build failure or raw keys shown.
- Creating a second custom copy when one already exists in another custom
  component — precedence, not intent, decides which wins.
