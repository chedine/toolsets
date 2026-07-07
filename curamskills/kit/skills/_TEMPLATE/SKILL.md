---
name: skill-name-kebab
description: One line saying when an agent should load this skill.
---

# <Task name>

## When to use
<Trigger conditions. Also say when NOT to use / which skill to use instead.>

## Preconditions
<What must be true/known before starting: component name, xref.db built, etc.>

## Steps
<Numbered, imperative, each independently checkable. Include exact commands
and file paths with {{PLACEHOLDERS}} for agency values. Mark any human-handoff
point explicitly: **STOP — handoff:** followed by exactly what to hand over.>

## DSL cheat sheet
<Minimal grammar/snippet reference for the artifact type. Assume the model
does NOT reliably know this DSL.>

## Validation
<Commands that must pass before the change is complete.>

## Common mistakes
<Failure modes seen in practice; update this section every time an agent gets
it wrong.>
