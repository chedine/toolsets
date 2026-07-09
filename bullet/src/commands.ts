import {
  deleteByPath,
  ensureFile,
  ensureFolder,
  moveByPath,
  renameByPath,
} from "./vault";
import { applyTheme, effectiveTheme, THEMES } from "./colorscheme";
import { applyFont, currentFont, FONTS, type FontMode } from "./fonts";

// A single command line instead of menus: Cmd+K turns the status bar
// into a prompt. Commands are word-prefixed ("new file notes/todo"),
// suggestions appear as you type, Tab completes, Enter runs,
// destructive commands ask for one more Enter.

export interface CommandContext {
  vault(): FileSystemDirectoryHandle | null;
  currentPath(): string | null; // null = scratch buffer
  // folder that relative paths resolve against: the selected folder in
  // the tree, else the open file's folder, else the vault root ("")
  baseDir(): string;
  openPath(path: string): Promise<void>;
  openScratch(): void;
  refresh(): Promise<void>;
  openVaultPicker(): Promise<void>;
  focusEditor(): void;
  flushSave(): Promise<void>;
  notify(message: string): void;
  toggleSidebar(): void;
  // runs the query and shows the results popup; throws with a
  // human-readable message if the index isn't ready
  runSearch(query: string): Promise<number>;
  runAsk(question: string): Promise<void>;
}

interface Confirm {
  prompt: string;
  action(): Promise<string>;
}

interface Command {
  name: string;
  usage: string;
  run(args: string, ctx: CommandContext): Promise<string | Confirm>;
}

function needVault(ctx: CommandContext): FileSystemDirectoryHandle {
  const v = ctx.vault();
  if (!v) throw new Error("no vault open — run: vault");
  return v;
}

function needCurrent(ctx: CommandContext): string {
  const p = ctx.currentPath();
  if (p === null) throw new Error("no file open");
  return p;
}

// Relative paths resolve against the current selection; a leading "/"
// pins the path to the vault root.
function resolve(ctx: CommandContext, path: string): string {
  if (path.startsWith("/")) return path.replace(/^\/+/, "");
  const base = ctx.baseDir();
  return base && path ? `${base}/${path}` : base || path;
}

const COMMANDS: Command[] = [
  {
    name: "new file",
    usage: "new file <path>  (relative to selection; /path for vault root)",
    async run(args, ctx) {
      if (!args) throw new Error("usage: new file <path>");
      const path = await ensureFile(needVault(ctx), resolve(ctx, args));
      await ctx.refresh();
      await ctx.openPath(path);
      return `created ${path}`;
    },
  },
  {
    name: "new folder",
    usage: "new folder <path>  (relative to selection; /path for vault root)",
    async run(args, ctx) {
      if (!args) throw new Error("usage: new folder <path>");
      const path = resolve(ctx, args);
      await ensureFolder(needVault(ctx), path);
      await ctx.refresh();
      return `created ${path}/`;
    },
  },
  {
    name: "open",
    usage: "open <path>",
    async run(args, ctx) {
      if (!args) throw new Error("usage: open <path>");
      const path = resolve(ctx, args);
      await ctx.openPath(path);
      return `opened ${path}`;
    },
  },
  {
    name: "rename",
    usage: "rename <new name>  (current file)",
    async run(args, ctx) {
      if (!args) throw new Error("usage: rename <new name>");
      const vault = needVault(ctx);
      const path = needCurrent(ctx);
      await ctx.flushSave();
      const newPath = await renameByPath(vault, path, args);
      await ctx.refresh();
      await ctx.openPath(newPath);
      return `renamed to ${newPath}`;
    },
  },
  {
    name: "move",
    usage: "move <dest folder>  (current file)",
    async run(args, ctx) {
      const vault = needVault(ctx);
      const path = needCurrent(ctx);
      await ctx.flushSave();
      const newPath = await moveByPath(
        vault,
        path,
        args.trim() ? resolve(ctx, args.trim()) : "",
      );
      await ctx.refresh();
      await ctx.openPath(newPath);
      return `moved to ${newPath}`;
    },
  },
  {
    name: "delete",
    usage: "delete [path]  (default: current file)",
    async run(args, ctx) {
      const vault = needVault(ctx);
      const target = args ? resolve(ctx, args) : needCurrent(ctx);
      return {
        prompt: `delete ${target}? Enter to confirm`,
        action: async () => {
          const wasCurrent =
            ctx.currentPath() !== null &&
            (ctx.currentPath() === target ||
              ctx.currentPath()!.startsWith(target + "/"));
          await deleteByPath(vault, target);
          if (wasCurrent) ctx.openScratch();
          await ctx.refresh();
          return `deleted ${target}`;
        },
      };
    },
  },
  {
    name: "vault",
    usage: "vault  (open a different vault folder)",
    async run(_args, ctx) {
      await ctx.flushSave();
      await ctx.openVaultPicker();
      return "";
    },
  },
  {
    name: "search",
    usage: "search <query>  (ranked results; Enter opens at the match)",
    async run(args, ctx) {
      if (!args) throw new Error("usage: search <query>");
      const count = await ctx.runSearch(args);
      return count === 0 ? "no results" : "";
    },
  },
  {
    name: "ask",
    usage: "ask <question>  (local model answers from your notes)",
    async run(args, ctx) {
      if (!args) throw new Error("usage: ask <question>");
      void ctx.runAsk(args).catch((err) => ctx.notify((err as Error).message));
      return ""; // popup streams; the bar is free immediately
    },
  },
  {
    name: "sidebar",
    usage: "sidebar  (show/hide the sidebar, also Cmd+\\)",
    async run(_args, ctx) {
      ctx.toggleSidebar();
      return "";
    },
  },
  {
    name: "theme",
    usage: "theme [dark|light|paper|auto]  (no arg: cycle)",
    async run(args) {
      if (args === "auto" || (THEMES as readonly string[]).includes(args)) {
        applyTheme(args as Parameters<typeof applyTheme>[0]);
        return `theme: ${args}`;
      }
      if (args) throw new Error("usage: theme [dark|light|paper|auto]");
      const next =
        THEMES[(THEMES.indexOf(effectiveTheme()) + 1) % THEMES.length];
      applyTheme(next);
      return `theme: ${next}`;
    },
  },
  {
    name: "font",
    usage: "font [mono|serif|sans]  (no arg: cycle, like Left)",
    async run(args) {
      if ((FONTS as readonly string[]).includes(args)) {
        applyFont(args as FontMode);
        return `font: ${args}`;
      }
      if (args) throw new Error("usage: font [mono|serif|sans]");
      const next = FONTS[(FONTS.indexOf(currentFont()) + 1) % FONTS.length];
      applyFont(next);
      return `font: ${next}`;
    },
  },
  {
    name: "help",
    usage: "help  (list all commands)",
    async run() {
      showHelp();
      return "";
    },
  },
];

