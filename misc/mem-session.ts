import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import * as path from "node:path";

export default function (pi: ExtensionAPI) {
  let memFile: string | undefined;

  // --- Helpers ---

  function reconstructMemFile(ctx: ExtensionContext) {
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === "mem-session") {
        memFile = (entry as any).data?.memFile;
      }
    }
  }

  function timestamp(): string {
    const d = new Date();
    return d.toLocaleString("en-IN", {
      year: "numeric", month: "short", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false,
    });
  }

  function sessionInfo(ctx: ExtensionContext): string {
    const model = ctx.model?.name || ctx.model?.id || "unknown";
    return `${ctx.cwd} using ${model}`;
  }

  function logLine(action: string, ctx: ExtensionContext): string {
    return `${timestamp()} : ${action} from ${sessionInfo(ctx)}`;
  }

  async function createNote(ctx: ExtensionContext, action: string) {
    const title = `${path.basename(ctx.cwd)}-session`;
    const content = logLine(action, ctx);

    const result = await pi.exec("mem", [
      "new", "--title", title, "--tags", "session", "--", content,
    ]);

    if (result.code === 0) {
      const match = result.stdout.match(/(\d{8}-\d{6})/);
      memFile = match?.[1];
      if (memFile) {
        pi.appendEntry("mem-session", { memFile });
        pi.setSessionName(title);
        ctx.ui.setStatus("mem", `📝 ${memFile}`);
      }
    }
  }

  async function appendLog(ctx: ExtensionContext, action: string) {
    if (!memFile) return;
    const content = logLine(action, ctx);
    await pi.exec("mem", ["append", "--", memFile, content]);
  }

  // --- Auto-log lifecycle events ---

  pi.on("session_start", async (_event, ctx) => {
    memFile = undefined;
    reconstructMemFile(ctx);

    const hasMessages = ctx.sessionManager.getBranch().some(
      (e) => e.type === "message"
    );

    if (!memFile && !hasMessages) {
      await createNote(ctx, "New session");
    }

    if (memFile) {
      ctx.ui.setStatus("mem", `📝 ${memFile}`);
    }
  });

  pi.on("session_switch", async (event, ctx) => {
    memFile = undefined;
    reconstructMemFile(ctx);

    if (event.reason === "new") {
      await createNote(ctx, "New session");
    } else if (event.reason === "resume") {
      if (memFile) {
        await appendLog(ctx, "Resumed");
      } else {
        await createNote(ctx, "Resumed session");
      }
    }
  });

  pi.on("session_fork", async (_event, ctx) => {
    if (memFile) {
      await appendLog(ctx, "Forked");
    } else {
      await createNote(ctx, "Forked session");
    }
  });

  pi.on("model_select", async (event, ctx) => {
    if (!memFile || !event.previousModel) return;
    const prev = event.previousModel.name || event.previousModel.id;
    const next = event.model.name || event.model.id;
    await pi.exec("mem", [
      "append", "--", memFile,
      `${timestamp()} : Model changed from ${prev} to ${next}`,
    ]);
  });

  // --- Manual /mem command (always appends) ---

  pi.registerCommand("mem", {
    description: "Append a manual note to session log",
    handler: async (args, ctx) => {
      if (!memFile) {
        await createNote(ctx, "New session");
      }

      const text =
        args?.trim() || (await ctx.ui.editor("Append to session note:", ""));
      if (!text?.trim()) return;

      const result = await pi.exec("mem", ["append", "--", memFile!, text.trim()]);
      if (result.code === 0) {
        ctx.ui.notify(`Appended to ${memFile}`, "success");
      } else {
        ctx.ui.notify(`mem failed: ${result.stderr}`, "error");
      }
    },
  });
}
