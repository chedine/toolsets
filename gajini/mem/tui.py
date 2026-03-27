"""TUI — Textual app for browsing and editing notes.

Launched by `mem find`.  Two-panel layout:
  • Left:  list of matching notes (Frogmouth-style)
  • Right: Markdown viewer / inline TextArea editor
  • Top:   search / filter bar
  • Bottom: status bar + keybinding hints

View mode:  rendered Markdown (read-only)
Edit mode:  raw Markdown in a borderless TextArea
            (Ctrl+E toggle, Ctrl+S save, Escape cancel)
"""

from __future__ import annotations

import subprocess
from datetime import datetime
from pathlib import Path

import frontmatter as fm

from textual import on, work
from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, Vertical
from textual.css.query import NoMatches
from textual.reactive import var
from textual.widgets import (
    Footer,
    Header,
    Input,
    ListItem,
    ListView,
    Markdown,
    Static,
    TextArea,
)

from .config import MemConfig, load_config
from .note import Note
from .store import Store


# ──────────────────────────────────────────────────────────────────
# Note list item  (Frogmouth-inspired compact style)
# ──────────────────────────────────────────────────────────────────
class NoteListItem(ListItem):
    """A single note entry in the sidebar list."""

    DEFAULT_CSS = """
    NoteListItem {
        height: 3;
        padding: 0 1;
        border-bottom: solid $surface-lighten-1;
    }
    NoteListItem > .note-title {
        width: 100%;
        height: 1;
        color: $text;
    }
    NoteListItem > .note-meta {
        width: 100%;
        height: 1;
        color: $text-muted;
    }
    NoteListItem:hover {
        background: $surface-lighten-1;
    }
    """

    def __init__(self, note: Note, **kwargs) -> None:
        super().__init__(**kwargs)
        self.note = note

    def compose(self) -> ComposeResult:
        title = self.note.preview or "(empty)"
        # Truncate title to fit sidebar width
        if len(title) > 34:
            title = title[:31] + "…"
        tags = " ".join(f"#{t}" for t in self.note.tags) if self.note.tags else ""
        date = self.note.created.strftime("%b %d, %H:%M")
        meta = f"{date}  {tags}" if tags else date
        yield Static(title, classes="note-title")
        yield Static(meta, classes="note-meta")


# ──────────────────────────────────────────────────────────────────
# Search bar
# ──────────────────────────────────────────────────────────────────
class SearchBar(Horizontal):
    """Full-width search / filter bar at the top."""

    DEFAULT_CSS = """
    SearchBar {
        height: 3;
        dock: top;
        padding: 0 1;
        background: $boost;
        border-bottom: solid $surface-lighten-1;
    }
    SearchBar > Static {
        width: auto;
        height: 3;
        content-align: left middle;
        padding: 0 1;
        color: $text-muted;
    }
    SearchBar > Input {
        width: 1fr;
        margin: 0 0 0 1;
    }
    """

    def compose(self) -> ComposeResult:
        yield Static(" 🔍")
        yield Input(
            placeholder="Search notes…  (text search or #tag)",
            id="search-input",
        )


# ──────────────────────────────────────────────────────────────────
# Status bar
# ──────────────────────────────────────────────────────────────────
class StatusBar(Horizontal):
    """Bottom status strip."""

    DEFAULT_CSS = """
    StatusBar {
        height: 1;
        dock: bottom;
        background: $primary;
        color: $text;
        padding: 0 1;
    }
    StatusBar > Static {
        width: 1fr;
        height: 1;
        content-align: left middle;
    }
    StatusBar > .right {
        content-align: right middle;
        width: auto;
    }
    """

    def compose(self) -> ComposeResult:
        yield Static("Ready", id="status-msg")
        yield Static("mem v0.1", classes="right")

    def set_message(self, msg: str) -> None:
        self.query_one("#status-msg", Static).update(msg)


