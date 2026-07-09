import {
  buildTree,
  pickVault,
  restoreVault,
  storedVaultName,
  supported,
  type TreeNode,
} from "./vault";

export interface SidebarCallbacks {
  // node === null means the localStorage scratch buffer.
  onOpenFile(node: TreeNode | null): void | Promise<void>;
  // fired once whenever a (different) vault becomes available
  onVaultOpen?(root: FileSystemDirectoryHandle): void;
  // drag-and-drop reorganize: move path into destFolder ("" = root)
  onMove?(path: string, destFolder: string): Promise<void>;
}

export interface SidebarApi {
  refresh(): Promise<void>;
  vault(): FileSystemDirectoryHandle | null;
  openPath(path: string): Promise<void>;
  openVaultPicker(): Promise<void>;
  // vault-relative path of the folder selected in the tree, or null
  selectedFolder(): string | null;
}

const EXPANDED_KEY = "bullet.expanded";

function loadExpanded(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(EXPANDED_KEY) ?? "[]"));
  } catch {
    return new Set();
  }
}

export function createSidebar(
  parent: HTMLElement,
  callbacks: SidebarCallbacks,
): SidebarApi {
  let vault: FileSystemDirectoryHandle | null = null;
  let tree: TreeNode[] = [];
  const expanded = loadExpanded();
  let activePath: string | null = null; // null = scratch
  // target folder for relative command paths
  let selectedDir: TreeNode | null = null;
  let storedName: string | null = null;

  const saveExpanded = () =>
    localStorage.setItem(EXPANDED_KEY, JSON.stringify([...expanded]));

  const findDir = (path: string, nodes: TreeNode[]): TreeNode | null => {
    for (const n of nodes) {
      if (n.kind !== "dir") continue;
      if (n.path === path) return n;
      const hit = findDir(path, n.children ?? []);
      if (hit) return hit;
    }
    return null;
  };

  let notifiedVault: FileSystemDirectoryHandle | null = null;

  async function refresh(): Promise<void> {
    if (vault) {
      tree = await buildTree(vault);
      // re-point selectedDir at the fresh tree
      selectedDir = selectedDir ? findDir(selectedDir.path, tree) : null;
    }
    render();
    if (vault && vault !== notifiedVault) {
      notifiedVault = vault;
      callbacks.onVaultOpen?.(vault);
    }
  }

  async function openVault(): Promise<void> {
    try {
      vault = await pickVault();
    } catch {
      return; // user cancelled the picker
    }
    await refresh();
  }

  function entryButton(label: string, indent: number): HTMLButtonElement {
    const b = document.createElement("button");
    b.className = "entry";
    b.textContent = label;
    b.style.paddingLeft = `${1.5 + indent * 0.9}rem`;
    return b;
  }

  const findFile = (path: string, nodes: TreeNode[]): TreeNode | null => {
    for (const n of nodes) {
      if (n.path === path && n.kind === "file") return n;
      const hit = n.children ? findFile(path, n.children) : null;
      if (hit) return hit;
    }
    return null;
  };

  async function selectFile(node: TreeNode): Promise<void> {
    activePath = node.path;
    await callbacks.onOpenFile(node); // openPath callers rely on the doc being loaded
    render();
  }

  // ---- Drag-and-drop reorganize. Entries carry their vault path in a
  // custom data type so stray drags (text, files from the OS) are
  // ignored. Folders and the sidebar background (= vault root) accept
  // drops. ----
  const DRAG_TYPE = "application/x-bullet-path";

  function makeDraggable(el: HTMLElement, node: TreeNode): void {
    el.draggable = true;
    el.addEventListener("dragstart", (e) => {
      e.dataTransfer!.setData(DRAG_TYPE, node.path);
      e.dataTransfer!.effectAllowed = "move";
    });
  }

  // Moving a folder into itself/its descendants would eat it; into its
  // own parent is a no-op.
  function validDrop(src: string, destFolder: string): boolean {
    if (!src) return false;
    if (destFolder === src || destFolder.startsWith(src + "/")) return false;
    const dir = src.includes("/") ? src.slice(0, src.lastIndexOf("/")) : "";
    return dir !== destFolder;
  }

  function makeDropTarget(el: HTMLElement, destFolder: string): void {
    el.addEventListener("dragover", (e) => {
      if (!e.dataTransfer?.types.includes(DRAG_TYPE)) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = "move";
      el.classList.add("drop-target");
    });
    el.addEventListener("dragleave", () => el.classList.remove("drop-target"));
    el.addEventListener("drop", (e) => {
      el.classList.remove("drop-target");
      const src = e.dataTransfer?.getData(DRAG_TYPE) ?? "";
      if (!e.dataTransfer?.types.includes(DRAG_TYPE)) return;
      e.preventDefault();
      e.stopPropagation();
      if (validDrop(src, destFolder)) void callbacks.onMove?.(src, destFolder);
    });
  }

  function renderNodes(container: HTMLElement, nodes: TreeNode[], depth: number): void {
    for (const node of nodes) {
      const b = entryButton("", depth);
      makeDraggable(b, node);
      if (node.kind === "dir") {
        const open = expanded.has(node.path);
        b.textContent = `${open ? "▾" : "▸"} ${node.name}`;
        b.classList.add("folder");
        makeDropTarget(b, node.path);
        if (selectedDir?.path === node.path) b.classList.add("selected");
        b.addEventListener("click", () => {
          if (expanded.has(node.path)) expanded.delete(node.path);
          else expanded.add(node.path);
          saveExpanded();
          selectedDir = node;
          render();
        });
        container.appendChild(b);
        if (open) renderNodes(container, node.children ?? [], depth + 1);
      } else {
        b.textContent = node.name;
        // dropping on a file means "into this file's folder"
        const dir = node.path.includes("/")
          ? node.path.slice(0, node.path.lastIndexOf("/"))
          : "";
        makeDropTarget(b, dir);
        if (node.path === activePath) b.classList.add("active");
        b.addEventListener("click", () => {
          selectedDir = null; // relative paths follow the file's folder now
          void selectFile(node);
        });
        container.appendChild(b);
      }
    }
  }

  function render(): void {
    parent.replaceChildren();

    if (!vault) {
      const scratch = entryButton("scratch", 0);
      if (activePath === null) scratch.classList.add("active");
      scratch.addEventListener("click", () => {
        activePath = null;
        callbacks.onOpenFile(null);
        render();
      });
      parent.appendChild(scratch);

      if (supported) {
        if (storedName) {
          const reopen = entryButton(`reopen ${storedName}…`, 0);
          reopen.classList.add("action");
          reopen.addEventListener("click", async () => {
            vault = await restoreVault(true);
            if (vault) await refresh();
          });
          parent.appendChild(reopen);
        }
        const open = entryButton("open vault…", 0);
        open.classList.add("action");
        open.addEventListener("click", openVault);
        parent.appendChild(open);
      }
      return;
    }

    renderNodes(parent, tree, 0);
  }

  makeDropTarget(parent, ""); // sidebar background = vault root
  render();

  // If a vault was opened in a past session and permission survived,
  // restore it without any prompt.
  if (supported) {
    void restoreVault(false).then(async (handle) => {
      if (handle) {
        vault = handle;
        await refresh();
      } else {
        storedName = await storedVaultName();
        if (storedName) render();
      }
    });
  }

  return {
    refresh,
    vault: () => vault,
    openVaultPicker: openVault,
    selectedFolder: () => selectedDir?.path ?? null,
    async openPath(path: string) {
      // expand every ancestor so the file is visible in the tree
      const parts = path.split("/");
      for (let i = 1; i < parts.length; i++) {
        expanded.add(parts.slice(0, i).join("/"));
      }
      saveExpanded();
      const node = findFile(path, tree);
      if (!node) throw new Error(`not found: ${path}`);
      await selectFile(node);
    },
  };
}
