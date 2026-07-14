import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { notebooksDirectory } from "./paths.js";
import type { NotebookDocument, NotebookSummary } from "./types.js";

export class NotebookStore {
  constructor(private readonly directory = notebooksDirectory()) {}

  async list(): Promise<NotebookSummary[]> {
    try {
      const files = await fs.readdir(this.directory);
      const documents = await Promise.all(files.filter((file) => file.endsWith(".json")).map(async (file) => {
        try { return await this.readFile(path.join(this.directory, file)); } catch { return undefined; }
      }));
      return documents.filter((item): item is NotebookDocument => Boolean(item))
        .map(summary)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async create(name = "Untitled", connection?: string): Promise<NotebookDocument> {
    const now = new Date().toISOString();
    const document: NotebookDocument = {
      id: crypto.randomUUID(),
      name: cleanName(name),
      connection,
      cells: [{ id: crypto.randomUUID(), sql: "" }],
      createdAt: now,
      updatedAt: now,
    };
    await this.save(document);
    return document;
  }

  async get(id: string): Promise<NotebookDocument> {
    return this.readFile(this.file(id));
  }

  async save(document: NotebookDocument): Promise<NotebookDocument> {
    assertId(document.id);
    const saved: NotebookDocument = {
      ...document,
      name: cleanName(document.name),
      cells: document.cells.map((cell) => ({ id: cell.id || crypto.randomUUID(), sql: cell.sql ?? "" })),
      updatedAt: new Date().toISOString(),
    };
    await fs.mkdir(this.directory, { recursive: true });
    const file = this.file(saved.id);
    const temporary = `${file}.${process.pid}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(saved, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporary, file);
    return saved;
  }

  async duplicate(id: string): Promise<NotebookDocument> {
    const source = await this.get(id);
    const now = new Date().toISOString();
    return this.save({
      ...source,
      id: crypto.randomUUID(),
      name: `${source.name} copy`,
      cells: source.cells.map((cell) => ({ id: crypto.randomUUID(), sql: cell.sql })),
      createdAt: now,
      updatedAt: now,
    });
  }

  async remove(id: string): Promise<boolean> {
    try {
      await fs.unlink(this.file(id));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  private file(id: string): string {
    assertId(id);
    return path.join(this.directory, `${id}.json`);
  }

  private async readFile(file: string): Promise<NotebookDocument> {
    return JSON.parse(await fs.readFile(file, "utf8")) as NotebookDocument;
  }
}

const summary = ({ id, name, connection, updatedAt }: NotebookDocument): NotebookSummary => ({ id, name, connection, updatedAt });

function assertId(id: string): void {
  if (!/^[a-f0-9-]{20,}$/i.test(id)) throw new Error("Invalid notebook id");
}

function cleanName(name: string): string {
  const cleaned = name.trim();
  if (!cleaned) throw new Error("Notebook name cannot be empty");
  return cleaned.slice(0, 120);
}
