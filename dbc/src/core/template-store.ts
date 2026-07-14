import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { templatesPath } from "./paths.js";

export class TemplateStore {
  constructor(private readonly file = templatesPath()) {}

  async all(): Promise<Record<string, string>> {
    try {
      return (YAML.parse(await fs.readFile(this.file, "utf8")) as Record<string, string> | null) ?? {};
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
  }

  async get(name: string): Promise<string | undefined> {
    return (await this.all())[name];
  }

  async save(name: string, sql: string): Promise<void> {
    assertName(name);
    if (!sql.trim()) throw new Error("Template SQL cannot be empty");
    const templates = await this.all();
    templates[name] = sql.trim();
    await this.write(templates);
  }

  async remove(name: string): Promise<boolean> {
    const templates = await this.all();
    if (!(name in templates)) return false;
    delete templates[name];
    await this.write(templates);
    return true;
  }

  async render(name: string, args: string[]): Promise<string | undefined> {
    const template = await this.get(name);
    if (!template) return undefined;
    return renderTemplate(template, args);
  }

  private async write(templates: Record<string, string>): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(this.file, YAML.stringify(templates), { mode: 0o600 });
  }
}

function assertName(name: string): void {
  if (!/^[A-Za-z][\w-]*$/.test(name)) {
    throw new Error("Template names must start with a letter and contain only letters, numbers, _ or -");
  }
}

export function renderTemplate(template: string, args: string[]): string {
  const required = [...template.matchAll(/\{(\d+)\}/g)].map((match) => Number(match[1]));
  const missing = [...new Set(required)].filter((position) => position < 1 || args[position - 1] === undefined);
  if (missing.length) throw new Error(`Missing template argument${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}`);
  return template.replace(/\{(\d+)\}/g, (_, position: string) => args[Number(position) - 1]);
}
