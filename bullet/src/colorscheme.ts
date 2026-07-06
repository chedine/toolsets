// Manual theme override. "auto" follows the OS via the CSS media
// query; the named themes pin a palette with a data-theme attribute.

export type ThemeMode = "auto" | "dark" | "light" | "paper";

export const THEMES = ["dark", "light", "paper"] as const;
type Theme = (typeof THEMES)[number];

const KEY = "bullet.theme";

export function currentTheme(): ThemeMode {
  const saved = localStorage.getItem(KEY);
  return (THEMES as readonly string[]).includes(saved ?? "")
    ? (saved as Theme)
    : "auto";
}

// What the user actually sees right now (resolving "auto").
export function effectiveTheme(): Theme {
  const mode = currentTheme();
  if (mode !== "auto") return mode;
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function applyTheme(mode: ThemeMode): void {
  if (mode === "auto") {
    delete document.documentElement.dataset.theme;
    document.documentElement.style.colorScheme = "";
    localStorage.removeItem(KEY);
  } else {
    document.documentElement.dataset.theme = mode;
    // keep native bits (scrollbars, form controls) in the same mood
    document.documentElement.style.colorScheme =
      mode === "dark" ? "dark" : "light";
    localStorage.setItem(KEY, mode);
  }
}

export function initTheme(): void {
  applyTheme(currentTheme());
}
