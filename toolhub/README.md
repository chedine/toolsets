# toolhub (`tool`)

A tiny command launcher with a registry of named commands.

## Features

- `tool list` — list available commands
- `tool run <name-or-shortcut>` — run by command name or shortcut
- `tool add <name> -- <command>` or `tool add <name> --cmd "..."` — add commands quickly
- Per-command `cwd`, `description`, and environment variables
- Placeholder args in commands (`$1`, `$2`, `${10}`) with runtime substitution
- Runs commands in your default shell (`$SHELL -lc`) and loads common shell rc files for aliases (`~/.zshrc`, `~/.bashrc`)
- Registry stored in JSON (`~/.tool-registry.json` by default)

## Quick start

```bash
# from this folder
./tool init

./tool add cmd1 --cwd ~/project1 --desc "Project 1 dev server" -- npm run dev
./tool add cmd2 --cwd ~/project2 --desc "Script runner" -- python myscript.py arg1

./tool list
./tool run cmd1
```

## Install globally

Option 1: put this repo in your PATH and keep using `tool`.

Option 2: symlink:

```bash
ln -s "$(pwd)/tool" /usr/local/bin/tool
# or: ln -s "$(pwd)/tool" ~/.local/bin/tool
```

## Registry location

Default registry path:

- `~/.tool-registry.json`
- Or override with `TOOL_REGISTRY=/path/to/registry.json`
- Or per command: `tool --registry /path/to/registry.json list`

## Command reference

### `tool init [--force]`
Initialize an empty registry.

### `tool list`
List commands.

### `tool add <name> [--cwd PATH] [--desc TEXT] [--shortcut CODE] [--env KEY=VALUE ...] [--force] [--cmd "..."] [-- <command...>]`
Add a command. Use `--cmd` when the command itself contains complex quoting.

Examples:

```bash
tool add dev1 --cwd ~/project1 --shortcut 1 -- npm run dev
tool add pyjob --cwd ~/project2 --env PYTHONPATH=. -- python myscript.py arg1
tool add inspect --cmd "python3 -c 'import sys; print(sys.argv)'"
```

### `tool run <name-or-shortcut> [--dry-run] [-- <extra args...>]`
Run a command from the registry using your default shell (`$SHELL -lc`). For alias support, `tool` loads `~/.zshrc` (zsh) or `~/.bashrc` (bash).

If the configured command contains placeholders (`$1`, `$2`, `${10}`), those are filled from runtime args. Missing required placeholders are an error; extra args are appended.

Examples:

```bash
tool run dev1
tool run 1
tool run pyjob -- --verbose --limit 10

# Placeholder example:
tool add fetch --cmd 'intra-history fetch-all-equities --from $1 --to $2 --out-dir data/equities --symbols-file data/vol_ok_symbols.txt --no-resume'
tool run fetch 2023-01-01 2025-12-31
```

### `tool remove <name>`
Delete a command.

## Registry format

```json
{
  "cmd1": {
    "command": "npm run dev",
    "cwd": "~/project1",
    "description": "Project 1 dev server",
    "shortcut": "1",
    "env": {
      "NODE_ENV": "development"
    }
  },
  "cmd2": "cd ~/project2 && python myscript.py arg1"
}
```
