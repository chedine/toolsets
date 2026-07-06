import { EditorState } from "@codemirror/state";
import {
  EditorView,
  drawSelection,
  dropCursor,
  highlightSpecialChars,
  keymap,
  placeholder,
  scrollPastEnd,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown, markdownKeymap } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { theme } from "./theme";
import { images } from "./images";

// Monochrome markdown: structure is shown through weight and shade,
// never through color.
const markdownHighlight = HighlightStyle.define([
  // dark theme sets --heading-weight: 800 to counter the flattening
  // of bold on dark backgrounds
  { tag: tags.heading, fontWeight: "var(--heading-weight, bold)" },
  { tag: tags.strong, fontWeight: "bold" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strikethrough, textDecoration: "line-through" },
  { tag: tags.quote, color: "var(--dim)" },
  { tag: tags.processingInstruction, color: "var(--dim)" },
  { tag: tags.url, color: "var(--dim)" },
  { tag: tags.link, textDecoration: "underline" },
  { tag: tags.monospace, color: "var(--dim)" },
]);

const statusRight = document.getElementById("status-right")!;

function updateStatus(state: EditorState): void {
  const text = state.doc.toString();
  const words = text.match(/\S+/g)?.length ?? 0;
  const line = state.doc.lineAt(state.selection.main.head).number;
  statusRight.textContent = `${words}W ${text.length}C ${line}L`;
}

export interface Editor {
  view: EditorView;
  // Replace the document (switching files). Resets undo history.
  setDoc(text: string): void;
  // Put the cursor on a line and scroll it near the top.
  revealLine(line: number): void;
}

export function createEditor(
  parent: HTMLElement,
  onDocChange: (text: string) => void,
): Editor {
  const extensions = [
    theme,
    EditorView.lineWrapping,
    history(),
    drawSelection(),
    dropCursor(),
    highlightSpecialChars(),
    scrollPastEnd(),
    placeholder("~"),
    markdown(),
    syntaxHighlighting(markdownHighlight),
    images,
    // markdownKeymap first: its Enter continues "- " lists (and
    // clears the marker on an empty item); Backspace eats markers.
    keymap.of([...markdownKeymap, ...defaultKeymap, ...historyKeymap]),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        onDocChange(update.state.doc.toString());
      }
      if (update.docChanged || update.selectionSet) {
        updateStatus(update.state);
      }
    }),
  ];

  const view = new EditorView({
    parent,
    state: EditorState.create({ doc: "", extensions }),
  });

  updateStatus(view.state);
  view.focus();

  return {
    view,
    setDoc(text: string) {
      view.setState(EditorState.create({ doc: text, extensions }));
      updateStatus(view.state);
      view.focus();
    },
    revealLine(line: number) {
      const l = view.state.doc.line(
        Math.max(1, Math.min(line, view.state.doc.lines)),
      );
      view.dispatch({
        selection: { anchor: l.from },
        effects: EditorView.scrollIntoView(l.from, {
          y: "start",
          yMargin: 60,
        }),
      });
      view.focus();
    },
  };
}
