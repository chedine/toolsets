import { EditorView } from "@codemirror/view";

// All colors come from the CSS variables in style.css, so the editor
// follows the light/dark mood of the page with a single palette source.
export const theme = EditorView.theme({
  "&": {
    backgroundColor: "var(--bg)",
    color: "var(--fg)",
    fontSize: "15px",
  },

  ".cm-scroller": {
    fontFamily: "inherit",
    lineHeight: "1.8",
    padding: "2.5rem 3rem 0",
  },

  ".cm-content": {
    caretColor: "var(--fg)",
    padding: "0",
  },

  ".cm-line": {
    padding: "0",
  },

  "&.cm-focused .cm-cursor": {
    borderLeftColor: "var(--fg)",
    borderLeftWidth: "2px",
  },

  // Match the base theme's own selector exactly, or its lavender default
  // wins on specificity and breaks the monochrome palette.
  ".cm-selectionLayer .cm-selectionBackground, &.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground":
    {
      backgroundColor: "var(--faint)",
    },

  ".cm-placeholder": {
    color: "var(--dim)",
  },

  // Rendered control characters (from highlightSpecialChars) stay quiet.
  ".cm-specialChar": {
    color: "var(--dim)",
  },
});
