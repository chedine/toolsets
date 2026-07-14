import { useEffect, useRef } from "react";
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { sql } from "@codemirror/lang-sql";
import { bracketMatching, HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { drawSelection, EditorView, keymap } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import type { DatabaseCatalog } from "../../src/core/types";

const highlight = HighlightStyle.define([
  { tag: tags.keyword, color: "var(--accent)" },
  { tag: tags.string, color: "var(--dim)", fontStyle: "italic" },
  { tag: tags.comment, color: "var(--faint)", fontStyle: "italic" },
  { tag: [tags.number, tags.bool, tags.null], color: "var(--ink)" },
  { tag: [tags.operator, tags.punctuation], color: "var(--dim)" },
  { tag: tags.typeName, color: "var(--dim)" },
]);

export function SqlEditor({
  value,
  catalog,
  autoFocus,
  onChange,
  onRun,
  onRunAndAdd,
}: {
  value: string;
  catalog?: DatabaseCatalog;
  autoFocus?: boolean;
  onChange(value: string): void;
  onRun(): void;
  onRunAndAdd(): void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView>();
  const callbacks = useRef({ onChange, onRun, onRunAndAdd });
  callbacks.current = { onChange, onRun, onRunAndAdd };

  useEffect(() => {
    if (!host.current) return;
    const schema = Object.fromEntries((catalog?.tables ?? []).map((table) => [
      table.name,
      table.columns.map((column) => column.name),
    ]));
    const instance = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          history(),
          drawSelection(),
          bracketMatching(),
          closeBrackets(),
          autocompletion({ activateOnTyping: true }),
          sql({ schema, upperCaseKeywords: true }),
          syntaxHighlighting(highlight),
          EditorView.lineWrapping,
          EditorView.updateListener.of((update) => {
            if (update.docChanged) callbacks.current.onChange(update.state.doc.toString());
          }),
          keymap.of([
            { key: "Mod-Enter", run: () => { callbacks.current.onRun(); return true; } },
            { key: "Mod-Shift-Enter", run: () => { callbacks.current.onRunAndAdd(); return true; } },
            ...closeBracketsKeymap,
            ...completionKeymap,
            ...historyKeymap,
            ...defaultKeymap,
          ]),
          EditorView.theme({
            "&": { backgroundColor: "transparent", fontSize: "12.5px" },
            ".cm-content": { padding: "10px 14px", minHeight: "42px", fontFamily: "var(--mono)", lineHeight: "1.65" },
            ".cm-focused": { outline: "none" },
            ".cm-tooltip": { backgroundColor: "var(--paper)", border: "1px solid var(--hair)", color: "var(--dim)", fontFamily: "var(--mono)" },
            ".cm-tooltip-autocomplete ul li[aria-selected]": { backgroundColor: "var(--accent-soft)", color: "var(--ink)" },
          }),
        ],
      }),
    });
    view.current = instance;
    return () => instance.destroy();
  }, [catalog]);

  useEffect(() => {
    if (autoFocus) view.current?.focus();
  }, []);

  useEffect(() => {
    const instance = view.current;
    if (!instance || instance.state.doc.toString() === value) return;
    instance.dispatch({ changes: { from: 0, to: instance.state.doc.length, insert: value } });
  }, [value]);

  return <div className="sql-editor" ref={host} />;
}
