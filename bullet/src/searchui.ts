import type { SearchHit } from "./search";

// Results popup in the same idiom as the help popup: monochrome,
// keyboard-first. Arrows move, Enter opens, Esc dismisses.

function snippet(hit: SearchHit): DocumentFragment {
  const frag = document.createDocumentFragment();
  const text = hit.text.replace(/\s+/g, " ").trim();
  const lower = text.toLowerCase();

  // center the snippet window on the first matched term
  let at = -1;
  for (const term of hit.terms) {
    const i = lower.indexOf(term.toLowerCase());
    if (i !== -1 && (at === -1 || i < at)) at = i;
  }
  const start = Math.max(0, (at === -1 ? 0 : at) - 40);
  const window = text.slice(start, start + 160);

  // bold every matched term inside the window
  const pattern = hit.terms
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  if (!pattern) {
    frag.append((start > 0 ? "…" : "") + window);
    return frag;
  }
  const re = new RegExp(`(${pattern})`, "gi");
  if (start > 0) frag.append("…");
  let last = 0;
  for (const m of window.matchAll(re)) {
    frag.append(window.slice(last, m.index));
    const b = document.createElement("b");
    b.textContent = m[0];
    frag.append(b);
    last = m.index + m[0].length;
  }
  frag.append(window.slice(last));
  if (start + 160 < text.length) frag.append("…");
  return frag;
}

export function showSearchResults(
  hits: SearchHit[],
  onPick: (hit: SearchHit) => void,
): void {
  document.getElementById("search-popup")?.remove();
  const popup = document.createElement("div");
  popup.id = "search-popup";
  let selected = 0;

  const rows = hits.map((hit, i) => {
    const row = document.createElement("div");
    row.className = "result-row";
    const head = document.createElement("div");
    head.className = "result-head";
    const title = document.createElement("span");
    title.className = "result-title";
    title.textContent = hit.section || hit.path.split("/").pop() || hit.path;
    const path = document.createElement("span");
    path.className = "result-path";
    path.textContent = hit.path;
    head.append(title, path);
    const body = document.createElement("div");
    body.className = "result-snippet";
    body.appendChild(snippet(hit));
    row.append(head, body);
    row.addEventListener("click", () => pick(i));
    row.addEventListener("mousemove", () => select(i));
    popup.appendChild(row);
    return row;
  });

  function select(i: number): void {
    rows[selected]?.classList.remove("selected");
    selected = i;
    rows[selected]?.classList.add("selected");
    rows[selected]?.scrollIntoView({ block: "nearest" });
  }

  function pick(i: number): void {
    dismiss();
    onPick(hits[i]);
  }

  const dismiss = () => {
    popup.remove();
    window.removeEventListener("keydown", onKey, true);
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown" || (e.key === "n" && e.ctrlKey)) {
      e.preventDefault();
      e.stopPropagation();
      select(Math.min(selected + 1, hits.length - 1));
    } else if (e.key === "ArrowUp" || (e.key === "p" && e.ctrlKey)) {
      e.preventDefault();
      e.stopPropagation();
      select(Math.max(selected - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      pick(selected);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      dismiss();
    }
  };

  window.addEventListener("keydown", onKey, true);
  document.body.appendChild(popup);
  select(0);
}
