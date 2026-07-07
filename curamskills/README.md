# curamskills — an agent-enablement kit for Curam customization codebases

Makes a Curam agency codebase navigable and safely editable by coding agents
(Claude Code, Copilot, Cursor, headless CI agents). One shared kit, installed
into each agency repo with a thin per-agency config layer.

## Why this shape

Curam is a worst case for agents out of the box:

- **Name-based cross-references.** UIM pages reference facade operations by
  string, rules reference entities by string, codetables are referenced from
  everywhere. Imports don't exist between these layers, so grep produces false
  negatives and floods of false positives. → we build a **cross-reference
  index** (SQLite) and a query CLI. The index holds two views: **source**
  (files under `*/components/` — where edits go) and **live** (the build's
  merged output under `live_roots` — what actually runs, with merge/overwrite
  resolution done by the build itself, not reimplemented by us). Reverse
  queries answer from the live view; provenance of overwrite-type artifacts
  is inferred by content-hash match back to source files.
- **DSLs the model has weak priors on.** UIM, CREOLE, codetable XML, workflow
  definitions. → each dev workflow is a **skill/recipe** that carries the DSL
  cheat-sheet, a template, and a validation step, loaded only when needed.
- **Invisible correctness rules.** Component precedence, merge-vs-overwrite
  semantics, "never touch OOTB". → the small always-loaded **AGENTS.md**
  carries exactly these invariants and nothing else, and validators/hooks
  enforce the ones that can be enforced.
- **Human-only model layer.** Server entry points come from the RSA UML model.
  → skills that need model changes end at an explicit **modeler handoff**: the
  agent produces a model-change spec, a human applies it in RSA, the agent
  continues from the generated stubs.

## The four layers

| Layer | Lives in | Loaded | Answers |
|---|---|---|---|
| 1. AGENTS.md hierarchy | repo root + per-area | always | "how does this codebase work" — invariants only |
| 2. Skills / recipes | `agent-kit/skills/` (+ `.claude/skills/`) | on demand | "how do I do X here" — step-by-step, per artifact type |
| 3. Deterministic tools | `agent-kit/tools/` | invoked | xref index, validators, manuals search |
| 4. Knowledge | `agent-kit/docs/` + manuals API | on demand | concepts, agency notes, product docs |

Rule of thumb for where new knowledge goes: if violating it breaks the build
or the merge model → layer 1. If it's a procedure → layer 2. If it's a lookup
→ layer 3. Otherwise → layer 4.

## Repo layout (this kit)

```
kit/
  AGENTS.template.md     root AGENTS.md, rendered per agency by install.py
  docs/                  generic Curam concept docs (portable, harness-neutral)
  skills/                one directory per dev workflow; SKILL.md is portable md
  tools/
    xref/                cross-reference indexer + `xref` query CLI
    validators/          ootb-untouched check, XML validation
    manuals/             thin CLI over your manuals search API
  claude/                Claude Code adapter: hooks + settings fragment
agency-template/
  kit.config.yaml        the ONLY file an agency must fill in
  docs/agency-notes/     agency-specific md notes live here
install.py               renders + copies the kit into an agency repo
```

## Installing into an agency repo

```sh
cp agency-template/kit.config.yaml /path/to/agency-repo/kit.config.yaml
# edit kit.config.yaml: component names, precedence order, manuals endpoint
python3 install.py /path/to/agency-repo
```

This writes into the agency repo:

- `AGENTS.md` at root (rendered from the template with agency values) —
  Copilot, Cursor, and most harnesses read this natively. A one-line
  `CLAUDE.md` pointing at it is also written for Claude Code.
- `agent-kit/` — docs, skills, tools (the portable core).
- `.claude/skills/<name>/SKILL.md` — copies of each skill so Claude Code can
  auto-invoke them; other harnesses reach the same content via the AGENTS.md
  skill index.
- `.claude/settings.json` hook registration for the OOTB-edit guard
  (merge by hand if the file already exists).

Then build the index: `python3 agent-kit/tools/xref/build_index.py`

## Build order (what to invest in, in order)

1. **AGENTS.md + docs** — cheap, immediately improves Q&A/onboarding and stops
   the worst mistakes. Ship first.
2. **xref indexer** — unlocks real impact analysis and makes every skill's
   "find the affected artifacts" step reliable. The parsers included cover
   codetables and UIM; add parsers per artifact type as needed (see
   `kit/tools/xref/parsers/README.md`).
3. **Skills for the top 3 change types** your teams actually do (start from
   the included ones, correct them against your real workflows — a skill with
   a wrong step is worse than no skill).
4. **Validators wired as hooks/pre-commit** — turns conventions into
   guarantees.
5. **Manuals CLI** — wire `kit/tools/manuals/manuals-search` to your search
   API endpoint (one function to fill in).

## Maintaining

- Skills are living documents: when an agent gets something wrong, fix the
  skill, not just the change. Treat skill edits like code review.
- The kit is copied, not symlinked, into agency repos. Re-run `install.py` to
  pull kit updates; agency-local content under `agent-kit/docs/agency-notes/`
  and `kit.config.yaml` are never overwritten.
