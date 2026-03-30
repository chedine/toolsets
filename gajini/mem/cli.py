"""CLI entry point — the `mem` command.

Usage
-----
  mem                                  # TUI with inbox notes
  mem new "text" -t ideas -T "Title"   # quick note with tags and title
  mem new                              # TUI editor with blank template
  mem new -i photo.png "caption"       # note with image
  mem find "search text"               # full-text search → TUI
  mem find -t ideas                    # tag search → TUI
  mem ls                               # list recent notes
  mem tags                             # list all tags
  mem edit <filename>                  # TUI editor for specific note
  mem serve                            # web interface
  mem reindex                          # rebuild FTS5 index
  mem config                           # show config
"""

from __future__ import annotations

import sys
from pathlib import Path

import click

from .config import load_config
from .note import Note
from .store import Store


@click.group(invoke_without_command=True)
@click.version_option(package_name="mem")
@click.pass_context
def cli(ctx: click.Context) -> None:
    """mem — a minimal CLI note-taking system."""
    ctx.ensure_object(dict)
    ctx.obj["config"] = load_config()
    ctx.obj["store"] = Store(ctx.obj["config"])

    if ctx.invoked_subcommand is None:
        # Bare `mem` → open TUI with inbox notes
        from .tui import run_finder

        cfg = ctx.obj["config"]
        store = ctx.obj["store"]
        notes = store.find_by_tags_any(["inbox"])
        run_finder(notes=notes, query="#inbox", config=cfg)


# ──────────────────────────────────────────────────────────────────
# mem new
# ──────────────────────────────────────────────────────────────────
@cli.command()
@click.argument("text", required=False, default=None)
@click.option("-t", "--tags", default="", help="Comma-separated tags")
@click.option("-T", "--title", default="", help="Note title")
@click.option("-i", "--image", type=click.Path(exists=True), help="Attach an image")
@click.pass_context
def new(ctx: click.Context, text: str | None, tags: str, title: str, image: str | None) -> None:
    """Create a new note.

    If TEXT is given, create the note directly.
    Otherwise, open the TUI with a blank editor.
    """
    cfg = ctx.obj["config"]
    store = ctx.obj["store"]
    tag_list = [t.strip() for t in tags.split(",") if t.strip()]

    # Handle image attachment
    image_ref = ""
    if image:
        src = Path(image).resolve()
        rel = store.import_image(src)
        image_ref = f"\n\n![{src.stem}]({rel})\n"

    if text is not None:
        # Quick inline note
        content = text + image_ref
        note = Note.new(cfg.memory_dir, content, tag_list, title=title)
        _print_created(note)
    else:
        # Open TUI in new-note mode
        from .tui import MemFinderApp

        notes = store.all_notes()
        app = MemFinderApp(notes=notes, config=cfg, start_in_new_mode=True, new_tags=tag_list)
        app.run()


# ──────────────────────────────────────────────────────────────────
# mem find
# ──────────────────────────────────────────────────────────────────
@cli.command()
@click.argument("query", required=False, default=None)
@click.option("-t", "--tags", default="", help="Comma-separated tags to filter by")
@click.pass_context
def find(ctx: click.Context, query: str | None, tags: str) -> None:
    """Search notes and browse in the TUI.

    Searches by text, tags, or both.  Opens an interactive
    two-panel browser with the results.
    """
    cfg = ctx.obj["config"]
    store = ctx.obj["store"]

    tag_list = [t.strip() for t in tags.split(",") if t.strip()]

    notes: list[Note] = []
    search_display = ""

    if tag_list and query:
        # Both text and tag filter
        by_tag = set(n.path for n in store.find_by_tags_any(tag_list))
        by_text = store.search(query)
        notes = [n for n in by_text if n.path in by_tag]
        search_display = f"{query} #{','.join(tag_list)}"
    elif tag_list:
        notes = store.find_by_tags_any(tag_list)
        search_display = "#" + ",".join(tag_list)
    elif query:
        notes = store.search(query)
        search_display = query
    else:
        notes = store.all_notes()
        search_display = ""

    if not notes:
        click.echo(f"No notes found{' for: ' + search_display if search_display else ''}.")
        sys.exit(0)

    # Launch TUI
    from .tui import run_finder

    run_finder(notes=notes, query=search_display, config=cfg)


# ──────────────────────────────────────────────────────────────────
# mem tags
# ──────────────────────────────────────────────────────────────────
@cli.command()
@click.pass_context
def tags(ctx: click.Context) -> None:
    """List all tags with note counts."""
    store = ctx.obj["store"]
    all_tags = store.all_tags()
    if not all_tags:
        click.echo("No tags found.")
        return

    max_tag_len = max(len(t) for t in all_tags)
    click.echo(f"\n{'Tag':<{max_tag_len + 4}}Count")
    click.echo("─" * (max_tag_len + 10))
    for tag, count in all_tags.items():
        click.echo(f"  #{tag:<{max_tag_len + 2}}{count}")
    click.echo()


