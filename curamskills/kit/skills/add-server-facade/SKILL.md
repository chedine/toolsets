---
name: add-server-facade
description: Add or extend a server entry point (facade operation) — includes the mandatory human modeling handoff.
---

# Add a server entry point (facade operation)

## When to use
The client needs data or an action the existing facades don't expose. Check
first that it truly doesn't exist: `xref find facade <domain term>` and
manuals-search — reusing an OOTB operation beats adding one.

## The handoff model (read first)

Facades, structs, and their remote interfaces are **generated from the UML
model, which only humans edit in RSA**. The agent's job splits in three:

- Phase A (agent): design + write the model-change spec.
- Phase B (human): apply the spec in RSA, regenerate, commit.
- Phase C (agent): implement the generated stub, wire the client, validate.

## Phase A — design and spec

1. Design the operation: name, purpose, input struct fields (with domain
   definitions), output struct fields, which process/entity classes it will
   delegate to. Look at a neighboring custom facade in
   `EJBServer/components/{{PRIMARY_COMPONENT}}/source/` for local conventions.
2. Write the spec to `model-change-requests/<ticket>-<name>.md` using the
   template below. Field domains must reference existing domain definitions
   where possible (`xref find domain <fragment>`); new domains go in the spec
   too.
3. **STOP — handoff:** post the spec to the modeler. Do not attempt to edit
   `.emx`/`.efx` files or hand-write "generated" classes to work around the
   wait.

### Spec template
```md
## Model change request: <FacadeName>.<operationName>
Component: {{PRIMARY_COMPONENT}}   Ticket: <id>
### Facade class
<existing facade to extend | new facade class name + package>
### Operation
name, description, security (SID name, who gets it)
### Input struct
<StructName>: field | domain definition | mandatory? | notes  (one row each)
### Output struct
...same...
### New domain definitions (if any)
name | base type | codetable (if any)
```

## Phase C — after regeneration

4. Implement the operation in the facade implementation class under
   `source/`; delegate business logic to process/entity layer classes — no
   business logic in the facade itself beyond assembly and validation.
5. Register security: the operation's SID must be inserted via DMX in `data/`
   and tied to the appropriate security group (copy the pattern from an
   existing custom operation's DMX).
6. Wire the client (see `modify-uim-screen`) and add a test under `test/`.

## Validation
- Server build: `{{BUILD_SERVER_COMMAND}}` (compiles generated + handwritten).
- Test for the new operation passes.
- Security DMX present — an unregistered SID fails only at runtime with an
  authorization error, not at build time.
- `check_ootb_untouched.py` passes; rebuild xref index.

## Common mistakes
- Hand-writing classes that mimic generated code to skip the handoff — they
  compile, then collide at the next model regeneration.
- Forgetting SID registration (runtime auth failure that looks like a bug).
- Putting business logic in the facade instead of the process layer.