# ──────────────────────────────────────────────────────────────────
# Note sidebar
# ──────────────────────────────────────────────────────────────────
class NoteSidebar(Vertical):
    """Left panel — scrollable list of notes."""

    DEFAULT_CSS = """
    NoteSidebar {
        width: 38;
        dock: left;
        border-right: solid $surface-lighten-1;
    }
    NoteSidebar > .sidebar-title {
        width: 100%;
        height: 1;
        background: $primary;
        color: $text;
        text-style: bold;
        padding: 0 1;
    }
    NoteSidebar > ListView {
        width: 100%;
        height: 1fr;
        scrollbar-size: 1 1;
    }
    NoteSidebar > ListView:focus {
        border: none;
    }
    """

    can_focus = False

    def compose(self) -> ComposeResult:
        yield Static("  📝  Notes", classes="sidebar-title", id="sidebar-title")
        yield ListView(id="note-list")

    def set_title(self, text: str) -> None:
        self.query_one("#sidebar-title", Static).update(text)


# ──────────────────────────────────────────────────────────────────
# Main TUI app
# ──────────────────────────────────────────────────────────────────
class MemFinderApp(App):
    """Browse and edit notes in a two-panel terminal UI."""

    TITLE = "mem"
    SUB_TITLE = "notes"

    CSS = """
    Screen {
        layout: vertical;
    }

    /* ── Layout ─────────────────────────────────────────────── */
    #content-area {
        height: 1fr;
    }
    #viewer {
        width: 1fr;
    }

    /* ── Markdown viewer ────────────────────────────────────── */
    #md-viewer {
        width: 100%;
        height: 1fr;
        padding: 0 2;
    }

    /* ── Text editor — seamless, no border, same position ──── */
    #text-editor {
        width: 100%;
        height: 1fr;
        display: none;
        border: none;
        padding: 0 1;
        background: $surface;
    }
    #text-editor:focus {
        border: none;
    }

    /* ── Welcome splash ─────────────────────────────────────── */
    #welcome {
        width: 100%;
        height: 100%;
        content-align: center middle;
        color: $text-muted;
        padding: 0 2;
    }

    /* ── ListView items: highlight selected ──────────────── */
    ListView > ListItem.--highlight {
        background: $primary 30%;
    }
    ListView:focus > ListItem.--highlight {
        background: $primary 50%;
    }
    ListView > ListItem.--highlight > .note-title {
        text-style: bold;
        color: $text;
    }
    """

    BINDINGS = [
        Binding("ctrl+f", "focus_search", "Search", show=True, priority=True),
        Binding("ctrl+e", "toggle_edit", "Edit", show=True, priority=True),
        Binding("ctrl+s", "save_note", "Save", show=True, priority=True),
        Binding("escape", "cancel_edit", "Cancel", show=True, priority=True),
        Binding("ctrl+n", "new_note", "New", show=True, priority=True),
        Binding("ctrl+d", "delete_note", "Delete", show=True, priority=True),
        Binding("ctrl+b", "toggle_sidebar", "Sidebar", show=True, priority=True),
        Binding("ctrl+i", "paste_image", "Image", show=True, priority=True),
        Binding("ctrl+o", "open_images", "Open img", show=True, priority=True),
        Binding("ctrl+j", "next_note", "Next", show=True, priority=True),
        Binding("ctrl+k", "prev_note", "Prev", show=True, priority=True),
        Binding("tab", "cycle_focus", "Focus", show=False, priority=True),
        Binding("shift+tab", "cycle_focus_reverse", "Focus", show=False, priority=True),
        Binding("ctrl+q", "quit", "Quit", show=True, priority=True),
    ]

    edit_mode: var[bool] = var(False)
    current_note: var[Note | None] = var(None)
    _creating_new: bool = False

    def __init__(
        self,
        notes: list[Note] | None = None,
        initial_query: str = "",
        config: MemConfig | None = None,
        start_in_new_mode: bool = False,
        start_in_edit_mode: bool = False,
        new_tags: list[str] | None = None,
        **kwargs,
    ) -> None:
        super().__init__(**kwargs)
        self._initial_notes = notes or []
        self._initial_query = initial_query
        self._config = config or load_config()
        self._store = Store(self._config)
        self._start_new = start_in_new_mode
        self._start_edit = start_in_edit_mode
        self._new_tags = new_tags or []

    # ── compose ──────────────────────────────────────────────────
    def compose(self) -> ComposeResult:
        yield Header(show_clock=True)
        yield SearchBar()
        with Horizontal(id="content-area"):
            yield NoteSidebar()
            with Vertical(id="viewer"):
                yield Static(
                    "Select a note from the sidebar\n"
                    "or search above.\n\n"
                    "  Tab       Cycle focus (search → list → viewer)\n"
                    "  Ctrl+F    Search\n"
                    "  Ctrl+E    Edit note inline\n"
                    "  Ctrl+S    Save edits\n"
                    "  Escape    Cancel editing\n"
                    "  Ctrl+N    New note\n"
                    "  Ctrl+D    Delete note\n"
                    "  Ctrl+B    Toggle sidebar\n"
                    "  Ctrl+Q    Quit",
                    id="welcome",
                )
                yield Markdown("", id="md-viewer")
                yield TextArea("", id="text-editor", language="markdown",
                               show_line_numbers=False, tab_behavior="indent")
        yield StatusBar()
        yield Footer()

    def on_mount(self) -> None:
        self.query_one("#md-viewer").display = False

        if self._initial_notes:
            self._populate_list(self._initial_notes)

        if self._initial_query:
            self.query_one("#search-input", Input).value = self._initial_query
        elif self._initial_notes:
            self._show_note(self._initial_notes[0])

        # Start the list focused so you can navigate immediately
        if self._initial_notes and not self._start_new and not self._start_edit:
            lv = self.query_one("#note-list", ListView)
            lv.index = 0
            lv.focus()

        if self._start_new:
            self.call_later(self._start_new_note_mode)
        elif self._start_edit and self._initial_notes:
            self._show_note(self._initial_notes[0])
            self.call_later(self.action_toggle_edit)

    def _start_new_note_mode(self) -> None:
        """Enter new-note editing mode with optional pre-set tags."""
        self._creating_new = True
        template = Note.editor_template(self._new_tags)
        editor = self.query_one("#text-editor", TextArea)
        editor.load_text(template)
        try:
            self.query_one("#welcome").display = False
        except NoMatches:
            pass
        self.query_one("#md-viewer", Markdown).display = False
        self.edit_mode = True
        self.query_one(StatusBar).set_message("New note — type content then Ctrl+S")

    # ── edit mode toggle ─────────────────────────────────────────
    def watch_edit_mode(self, editing: bool) -> None:
        """Swap between Markdown viewer and TextArea editor."""
        try:
            md = self.query_one("#md-viewer", Markdown)
            editor = self.query_one("#text-editor", TextArea)
        except NoMatches:
            return

        if editing:
            md.display = False
            editor.display = True
            editor.focus()
        else:
            editor.display = False
            if self.current_note:
                md.display = True

    # ── focus cycling ────────────────────────────────────────────
    def action_cycle_focus(self) -> None:
        """Tab: search ↔ list (in edit mode, let TextArea handle Tab)."""
        if self.edit_mode:
            return  # TextArea uses Tab for indent
        focused = self.focused
        search = self.query_one("#search-input", Input)
        note_list = self.query_one("#note-list", ListView)

        if focused is search:
            note_list.focus()
        else:
            search.focus()

    def action_cycle_focus_reverse(self) -> None:
        """Shift+Tab: same as Tab (only two stops)."""
        self.action_cycle_focus()

    # ── note cycling (works even with sidebar hidden) ──────────
    def action_next_note(self) -> None:
        if self.edit_mode:
            return
        lv = self.query_one("#note-list", ListView)
        if lv.index is None:
            lv.index = 0
        elif lv.index < len(lv.children) - 1:
            lv.index += 1
        item = lv.children[lv.index] if lv.children else None
        if isinstance(item, NoteListItem):
            self._show_note(item.note)

    def action_prev_note(self) -> None:
        if self.edit_mode:
            return
        lv = self.query_one("#note-list", ListView)
        if lv.index is None:
            lv.index = 0
        elif lv.index > 0:
            lv.index -= 1
        item = lv.children[lv.index] if lv.children else None
        if isinstance(item, NoteListItem):
            self._show_note(item.note)

    # ── actions ──────────────────────────────────────────────────
    def action_focus_search(self) -> None:
        if self.edit_mode:
            return
        self.query_one("#search-input", Input).focus()

    def action_toggle_sidebar(self) -> None:
        sb = self.query_one(NoteSidebar)
        sb.display = not sb.display

    def action_toggle_edit(self) -> None:
        """Enter edit mode for the current note."""
        if self.edit_mode:
            self._exit_edit_mode(save=False)
            return

        if self.current_note is None:
            return

        self._creating_new = False
        raw = self.current_note.path.read_text(encoding="utf-8")
        editor = self.query_one("#text-editor", TextArea)
        editor.load_text(raw)
        self.edit_mode = True
        self.query_one(StatusBar).set_message(
            f"✏️  Editing: {self.current_note.path.name}  •  Ctrl+S save  •  Esc cancel"
        )

    def action_save_note(self) -> None:
        if not self.edit_mode:
            return
        self._exit_edit_mode(save=True)

    def action_cancel_edit(self) -> None:
        if not self.edit_mode:
            return
        self._exit_edit_mode(save=False)

    def action_new_note(self) -> None:
        if self.edit_mode:
            return

        self._creating_new = True
        template = Note.editor_template()
        editor = self.query_one("#text-editor", TextArea)
        editor.load_text(template)

        try:
            self.query_one("#welcome").display = False
        except NoMatches:
            pass
        self.query_one("#md-viewer", Markdown).display = False

        self.edit_mode = True
        self.query_one(StatusBar).set_message(
            "✏️  New note — type content then Ctrl+S"
        )

    def action_paste_image(self) -> None:
        """Grab image from clipboard and insert markdown reference."""
        if not self.edit_mode:
            return
        self._paste_clipboard_image()

    @work(thread=True)
    def _paste_clipboard_image(self) -> None:
        """Check clipboard for an image, save to .assets/, insert ref."""
        from .clipboard import has_image, save_image

        if not has_image():
            self.app.call_from_thread(
                self.query_one(StatusBar).set_message,
                "No image in clipboard",
            )
            return

        # Save clipboard image to .assets/
        self._config.ensure_dirs()
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        dest = self._config.assets_dir / f"clip-{stamp}.png"
        counter = 1
        while dest.exists():
            dest = self._config.assets_dir / f"clip-{stamp}-{counter}.png"
            counter += 1

        if not save_image(dest):
            self.app.call_from_thread(
                self.query_one(StatusBar).set_message,
                "Failed to save clipboard image",
            )
            return

        # Build relative markdown ref with descriptive alt text
        rel = dest.relative_to(self._config.memory_dir)
        size_kb = dest.stat().st_size / 1024
        md_ref = f"\n\n![📎 {dest.name} ({size_kb:.0f} KB)]({rel})\n"

        self.app.call_from_thread(self._insert_text_at_cursor, md_ref)
        self.app.call_from_thread(
            self.query_one(StatusBar).set_message,
            f"📎 Pasted: {dest.name} ({size_kb:.0f} KB)",
        )

    def _insert_text_at_cursor(self, text: str) -> None:
        """Insert text at the TextArea cursor position."""
        editor = self.query_one("#text-editor", TextArea)
        editor.insert(text)

    def action_open_images(self) -> None:
        """Open images referenced in the current note with the system viewer."""
        if self.current_note is None:
            return
        import re
        refs = re.findall(r"!\[.*?\]\((.+?)\)", self.current_note.content)
        if not refs:
            self.query_one(StatusBar).set_message("No images in this note")
            return
        self._open_image_files(refs)

    @work(thread=True)
    def _open_image_files(self, refs: list[str]) -> None:
        import platform
        opener = {"Darwin": "open", "Windows": "start", "Linux": "xdg-open"}
        cmd = opener.get(platform.system(), "xdg-open")
        opened = 0
        for ref in refs:
            path = self._config.memory_dir / ref
            if path.exists():
                subprocess.run([cmd, str(path)])
                opened += 1
        self.app.call_from_thread(
            self.query_one(StatusBar).set_message,
            f"Opened {opened} image{'s' if opened != 1 else ''}",
        )

    def action_delete_note(self) -> None:
        if self.edit_mode:
            return
        if self.current_note is None:
            return
        note = self.current_note
        self._store.delete(note)
        self.current_note = None
        self._run_search(self.query_one("#search-input", Input).value)
        self.query_one(StatusBar).set_message(f"Deleted: {note.path.name}")
        self.query_one("#md-viewer", Markdown).display = False
        try:
            self.query_one("#welcome").display = True
        except NoMatches:
            pass

    # ── event handlers ───────────────────────────────────────────
    @on(Input.Submitted, "#search-input")
    def on_search_submitted(self, event: Input.Submitted) -> None:
        if self.edit_mode:
            return
        self._run_search(event.value.strip())
        # After search, focus the list so user can navigate results
        self.query_one("#note-list", ListView).focus()

    @on(Input.Changed, "#search-input")
    def on_search_changed(self, event: Input.Changed) -> None:
        if self.edit_mode:
            return
        query = event.value.strip()
        if len(query) >= 2 or query == "":
            self._run_search(query)

    @on(ListView.Selected, "#note-list")
    def on_note_selected(self, event: ListView.Selected) -> None:
        if self.edit_mode:
            return
        item = event.item
        if isinstance(item, NoteListItem):
            self._show_note(item.note)

    @on(ListView.Highlighted, "#note-list")
    def on_note_highlighted(self, event: ListView.Highlighted) -> None:
        """Show note preview as user arrows through the list."""
        if self.edit_mode:
            return
        item = event.item
        if isinstance(item, NoteListItem):
            self._show_note(item.note)

    # ── internals ────────────────────────────────────────────────
    def _exit_edit_mode(self, *, save: bool) -> None:
        editor = self.query_one("#text-editor", TextArea)
        raw = editor.text

        if save:
            try:
                post = fm.loads(raw)
                tags = post.get("tags", [])
                if isinstance(tags, str):
                    tags = [t.strip() for t in tags.split(",") if t.strip()]
                body = post.content.strip()
            except Exception:
                tags = []
                body = raw.strip()

            if self._creating_new:
                if not body:
                    self.query_one(StatusBar).set_message("Empty note — discarded")
                else:
                    note = Note.new(self._config.memory_dir, body, tags)
                    self._store.index_note(note)
                    self.current_note = note
                    self.query_one(StatusBar).set_message(f"✓ Created: {note.path.name}")
            else:
                note = self.current_note
                if note:
                    note.content = body
                    note.tags = tags if tags else ["inbox"]
                    note.save()
                    self._store.index_note(note)
                    note = Note.load(note.path)
                    self.current_note = note
                    self.query_one(StatusBar).set_message(f"✓ Saved: {note.path.name}")

            self._run_search(self.query_one("#search-input", Input).value)
            if self.current_note:
                self._show_note(self.current_note)
        else:
            msg = "Discarded new note" if self._creating_new else "Edit cancelled"
            self.query_one(StatusBar).set_message(msg)
            if self.current_note:
                self._show_note(self.current_note)

        self._creating_new = False
        self.edit_mode = False
        # Return focus to the note list
        self.query_one("#note-list", ListView).focus()

    def _run_search(self, query: str) -> None:
        if not query:
            notes = self._store.all_notes()
        elif query.startswith("#"):
            raw_tags = query.lstrip("#")
            tags = [t.strip() for t in raw_tags.split(",") if t.strip()]
            notes = self._store.find_by_tags_any(tags) if tags else self._store.all_notes()
        else:
            notes = self._store.search(query)
        self._populate_list(notes)
        count = len(notes)
        self.query_one(StatusBar).set_message(
            f"Found {count} note{'s' if count != 1 else ''}"
        )
        current_paths = {n.path for n in notes}
        if notes and (self.current_note is None or self.current_note.path not in current_paths):
            self._show_note(notes[0])

    def _populate_list(self, notes: list[Note]) -> None:
        lv = self.query_one("#note-list", ListView)
        lv.clear()
        for note in notes:
            lv.append(NoteListItem(note))
        sidebar = self.query_one(NoteSidebar)
        sidebar.set_title(f"  📝  Notes ({len(notes)})")

    def _show_note(self, note: Note) -> None:
        try:
            note = Note.load(note.path)
        except Exception:
            pass

        self.current_note = note

        try:
            self.query_one("#welcome").display = False
        except NoMatches:
            pass

        md = self.query_one("#md-viewer", Markdown)
        md.display = True
        md.update(note.content)

        tags = " ".join(f"#{t}" for t in note.tags) if note.tags else "no tags"
        date = note.created.strftime("%Y-%m-%d %H:%M")
        self.query_one(StatusBar).set_message(
            f"📄 {note.path.name}  •  {date}  •  {tags}"
        )
        self.sub_title = note.path.name


# ──────────────────────────────────────────────────────────────────
# Convenience launcher
# ──────────────────────────────────────────────────────────────────
def run_finder(
    notes: list[Note] | None = None,
    query: str = "",
    config: MemConfig | None = None,
) -> None:
    app = MemFinderApp(notes=notes, initial_query=query, config=config)
    app.run()
