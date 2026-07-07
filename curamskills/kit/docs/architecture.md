# Architecture overview (generic Curam)

Layered architecture; each layer only calls downward.

```
Browser
  └─ webclient (UIM-defined pages, rendered by the Curam client infrastructure)
       └─ Facade layer (remote-able entry points; generated from UML model,
          implementation in source/)
            └─ Business layer (process classes, entities, CREOLE rules,
               workflow enactment)
                 └─ Data layer (entities generated from model; DMX seed data)
```

Key generation flows (why you can't just write code):

- **UML model → generated Java.** Facades, entities, structs, and their
  interfaces are generated at build time from the RSA model. Handwritten code
  implements generated abstract classes / fills designated extension points.
  The model is human-edited; agents produce specs, not model edits.
- **UIM → rendered pages.** UIM XML is metadata consumed by the client
  infrastructure at runtime/build; there is no per-page Java or JS to edit.
- **Codetables → constants + DB rows.** `.ctx` files generate Java constant
  classes and DB content.

Customization happens via a custom component that the build resolves above
OOTB components (see `component-model.md`), plus sanctioned extension
mechanisms: events/hooks, strategy overrides via Guice bindings, subclassing
designated classes, configuration. Prefer these over copy-and-own whenever the
manuals list one for your artifact.
