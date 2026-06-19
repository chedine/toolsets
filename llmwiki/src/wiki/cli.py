from __future__ import annotations

from typing import Annotated

import typer

from .config import load_config, resolve_init_vault, resolve_vault_path
from .sources import (
    MD_ARCHIVE_STATUSES,
    URL_ARCHIVE_STATUSES,
    add_url,
    archive_markdown,
    archive_url,
    list_sources,
)
from .status import build_status
from .vault import init_vault

app = typer.Typer(help="Agent-native markdown wiki helper CLI.", no_args_is_help=True)
sources_app = typer.Typer(help="Source queue and archive helpers.", no_args_is_help=True)
app.add_typer(sources_app, name="sources")

_global_vault: str | None = None


def _set_global_vault(vault: str | None) -> None:
    global _global_vault
    _global_vault = vault


def _config(vault: str | None = None):
    try:
        resolved = resolve_vault_path(vault or _global_vault)
        return load_config(resolved)
    except Exception as exc:
        typer.echo(f"Error: {exc}", err=True)
        raise typer.Exit(code=1) from exc


@app.callback()
def callback(
    vault: Annotated[
        str | None,
        typer.Option("--vault", help="Path to wiki vault."),
    ] = None,
) -> None:
    _set_global_vault(vault)


@app.command("init")
def init_command(
    vault: Annotated[
        str | None,
        typer.Option("--vault", help="Target vault directory. Defaults to cwd for init."),
    ] = None,
    topic: Annotated[
        str | None,
        typer.Option("--topic", help="Initial vault topic."),
    ] = None,
) -> None:
    """Create a new vault scaffold."""
    target = resolve_init_vault(vault or _global_vault)
    created = init_vault(target, topic)
    typer.echo(f"Vault initialized: {target}")
    typer.echo(f"Created {len(created)} item(s).")
    if created:
        for path in created:
            try:
                shown = path.relative_to(target)
            except ValueError:
                shown = path
            typer.echo(f"  {shown}")


@app.command("add")
def add_command(
    url: Annotated[str, typer.Argument(help="URL to append to sources/inbox/urls.txt")],
) -> None:
    """Add a URL to the pending source inbox."""
    config = _config()
    added = add_url(config, url)
    if added:
        typer.echo(f"Added: {url}")
    else:
        typer.echo(f"Already pending: {url}")


@app.command("status")
def status_command() -> None:
    """Print concise vault status."""
    config = _config()
    status = build_status(config)
    typer.echo(f"Vault: {status['vault']}")
    typer.echo(f"Pending URLs: {status['pending_urls']}")
    typer.echo(f"Pending markdown files: {status['pending_markdown_files']}")
    typer.echo(f"Open questions: {status['open_questions']}")
    typer.echo(f"Unresolved contradictions: {status['unresolved_contradictions']}")
    typer.echo(f"Last log: {status['last_log']}")
    typer.echo(f"Git: {status['git']}")


@sources_app.command("list")
def sources_list_command() -> None:
    """List pending source items in a parseable format."""
    config = _config()
    for kind, value in list_sources(config):
        typer.echo(f"{kind:<4} {value}")


@sources_app.command("archive-url")
def sources_archive_url_command(
    url: Annotated[str, typer.Argument(help="Exact URL to archive from the inbox.")],
    status: Annotated[
        str,
        typer.Option("--status", help="Archive status."),
    ],
) -> None:
    """Remove a URL from inbox and append it to the URL archive."""
    if status not in URL_ARCHIVE_STATUSES:
        allowed = ", ".join(sorted(URL_ARCHIVE_STATUSES))
        raise typer.BadParameter(f"Invalid status. Allowed: {allowed}")
    config = _config()
    try:
        archive_url(config, url, status)
    except Exception as exc:
        raise typer.Exit(code=1) from _echo_error(exc)
    typer.echo(f"Archived URL as {status}: {url}")


@sources_app.command("archive-md")
def sources_archive_md_command(
    path: Annotated[str, typer.Argument(help="Markdown file under sources/inbox/ to archive.")],
    status: Annotated[
        str,
        typer.Option("--status", help="Archive status."),
    ],
) -> None:
    """Move an inbox markdown file to archive or rejected."""
    if status not in MD_ARCHIVE_STATUSES:
        allowed = ", ".join(sorted(MD_ARCHIVE_STATUSES))
        raise typer.BadParameter(f"Invalid status. Allowed: {allowed}")
    config = _config()
    try:
        dest = archive_markdown(config, path, status)
    except Exception as exc:
        raise typer.Exit(code=1) from _echo_error(exc)
    try:
        shown = dest.relative_to(config.root)
    except ValueError:
        shown = dest
    typer.echo(f"Archived markdown as {status}: {shown}")


def _echo_error(exc: Exception) -> Exception:
    typer.echo(f"Error: {exc}", err=True)
    return exc


def main() -> None:
    app()


if __name__ == "__main__":
    main()
