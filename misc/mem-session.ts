import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  let memFile: string | undefined;

  // --- State reconstruction ---

  pi.on("session_start", async (_event, ctx) => {
    memFile = undefined;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === "mem-session") {
        memFile = (entry as any).data?.memFile;
      }
    }
    if (memFile) {
      ctx.ui.setStatus("mem", `📝 ${memFile}`);
    }
  });

  // --- Gentle reminder on exit ---

  pi.on("session_shutdown", async (_event, ctx) => {
    const hasConversation = ctx.sessionManager.getBranch().some(
      (e) => e.type === "message" && e.message.role === "assistant"
    );
    if (!memFile && hasConversation) {
      ctx.ui.notify("Tip: use /mem to log this session before exiting", "info");
    }
  });

  // --- /mem command ---

  pi.registerCommand("mem", {
    description: "Log or append to session note via mem",
    handler: async (args, ctx) => {
      if (memFile) {
        await appendNote(args?.trim() || "", ctx);
      } else {
        await createNote(ctx);
      }
    },
  });

  // --- Helpers ---

  function parseNote(text: string): { title: string; summary: string; tags: string } | null {
    const sections: Record<string, string[]> = {};
    let current: string | null = null;

    for (const line of text.split("\n")) {
      const header = line.match(/^## (title|summary|tags)\s*$/i);
      if (header) {
        current = header[1].toLowerCase();
        sections[current] = [];
      } else if (current) {
        sections[current].push(line);
      }
    }

    const title = sections["title"]?.join("\n").trim() || "";
    const summary = sections["summary"]?.join("\n").trim() || "";
    const tags = sections["tags"]?.join("\n").trim() || "session";

    if (!title) return null;
    return { title, summary, tags };
  }

  // --- Create note (first /mem in session) ---

  async function createNote(ctx: ExtensionContext) {
    const model = ctx.model?.name || ctx.model?.id || "unknown";
    const template = `## Title\n\n## Summary\n- \n- CWD: ${ctx.cwd}, MODEL: ${model}\n\n## Tags\nsession`;
    const edited = await ctx.ui.editor("Session note:", template);
    if (!edited?.trim()) return;

    const parsed = parseNote(edited);
    if (!parsed) {
      ctx.ui.notify("Title required", "error");
      return;
    }

    const args = ["new", "--title", parsed.title, "--tags", parsed.tags, "--", parsed.summary || parsed.title];
    const result = await pi.exec("mem", args);

    if (result.code === 0) {
      const match = result.stdout.match(/(\d{8}-\d{6})/);
      memFile = match?.[1];
      pi.appendEntry("mem-session", { memFile });
      pi.setSessionName(parsed.title);
      ctx.ui.setStatus("mem", `📝 ${memFile}`);
      ctx.ui.notify(`Created: ${memFile}`, "success");
    } else {
      ctx.ui.notify(`mem failed: ${result.stderr}`, "error");
    }
  }

  // --- Append note (subsequent /mem calls) ---

  async function appendNote(inlineText: string, ctx: ExtensionContext) {
    const text =
      inlineText || (await ctx.ui.editor("Append to session note:", ""));
    if (!text?.trim()) return;

    const result = await pi.exec("mem", ["append", "--", memFile!, text.trim()]);
    if (result.code === 0) {
      ctx.ui.notify(`Appended to ${memFile}`, "success");
    } else {
      ctx.ui.notify(`mem failed: ${result.stderr}`, "error");
    }
  }
}
