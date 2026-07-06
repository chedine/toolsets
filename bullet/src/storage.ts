// The scratch buffer: where writing lands when no vault file is open.
const KEY = "bullet.doc";

export function load(): string {
  try {
    return localStorage.getItem(KEY) ?? "";
  } catch {
    return "";
  }
}

export function save(text: string): void {
  try {
    localStorage.setItem(KEY, text);
  } catch {
    // Storage full or unavailable — writing must never be interrupted.
  }
}
