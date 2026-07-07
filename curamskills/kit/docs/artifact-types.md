# Component directory legend

Every component (OOTB and custom) follows this structure. Server-side
components live under `EJBServer/components/<name>/`, client-side under
`webclient/components/<name>/`.

## Server component subdirectories

| Directory | Contents | Notes for agents |
|---|---|---|
| `axis/` | Outbound web service WSDLs | Build generates client stubs from these; never edit generated stubs |
| `codetable/` | Codetable XML (`.ctx`) | **Merge-type.** Add only new codes/tables in custom component |
| `CREOLE_Rule_sets/` | CREOLE eligibility/entitlement rule sets | Custom DSL (XML). See rules skill before editing; validate with CREOLE validator via build |
| `data/` | DMX files — DML equivalents for initial/demo data | Keyed rows; respect key ranges reserved per component |
| `message/` | Message catalogs (XML) | **Merge-type.** Localizable text referenced by ID from code |
| `model/` | UML model fragments (where present) | **Human-edited in RSA. Never modify.** Generated code comes from here |
| `rest/` | REST resource definitions | Maps REST endpoints to server operations |
| `source/` | Java source | Handcrafted code: facades' implementation classes, hooks, events, strategies |
| `test/` | Tests | Run relevant tests after server changes |
| `workflow/` | Workflow process definitions (XML) | Custom DSL; versioned — changes may need a new process version |

## Client component subdirectories (webclient)

| Directory | Contents | Notes |
|---|---|---|
| `<component>/` UIM files | `.uim` page definitions, `.vim` view includes | **Overwrite-type.** Page ID = file name; referenced from tabs/navigation config |
| `*.properties` | Page-level text | Pairs with the UIM of the same name |
| config XML | Tab, section, navigation, app menu configuration | Mostly merge-type contributions |

## Cross-reference cheat sheet (what points at what)

- UIM `SERVER_INTERFACE` → facade class + operation (by name)
- UIM `PAGE_ID` ← tab/navigation config, other UIMs' `LINK`/`ACTION_CONTROL`
- Codetable name ← domain definitions in the model, UIM `CODETABLE` fields,
  Java `CT<Name>` constants
- Rules ← activated by product configuration rows (data/DMX), reference
  entities and rate tables by name
- Workflow steps → server operations by identifier
- Messages ← referenced by catalog + ID from Java and rules

None of these are compiler-checked. Use the xref index (`tools/xref/`) to
trace them; grep alone will miss and mislead.
