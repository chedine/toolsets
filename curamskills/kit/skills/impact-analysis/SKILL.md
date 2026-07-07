---
name: impact-analysis
description: Trace everything affected by a proposed change (entity, facade, codetable, UIM, rule, workflow) using the xref index; produce an impact report.
---

# Impact analysis

## When to use
Before any non-trivial change, or when explicitly asked "what breaks if we
change X". Output is a report, not a change.

## Preconditions
- `xref.db` exists and is fresh: `python3 agent-kit/tools/xref/build_index.py`
  (use `--incremental` if it exists; note the indexed-at timestamp in the
  report).

## Steps
1. **Anchor the artifact.** `xref find <type> <name>` — the index has two
   views: `source` rows are the editable files per component, `live` rows are
   the build's merged output (what actually runs). Record both. A live row
   marked `<= <component>` tells you which source version won; a live row
   with no match is merged from several sources (merge-type). Analyze the
   live version's content, plan edits against the source files.
2. **Direct dependents.** `xref refs-to <type> <name>` — who references it.
   For each artifact type the meaning differs:
   - entity/struct field → facades + rules + workflows using it
   - facade operation → UIM pages (`SERVER_INTERFACE`), workflow steps, REST
     resources
   - codetable → UIM fields, domain definitions, `CT` constant usages in Java
   - UIM page → other pages' LINKs, tab/navigation config
3. **Transitive closure, bounded.** Walk `refs-to` one more level for anything
   whose *interface* changes (renamed field, removed code). Behavior-only
   changes usually stop at one level.
4. **Non-indexed surfaces** — check manually, the index can't see these:
   - string-built references in Java (grep the bare name as a literal)
   - product configuration stored in DB rows shipped via DMX (`grep -r` the
     name under `*/data/`)
   - documents/notices/batch jobs if the agency uses them (agency notes list
     which)
5. **Manuals check.** `manuals-search "<artifact name>"` for product-level
   coupling not visible in the codebase (e.g. an OOTB batch job reads this
   table).
6. **Report** in this shape:
   - Change summary; artifact + owning component + live version after
     precedence
   - Direct impacts (table: artifact, type, component, what breaks, action)
   - Transitive impacts
   - Unverifiable surfaces (what step 4/5 could not rule out)
   - Test surface: which existing tests cover the affected artifacts

## Common mistakes
- Trusting grep for name-based references (misses XML-to-XML links, drowns in
  false positives for common names).
- Analyzing the OOTB version of an artifact when a custom override is live.
- Forgetting DMX/config-in-database references — invisible to both grep and
  compile.