function showHelp(): void {
  document.getElementById("help-popup")?.remove();
  const popup = document.createElement("div");
  popup.id = "help-popup";
  for (const c of COMMANDS) {
    const row = document.createElement("div");
    row.className = "help-row";
    const name = document.createElement("span");
    name.className = "help-name";
    name.textContent = c.name;
    const usage = document.createElement("span");
    usage.className = "help-usage";
    usage.textContent = c.usage.slice(c.name.length).trim();
    row.append(name, usage);
    popup.appendChild(row);
  }
  const dismiss = () => {
    popup.remove();
    window.removeEventListener("keydown", onKey, true);
  };
  const onKey = (e: KeyboardEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dismiss();
  };
  popup.addEventListener("click", dismiss);
  window.addEventListener("keydown", onKey, true);
  document.body.appendChild(popup);
}

function match(input: string): { command: Command; args: string } | null {
  let best: Command | null = null;
  for (const c of COMMANDS) {
    if (input === c.name || input.startsWith(c.name + " ")) {
      if (!best || c.name.length > best.name.length) best = c;
    }
  }
  return best ? { command: best, args: input.slice(best.name.length).trim() } : null;
}

const suggest = (input: string): Command[] =>
  COMMANDS.filter((c) => c.name.startsWith(input) || input.startsWith(c.name));

export function setupCommands(ctx: CommandContext): void {
  const input = document.getElementById("command-input") as HTMLInputElement;
  const hint = document.getElementById("command-hint")!;
  let pending: Confirm | null = null;

  const close = () => {
    document.body.classList.remove("command-mode");
    input.value = "";
    hint.textContent = "";
    pending = null;
    ctx.focusEditor();
  };

  const open = () => {
    document.body.classList.add("command-mode");
    showSuggestions();
    input.focus();
  };

  function showSuggestions(): void {
    if (pending) {
      hint.textContent = pending.prompt;
      return;
    }
    const s = suggest(input.value.trim());
    hint.textContent =
      s.length === 1 && input.value.trim().length >= s[0].name.length
        ? s[0].usage
        : s.map((c) => c.name).join(" · ");
  }

  window.addEventListener("keydown", (e) => {
    if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (document.body.classList.contains("command-mode")) close();
      else open();
    }
  });

  input.addEventListener("input", () => {
    pending = null;
    showSuggestions();
  });

  input.addEventListener("keydown", async (e) => {
    if (e.key === "Escape") {
      close();
      return;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      const s = suggest(input.value.trim());
      if (s.length > 0) {
        input.value = s[0].name + " ";
        showSuggestions();
      }
      return;
    }
    if (e.key !== "Enter") return;
    e.preventDefault();

    if (pending) {
      const action = pending.action;
      pending = null;
      try {
        const msg = await action();
        close();
        if (msg) ctx.notify(msg);
      } catch (err) {
        close();
        ctx.notify(`failed: ${(err as Error).message}`);
      }
      return;
    }

    const hit = match(input.value.trim());
    if (!hit) {
      hint.textContent = "unknown command";
      return;
    }
    try {
      const result = await hit.command.run(hit.args, ctx);
      if (typeof result === "object") {
        pending = result;
        showSuggestions();
      } else {
        close();
        if (result) ctx.notify(result);
      }
    } catch (err) {
      hint.textContent = (err as Error).message;
    }
  });
}