# ──────────────────────────────────────────────────────────────────
# mem ls
# ──────────────────────────────────────────────────────────────────
@cli.command(name="ls")
@click.option("-n", "--limit", default=20, help="Max notes to show")
@click.option("-t", "--tags", default="", help="Filter by tags")
@click.pass_context
def ls(ctx: click.Context, limit: int, tags: str) -> None:
    """List recent notes."""
    store = ctx.obj["store"]
    tag_list = [t.strip() for t in tags.split(",") if t.strip()]

    if tag_list:
        notes = store.find_by_tags_any(tag_list)
    else:
        notes = store.all_notes()

    notes = notes[:limit]
    if not notes:
        click.echo("No notes found.")
        return

    click.echo()
    for note in notes:
        date = note.created.strftime("%Y-%m-%d %H:%M")
        tag_str = " ".join(f"#{t}" for t in note.tags) if note.tags else ""
        preview = note.preview[:60]
        click.echo(f"  {date}  {preview:<62s} {tag_str}")
    click.echo(f"\n  ({len(notes)} notes)")
    click.echo()


# ──────────────────────────────────────────────────────────────────
# mem config
# ──────────────────────────────────────────────────────────────────
@cli.command()
@click.pass_context
def config(ctx: click.Context) -> None:
    """Show current configuration."""
    cfg = ctx.obj["config"]
    click.echo(f"\n  memory_dir:  {cfg.memory_dir}")
    click.echo(f"  editor:      {cfg.editor}")
    click.echo(f"  assets_dir:  {cfg.assets_dir}")
    click.echo(f"  default_tags: {cfg.default_tags}")
    click.echo()


# ──────────────────────────────────────────────────────────────────
# mem append <filename> <text>
# ──────────────────────────────────────────────────────────────────
@cli.command()
@click.argument("filename")
@click.argument("text")
@click.pass_context
def append(ctx: click.Context, filename: str, text: str) -> None:
    """Append text to an existing note."""
    cfg = ctx.obj["config"]
    store = ctx.obj["store"]
    path = cfg.memory_dir / filename
    if not path.exists() and not filename.endswith(".md"):
        path = cfg.memory_dir / f"{filename}.md"
    if not path.exists():
        click.echo(f"Note not found: {filename}", err=True)
        sys.exit(1)

    note = Note.load(path)
    note.content = note.content.rstrip() + "\n\n" + text
    note.save()
    store.index_note(note)
    click.echo(f"✓ Appended to {note.path.name}")


# ──────────────────────────────────────────────────────────────────
# mem edit <filename>
# ──────────────────────────────────────────────────────────────────
@cli.command()
@click.argument("filename")
@click.pass_context
def edit(ctx: click.Context, filename: str) -> None:
    """Open a specific note in the TUI for editing."""
    cfg = ctx.obj["config"]
    store = ctx.obj["store"]
    # Try exact filename, then with .md suffix
    path = cfg.memory_dir / filename
    if not path.exists() and not filename.endswith(".md"):
        path = cfg.memory_dir / f"{filename}.md"
    if not path.exists():
        click.echo(f"Note not found: {filename}", err=True)
        sys.exit(1)

    from .tui import MemFinderApp
    from .note import Note

    note = Note.load(path)
    app = MemFinderApp(notes=[note], config=cfg, start_in_edit_mode=True)
    app.run()


# ──────────────────────────────────────────────────────────────────
# mem reindex
# ──────────────────────────────────────────────────────────────────
@cli.command()
@click.pass_context
def reindex(ctx: click.Context) -> None:
    """Rebuild the search index from scratch."""
    store = ctx.obj["store"]
    count = store.rebuild_index()
    click.echo(f"✓ Indexed {count} notes")


# ──────────────────────────────────────────────────────────────────
# mem serve
# ──────────────────────────────────────────────────────────────────
@cli.command()
@click.option("-p", "--port", default=8899, help="Port")
@click.option("--host", default="0.0.0.0", help="Host")
@click.pass_context
def serve(ctx: click.Context, port: int, host: str) -> None:
    """Start the web interface."""
    from .web import start_server
    start_server(host=host, port=port, config=ctx.obj["config"])


# ──────────────────────────────────────────────────────────────────
# Helpers
# ──────────────────────────────────────────────────────────────────
def _print_created(note: Note) -> None:
    tags = " ".join(f"#{t}" for t in note.tags) if note.tags else ""
    click.echo(f"✓ Created {note.path.name}  {tags}")


def main() -> None:
    cli()
