// Left's font trio (mono / serif / sans — Input Mono, Zilla Slab,
// Inter), cycled by the `font` command. The choice lands as a
// data-font attribute; style.css maps it to a font stack via
// --app-font, which everything inherits.

export const FONTS = ["mono", "serif", "sans"] as const;
export type FontMode = (typeof FONTS)[number];

const KEY = "bullet.font";

export function currentFont(): FontMode {
  const saved = localStorage.getItem(KEY);
  return (FONTS as readonly string[]).includes(saved ?? "")
    ? (saved as FontMode)
    : "mono";
}

export function applyFont(mode: FontMode): void {
  if (mode === "mono") {
    delete document.documentElement.dataset.font;
    localStorage.removeItem(KEY);
  } else {
    document.documentElement.dataset.font = mode;
    localStorage.setItem(KEY, mode);
  }
}

export function initFont(): void {
  applyFont(currentFont());
}
