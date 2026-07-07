# AGENTS.md — {{AGENCY_NAME}} Curam customization

This repo customizes the Curam social program management platform for
{{AGENCY_NAME}}. Read this file fully before making any change; it contains
the invariants that are not visible in the files themselves.

## Non-negotiable rules

1. **Never modify out-of-the-box (OOTB) components inline.** Anything under
   `EJBServer/components/` or `webclient/components/` that is not one of the
   custom components listed below is product code. To change product behavior,
   create/modify artifacts in a custom component; the build resolves which
   version wins. Run `python3 agent-kit/tools/validators/check_ootb_untouched.py`
   before considering any change complete.
2. **Component precedence decides which artifact version is used.** Custom
   components, highest precedence first: {{COMPONENT_ORDER}}. An artifact with
   the same path/name in a higher component **overwrites** the lower one for
   overwrite-type artifacts, and **merges** for merge-type artifacts — the two
   behave completely differently; check the table in
   `agent-kit/docs/component-model.md` before assuming either.
3. **Never edit generated code.** Server entry points (facades, entities,
   structs) are generated from the UML model, which only humans edit in
   Rational Software Architect. If a task needs a model change, produce a
   model-change spec (see the `add-server-facade` skill) and stop for handoff.
4. **Verify before done.** A change is not complete until the relevant
   validator passes and, for code changes, the component build succeeds:
   `{{BUILD_COMMAND}}`.

## Map

- Server side: `EJBServer/components/<component>/` — Java, model artifacts,
  codetables, rules, workflows, messages, DMX data.
- Client side: `webclient/components/<component>/` — UIM screens, properties,
  client config.
- Custom components: {{CUSTOM_COMPONENTS}}.
- Directory legend inside a component (what each subdir holds):
  `agent-kit/docs/artifact-types.md`.
- Architecture and layering: `agent-kit/docs/architecture.md`.
- Agency-specific conventions and notes: `agent-kit/docs/agency-notes/`.

## How to work in this repo

- **Finding things / impact analysis:** do not rely on grep for cross-artifact
  references — they are name-based strings, not imports. Use the xref index:
  `python3 agent-kit/tools/xref/xref --help` (build it first with
  `build_index.py` if `xref.db` is missing). Typical queries: what references
  facade X, which UIM pages call operation Y, where is codetable Z used.
- **Making a change:** check `agent-kit/skills/` for a recipe matching the
  artifact type before improvising. Index of skills:

  | Task | Skill |
  |---|---|
  | Add/extend a codetable | `agent-kit/skills/extend-codetable/SKILL.md` |
  | Create/modify a UIM screen | `agent-kit/skills/modify-uim-screen/SKILL.md` |
  | New server entry point (facade) | `agent-kit/skills/add-server-facade/SKILL.md` |
  | Override an OOTB artifact | `agent-kit/skills/override-ootb-artifact/SKILL.md` |
  | Impact analysis for a change | `agent-kit/skills/impact-analysis/SKILL.md` |

- **Product questions:** search the indexed product manuals:
  `python3 agent-kit/tools/manuals/manuals-search "your query"`. Prefer the
  manuals over guessing Curam semantics — the platform has decades of
  conventions that differ from mainstream Java/web development.
- **Validation:** `agent-kit/tools/validators/validate_xml.py <file>` checks
  well-formedness (and schema, where XSDs are configured) for UIM, codetable,
  and other XML artifacts.

## Area-specific rules

Nested AGENTS.md files exist under major areas and take precedence for files
in their subtree (e.g. `webclient/components/{{PRIMARY_COMPONENT}}/AGENTS.md`
for UIM conventions). Check for one before working in an unfamiliar area.
