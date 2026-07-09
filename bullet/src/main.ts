import "./style.css";
import { initTheme } from "./colorscheme";
import { initFont } from "./fonts";
import { createEditor } from "./editor";
import { createSidebar } from "./sidebar";
import { setupSidebarResize } from "./resize";
import { setupCommands } from "./commands";
import { setImageVault } from "./images";
import { load as loadScratch, save as saveScratch } from "./storage";
import { readFile, splitPath, writeFile } from "./vault";
import { initSearch, query, rescan, updateFile } from "./search";
import { showSearchResults } from "./searchui";
import { ask } from "./ask";

initTheme();
initFont();

const statusLeft = document.getElementById("status-left")!;

let currentPath: string | null = null; // vault-relative; null = scratch
let notifyTimer: number | undefined;

function showPath(): void {
  statusLeft.textContent = currentPath ?? "scratch";
}

function notify(message: string): void {
  statusLeft.textContent = message;
  clearTimeout(notifyTimer);
  notifyTimer = window.setTimeout(showPath, 3000);
}

// ---- Save routing: edits go to the open vault file, or to the
// localStorage scratch buffer when no vault file is open. ----

let currentFile: FileSystemFileHandle | null = null;
let pendingText: string | null = null;
let writeTimer: number | undefined;

function scheduleSave(text: string): void {
  pendingText = text;
  clearTimeout(writeTimer);
  writeTimer = window.setTimeout(() => void flushSave(), 500);
}

async function flushSave(): Promise<void> {
  clearTimeout(writeTimer);
  if (pendingText === null) return;
  const text = pendingText;
  const target = currentFile;
  pendingText = null;
  if (!target) {
    saveScratch(text);
    return;
  }
  try {
    await writeFile(target, text);
    if (currentPath) updateFile(currentPath, text);
  } catch (err) {
    console.error(err);
    notify("SAVE FAILED");
  }
}

const editor = createEditor(document.getElementById("editor")!, scheduleSave);

function openScratch(): void {
  currentFile = null;
  currentPath = null;
  editor.setDoc(loadScratch());
  showPath();
}

const sidebar = createSidebar(document.getElementById("sidebar")!, {
  async onOpenFile(node) {
    await flushSave(); // don't lose edits to the previous file
    if (node === null) {
      openScratch();
      return;
    }
    const handle = node.handle as FileSystemFileHandle;
    try {
      const text = await readFile(handle);
      currentFile = handle;
      currentPath = node.path;
      editor.setDoc(text);
      showPath();
    } catch (err) {
      console.error(err);
      notify(`OPEN FAILED: ${node.path}`);
    }
  },
  onVaultOpen(root) {
    void initSearch(root, notify);
  },
});

setImageVault(() => sidebar.vault());
const toggleSidebar = setupSidebarResize(() => editor.view.focus());

setupCommands({
  vault: () => sidebar.vault(),
  currentPath: () => currentPath,
  baseDir: () =>
    sidebar.selectedFolder() ??
    (currentPath ? splitPath(currentPath).dir : ""),
  openPath: (path) => sidebar.openPath(path),
  openScratch,
  refresh: async () => {
    await sidebar.refresh();
    void rescan(); // pick up files the command just created/moved/deleted
  },
  openVaultPicker: () => sidebar.openVaultPicker(),
  focusEditor: () => editor.view.focus(),
  flushSave,
  notify,
  toggleSidebar,
  async runSearch(q: string): Promise<number> {
    const all = await query(q); // throws "still indexing…" etc. for the bar
    // fold multiple matching sections of one file into its best hit
    const byFile = new Map<string, (typeof all)[number]>();
    for (const hit of all) {
      if (!byFile.has(hit.path)) byFile.set(hit.path, hit);
    }
    const hits = [...byFile.values()];
    if (hits.length > 0) {
      showSearchResults(hits, (hit) => {
        void sidebar.openPath(hit.path).then(() => {
          editor.revealLine(hit.line);
        });
      });
    }
    return hits.length;
  },
  runAsk: (question: string) =>
    ask(question, {
      notify,
      openAt(path, line) {
        void sidebar.openPath(path).then(() => editor.revealLine(line));
      },
    }),
});

// Default buffer until a file is opened.
openScratch();

// Never lose words: persist on tab switch, blur, and close.
window.addEventListener("beforeunload", () => void flushSave());
window.addEventListener("blur", () => void flushSave());
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") void flushSave();
});
