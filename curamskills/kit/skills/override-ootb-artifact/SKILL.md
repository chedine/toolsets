---
name: override-ootb-artifact
description: Decision guide + procedure for changing OOTB behavior via the custom component (copy-and-own vs merge contribution vs extension point).
---

# Override an OOTB artifact

## When to use
Any time the desired behavior lives in an OOTB component. This skill decides
HOW to override; artifact-specific skills (`modify-uim-screen`,
`extend-codetable`) handle the details once the mechanism is chosen.

## Decision procedure

1. **Is there a sanctioned extension point?** Check the manuals first:
   `manuals-search "customize <artifact/behavior>"`. Events, hooks, strategy
   Guice bindings, and configuration beat file overrides — they survive
   product upgrades. If one exists, use it and stop here.
2. **Is the artifact merge-type or overwrite-type?** See
   `agent-kit/docs/component-model.md`. This is a fact about the artifact
   type, not a choice.
   - Merge-type → author only the delta in the custom component.
   - Overwrite-type → copy-and-own (below).
3. **Copy-and-own procedure:**
   a. `xref find <type> <name>` — confirm which component currently wins and
      that no custom copy already exists. If one exists, edit it instead.
   b. Copy the winning version to the identical relative path under the
      custom component (precedence only matches on path/name).
   c. Header comment: source component, product version, date, ticket, and a
      one-line summary of the delta — this is the upgrade-time diff anchor.
   d. Make the minimal edit. Keep the diff against the OOTB original small
      and reviewable: upgrades re-apply your delta onto the new OOTB version.
4. Record the override in `agent-kit/docs/agency-notes/override-register.md`
   (create if missing): path, reason, ticket. Agencies audit this list at
   upgrade time.

## Validation
- `check_ootb_untouched.py` passes (the change is only in custom components).
- The relevant build target succeeds and the behavior change is observable
  (the wrong-precedence failure mode is "builds fine, nothing changed").

## Common mistakes
- Overriding when a supported extension point existed — the expensive mistake,
  discovered at upgrade time.
- Copying to a slightly different relative path → both files ship, OOTB still
  wins.
- Copy-and-owning a merge-type artifact → duplicate contribution build errors.
