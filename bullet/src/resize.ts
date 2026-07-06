const KEY = "bullet.sidebar";
const MIN = 120;
const MAX = 420;

interface SidebarState {
  width: number;
  hidden: boolean;
}

function loadState(): SidebarState {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    /* fall through to default */
  }
  return { width: 200, hidden: false };
}

// Returns a function that toggles the sidebar (also on Cmd+\ and
// divider double-click).
export function setupSidebarResize(onToggle: () => void): () => void {
  const divider = document.getElementById("divider")!;
  const state = loadState();

  const apply = () => {
    document.documentElement.style.setProperty(
      "--sidebar-width",
      `${state.width}px`,
    );
    document.body.classList.toggle("sidebar-hidden", state.hidden);
    localStorage.setItem(KEY, JSON.stringify(state));
  };
  apply();

  const toggle = () => {
    state.hidden = !state.hidden;
    apply();
    onToggle();
  };

  divider.addEventListener("pointerdown", (down) => {
    if (state.hidden) return;
    down.preventDefault();
    divider.setPointerCapture(down.pointerId);
    const startX = down.clientX;
    const startWidth = state.width;
    let moved = false;

    const onMove = (move: PointerEvent) => {
      const dx = move.clientX - startX;
      if (Math.abs(dx) > 2) moved = true;
      state.width = Math.min(MAX, Math.max(MIN, startWidth + dx));
      document.body.classList.add("resizing");
      apply();
    };
    const onUp = () => {
      document.body.classList.remove("resizing");
      divider.removeEventListener("pointermove", onMove);
      divider.removeEventListener("pointerup", onUp);
      if (moved) apply();
    };
    divider.addEventListener("pointermove", onMove);
    divider.addEventListener("pointerup", onUp);
  });

  divider.addEventListener("dblclick", toggle);

  window.addEventListener("keydown", (e) => {
    if (e.key === "\\" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      toggle();
    }
  });

  return toggle;
}
