# Component model: precedence, merge vs overwrite

The single most important thing an agent must understand about a Curam
codebase. Getting this wrong produces changes that silently don't take effect,
or that clobber product behavior.

## Precedence

Components are ordered (see `kit.config.yaml` → `component_order`, reflected
in the build environment's `COMPONENT_ORDER`). When the build finds the same
artifact in multiple components, the resolution depends on the artifact type.

## Overwrite-type artifacts (highest component wins, wholesale)

The winning component's file completely replaces lower ones. To change one,
copy the OOTB file into the custom component at the same relative path, then
edit the copy. **You own the whole file from then on** — product upgrades to
the OOTB version will not flow through; note this in the file header comment.

Typical overwrite types: UIM pages, properties files, JSP/velocity artifacts,
most static client resources.

## Merge-type artifacts (contributions combine)

The build merges contributions across components. You add only your delta in
the custom component; the OOTB content stays live. Never copy the whole OOTB
file for these — you'd duplicate every entry and create merge conflicts at
build time.

Typical merge types: codetables (`.ctx` files merge by codetable name),
messages, application menus/tab configuration, search configurations.

## How to tell which one you're dealing with

1. Check the table in this repo's agency notes if present — agencies sometimes
   customize merge behavior.
2. Check the product Development Compliance / customization guide via
   `manuals-search "customize <artifact type>"`.
3. Empirically: if the OOTB artifact directory has a `.ctx`-style
   "contribution" extension or the manuals describe an append model, it
   merges; if the docs say "copy to your component", it overwrites.

When unsure, **ask or check the manuals — do not guess.** A wrong guess here
passes the build and fails in production behavior.

## The golden rule, restated

OOTB components are read-only inputs. Every change lives in a custom
component. The validator `tools/validators/check_ootb_untouched.py` fails the
change if `git status` shows modifications outside the custom component list.
