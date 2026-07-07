# xref parsers

One module per artifact type. Contract:

```python
GLOB = "*.ext"          # rglob pattern under */components/

def parse(path) -> dict:
    return {"declares": [
        {"type": "<artifact type>", "name": "<name>",
         "refs": [{"to_type": "...", "to_name": "...", "kind": "..."}]},
    ]}
```

`type`/`to_type` vocabulary so far: `codetable`, `code`, `uim`, `facade`,
`facade_op`, `properties`. Keep names canonical (facade operation =
`Facade.operation`).

Included: `codetable.py` (.ctx), `uim.py` (.uim/.vim).

Parsers are view-agnostic: the same module runs over source files
(`*/components/`) and the build's merged output (`live_roots`), since merged
artifacts keep their format. When adding a parser, check what extension the
artifact has in the build output — e.g. merged DMX under
`build/datamanager/data/initial` — and make GLOB match both if they differ.

High-value parsers to add next, roughly in order:
1. `creole.py` — rule sets: declares rule classes, refs to entities/rate
   tables/codetables.
2. `workflow.py` — process definitions: refs to server operations by
   identifier.
3. `dmx.py` — seed data: SID registrations, product configuration rows that
   activate rules.
4. `javaconst.py` — cheap regex pass over source/ for `CT<Table>.<CODE>`
   constant usages and message catalog IDs.
5. `model.py` — if the model files are parseable XML in your version, declare
   facades/entities/structs from the model itself (best source of truth for
   `xref show facade`).
