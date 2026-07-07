# Agency notes

Agency-specific knowledge lives here, one topic per md file. This directory
is never overwritten by kit updates.

What belongs here (vs the generic kit docs):
- Local conventions: naming, code-value ranges, review rules.
- The agency's merge/overwrite exceptions or build-script specifics.
- `override-register.md` — the audited list of OOTB copy-and-own overrides.
- Environment notes: how to run the local server, test data, known quirks.
- Benefit-program-specific domain knowledge.

Triage rule for existing custom notes when migrating them in:
- Procedural ("how to do X") → becomes/extends a skill in `agent-kit/skills/`.
- Invariant (breaks things if violated) → a bullet in root `AGENTS.md`.
- Everything else → a file here, linked from AGENTS.md if agents need it
  often.
