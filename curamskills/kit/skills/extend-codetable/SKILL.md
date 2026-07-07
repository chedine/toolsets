---
name: extend-codetable
description: Add a new codetable, or add/modify codes in an existing (possibly OOTB) codetable, in the custom component.
---

# Extend a codetable

## When to use
Adding a dropdown/status/type value anywhere in the app. Codetables back
almost every enumerated field.

## Preconditions
- Know the target codetable name. If extending an existing one, find it:
  `xref find codetable <name-fragment>` or grep OOTB `codetable/` dirs.
- Custom component exists: `EJBServer/components/{{PRIMARY_COMPONENT}}/codetable/`.

## Steps
1. Codetables are **merge-type**: create a `.ctx` file in the custom
   component's `codetable/` dir containing ONLY your delta. Never copy the
   OOTB file.
2. For a new code in an existing table, the file declares the same
   `codetable name` and just the new `<code>` entries (see cheat sheet).
   For a brand-new table, also plan the domain definition that will use it —
   that part is a model change (**STOP — handoff** if a new domain is needed;
   spec: domain name, codetable name, default value).
3. Code values follow the agency prefix convention: {{CODE_PREFIX_RULE}}.
   Check existing custom `.ctx` files for the local pattern before inventing.
4. Add display text for every locale the agency supports (check sibling `.ctx`
   files for the locale list).
5. If Java needs to reference the code, use the generated constant class
   (`CT<TableName>.java`), which regenerates at build — never hardcode the
   string value.

## DSL cheat sheet
```xml
<codetables package="{{CODETABLE_PACKAGE}}">
  <codetable java_identifier="MyStatus" name="MyStatus">
    <code default="false" java_identifier="EXAMPLE" status="ENABLED"
          value="MS1001">
      <locale language="en" sort_order="0">
        <description>Example status</description>
        <annotation/>
      </locale>
    </code>
  </codetable>
</codetables>
```
Merging keys on `codetable name` + `code value`. Re-declaring an existing
`value` in a higher component modifies that code (e.g. to disable an OOTB
code, redeclare it with `status="DISABLED"`).

## Validation
- `python3 agent-kit/tools/validators/validate_xml.py <file>.ctx`
- Build codetables target: `{{BUILD_CODETABLE_COMMAND}}` — must succeed and
  the generated `CT<TableName>` class must contain your constant.
- `python3 agent-kit/tools/validators/check_ootb_untouched.py`

## Common mistakes
- Copying the whole OOTB `.ctx` (creates duplicate-entry merge failures).
- Forgetting the database side: codetable changes reach the DB via the build's
  codetable target / `ctx` load — a code that compiles but was never loaded
  shows as a blank dropdown entry.
- Hardcoding code string values in Java instead of the `CT` constant.
