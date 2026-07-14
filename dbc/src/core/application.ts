import { complete } from "./completion.js";
import { ConnectionManager } from "./connection-manager.js";
import { HELP } from "./help.js";
import type { CommandOutcome, DbcApplication, OutputBlock } from "./output.js";
import { shellWords } from "./shell-words.js";
import { assertIdentifier, sqlString } from "./sql-utils.js";
import { TemplateStore } from "./template-store.js";
import type { Completion, SessionInfo } from "./types.js";

export class Application implements DbcApplication {
  private readonly history: string[] = [];

  constructor(
    private readonly connections: ConnectionManager,
    private readonly templates: TemplateStore,
  ) {}

  context(): SessionInfo | undefined { return this.connections.active; }

  async completions(input: string, cursorOffset = input.length): Promise<Completion[]> {
    const needsCatalog = this.connections.active && (!input.startsWith("/") || /^\/describe\b/i.test(input));
    const [templates, catalog] = await Promise.all([
      this.templates.all(),
      needsCatalog ? this.connections.catalog().catch(() => undefined) : Promise.resolve(undefined),
    ]);
    return complete(input, {
      configuredConnections: this.connections.configuredNames(),
      openConnections: this.connections.sessionInfos().map(({ name }) => name),
      templates,
      catalog,
    }, cursorOffset);
  }

  cancel(): Promise<void> { return this.connections.cancel(); }
  close(): Promise<void> { return this.connections.closeAll(); }

  async submit(rawInput: string): Promise<CommandOutcome> {
    const input = rawInput.trim();
    if (!input) return { blocks: [] };
    const inputBlock: OutputBlock = { type: "input", text: input };
    try {
      const outcome = input.startsWith("/")
        ? await this.command(input)
        : await this.sqlOrTemplate(input);
      return { ...outcome, blocks: [inputBlock, ...outcome.blocks] };
    } catch (error) {
      return {
        blocks: [inputBlock, { type: "message", tone: "error", text: (error as Error).message }],
      };
    }
  }

  private async command(input: string): Promise<CommandOutcome> {
    const [command = "", ...args] = shellWords(input.slice(1));
    switch (command.toLowerCase()) {
      case "connect": {
        requireArgs(args, 1, "/connect <name>");
        const info = await this.connections.connect(args[0]);
        return message(`Connected to ${info.name}`, "success");
      }
      case "use": {
        requireArgs(args, 1, "/use <name>");
        const info = this.connections.use(args[0]);
        return message(`Using ${info.name}`);
      }
      case "connections": {
        const open = new Map(this.connections.sessionInfos().map((item) => [item.name, item]));
        const active = this.connections.active?.name;
        const text = this.connections.configuredNames().map((name) => {
          const session = open.get(name);
          return `${name === active ? "*" : " "} ${name}${session ? `  open · autocommit ${session.autoCommit ? "ON" : "OFF"}${session.dirty ? " · uncommitted" : ""}` : ""}`;
        }).join("\n") || "No connections configured";
        return message(text);
      }
      case "autocommit": {
        if (!/^(on|off)$/i.test(args[0] ?? "")) throw new Error("Usage: /autocommit on|off");
        const session = this.connections.setAutoCommit(args[0].toLowerCase() === "on");
        return message(`Autocommit ${session.autoCommit ? "ON" : "OFF"}`, "success");
      }
      case "commit":
        await this.connections.commit();
        return message("Committed", "success");
      case "rollback":
        await this.connections.rollback();
        return message("Rolled back", "success");
      case "tables": {
        const pattern = (args[0] ?? "*").replaceAll("*", "%").toUpperCase();
        return this.runSql(`SELECT table_name FROM user_tables WHERE table_name LIKE ${sqlString(pattern)} ORDER BY table_name`);
      }
      case "describe": {
        requireArgs(args, 1, "/describe <table>");
        const identifier = assertIdentifier(args[0]);
        const parts = identifier.split(".");
        const table = parts.at(-1)!;
        const ownerClause = parts.length === 2
          ? `owner = ${sqlString(parts[0])}`
          : "owner = SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA')";
        return this.runSql(`SELECT column_id, column_name, data_type, data_length, nullable FROM all_tab_columns WHERE ${ownerClause} AND table_name = ${sqlString(table)} ORDER BY column_id`);
      }
      case "refresh": {
        const catalog = await this.connections.catalog(true);
        return message(`Metadata refreshed · ${catalog.tables.length} tables`, "success");
      }
      case "template":
        return this.templateCommand(input, args);
      case "history":
        return message(this.history.map((sql, index) => `${index + 1}  ${sql}`).join("\n") || "History is empty", "muted");
      case "clear":
        return { blocks: [], clear: true };
      case "help":
      case "?":
        return message(HELP);
      case "exit":
      case "quit":
        return { blocks: [], exit: true };
      default:
        throw new Error(`Unknown command: /${command}. Run /help.`);
    }
  }

  private async templateCommand(input: string, args: string[]): Promise<CommandOutcome> {
    const action = args[0]?.toLowerCase();
    if (action === "save") {
      const match = input.match(/^\/template\s+save\s+([A-Za-z][\w-]*)\s+([\s\S]+)$/i);
      if (!match) throw new Error("Usage: /template save <name> <sql>");
      await this.templates.save(match[1], match[2]);
      return message(`Saved template ${match[1]}`, "success");
    }
    if (action === "list") {
      const templates = await this.templates.all();
      return message(Object.keys(templates).sort().join("\n") || "No templates saved");
    }
    if (action === "show") {
      requireArgs(args.slice(1), 1, "/template show <name>");
      const sql = await this.templates.get(args[1]);
      if (!sql) throw new Error(`Unknown template: ${args[1]}`);
      return message(sql);
    }
    if (action === "delete") {
      requireArgs(args.slice(1), 1, "/template delete <name>");
      if (!(await this.templates.remove(args[1]))) throw new Error(`Unknown template: ${args[1]}`);
      return message(`Deleted template ${args[1]}`, "success");
    }
    throw new Error("Usage: /template save|list|show|delete");
  }

  private async sqlOrTemplate(input: string): Promise<CommandOutcome> {
    const words = shellWords(input);
    const rendered = words.length ? await this.templates.render(words[0], words.slice(1)) : undefined;
    if (rendered !== undefined) {
      const outcome = await this.runSql(rendered);
      return { ...outcome, blocks: [{ type: "message", tone: "muted", text: rendered }, ...outcome.blocks] };
    }
    return this.runSql(input);
  }

  private async runSql(sql: string): Promise<CommandOutcome> {
    this.history.push(sql);
    return { blocks: [{ type: "result", result: await this.connections.execute(sql) }] };
  }
}

function message(text: string, tone: "normal" | "muted" | "success" | "error" = "normal"): CommandOutcome {
  return { blocks: [{ type: "message", text, tone }] };
}

function requireArgs(args: string[], count: number, usage: string): void {
  if (args.length < count) throw new Error(`Usage: ${usage}`);
}
