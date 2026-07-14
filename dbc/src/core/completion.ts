import type { Completion, DatabaseCatalog } from "./types.js";

const COMMANDS: Array<{ name: string; detail: string }> = [
  ["/connect", "connect to a configured database"],
  ["/connections", "show configured and open connections"],
  ["/use", "switch to an open connection"],
  ["/autocommit", "set autocommit on or off"],
  ["/commit", "commit the active transaction"],
  ["/rollback", "roll back the active transaction"],
  ["/tables", "list tables"],
  ["/describe", "describe a table"],
  ["/refresh", "reload table and column metadata"],
  ["/template", "manage SQL templates"],
  ["/history", "show SQL history"],
  ["/clear", "clear the notebook"],
  ["/help", "show help"],
  ["/exit", "close sessions and exit"],
].map(([name, detail]) => ({ name, detail }));

const KEYWORDS = [
  "SELECT", "FROM", "WHERE", "JOIN", "LEFT JOIN", "RIGHT JOIN", "INNER JOIN",
  "ON", "GROUP BY", "ORDER BY", "HAVING", "INSERT INTO", "UPDATE", "DELETE FROM",
  "SET", "VALUES", "AND", "OR", "AS", "NULL", "IS NULL", "IS NOT NULL",
];

const RESERVED = new Set(KEYWORDS.flatMap((keyword) => keyword.split(" ")).concat(["OUTER", "FULL", "CROSS"]));

export type CompletionContext = {
  configuredConnections: string[];
  openConnections: string[];
  templates: Record<string, string>;
  catalog?: DatabaseCatalog;
};

export function complete(input: string, context: CompletionContext, requestedCursor = input.length): Completion[] {
  const cursor = Math.max(0, Math.min(requestedCursor, input.length));
  const left = input.slice(0, cursor);
  const suffix = input.slice(cursor);
  if (left.startsWith("/")) return commandCompletions(left, suffix, context);
  return sqlCompletions(input, left, suffix, context);
}

function commandCompletions(left: string, suffix: string, context: CompletionContext): Completion[] {
  if (!left.includes(" ")) {
    return COMMANDS.filter(({ name }) => starts(name, left)).map(({ name, detail }) => {
      const inserted = `${name}${needsArgument(name) ? " " : ""}`;
      return item(name, inserted, suffix, "command", detail);
    });
  }

  const argument = left.match(/(\S*)$/)?.[1] ?? "";
  const before = left.slice(0, left.length - argument.length);
  const make = (candidate: string): { value: string; cursorOffset: number } => ({
    value: `${before}${candidate}${suffix}`,
    cursorOffset: before.length + candidate.length,
  });
  if (/^\/connect\s+/i.test(left)) return names(context.configuredConnections, argument, "connection", make);
  if (/^\/use\s+/i.test(left)) return names(context.openConnections, argument, "connection", make);
  if (/^\/autocommit\s+/i.test(left)) return names(["on", "off"], argument, "keyword", make);
  if (/^\/describe\s+/i.test(left)) {
    return names(context.catalog?.tables.map(({ name }) => name) ?? [], argument, "table", make);
  }
  if (/^\/template\s+$/i.test(left) || /^\/template\s+\S*$/i.test(left)) {
    return names(["save", "list", "show", "delete"], argument, "keyword", make);
  }
  if (/^\/template\s+(show|delete)\s+/i.test(left)) {
    return names(Object.keys(context.templates), argument, "template", make);
  }
  return [];
}

function sqlCompletions(input: string, left: string, suffix: string, context: CompletionContext): Completion[] {
  const catalog = context.catalog;
  const wordMatch = left.match(/(\*|[A-Za-z][A-Za-z0-9_$#]*)?$/);
  let partial = wordMatch?.[0] ?? "";
  const wordStart = left.length - partial.length;
  const beforeWord = left.slice(0, wordStart);
  let remainingSuffix = suffix;
  const rightWord = suffix.match(/^[A-Za-z0-9_$#]+/)?.[0] ?? "";
  if (partial && partial !== "*") remainingSuffix = suffix.slice(rightWord.length);
  if (!partial && suffix.startsWith("*") && expectsColumn(beforeWord)) {
    partial = "*";
    remainingSuffix = suffix.slice(1);
  }
  const make = (candidate: string): { value: string; cursorOffset: number } => ({
    value: `${beforeWord}${candidate}${remainingSuffix}`,
    cursorOffset: beforeWord.length + candidate.length,
  });

  if (!/\s/.test(left.trim()) && partial !== "*") {
    const templateMatches = names(Object.keys(context.templates), partial, "template", make);
    if (templateMatches.length) return templateMatches;
  }

  if (!catalog) return keywordCompletions(partial, make);

  const qualified = left.match(/([A-Za-z][A-Za-z0-9_$#]*)\.([A-Za-z0-9_$#]*)$/);
  if (qualified) {
    const qualifier = qualified[1];
    const columnPartial = qualified[2];
    const table = resolveQualifier(input, qualifier, catalog);
    if (!table) return [];
    const prefix = left.slice(0, left.length - columnPartial.length);
    const rightColumn = suffix.match(/^[A-Za-z0-9_$#]+/)?.[0] ?? "";
    const qualifiedSuffix = suffix.slice(rightColumn.length);
    return table.columns
      .filter(({ name }) => starts(name, columnPartial))
      .map(({ name, dataType }) => ({
        label: name,
        value: `${prefix}${name}${qualifiedSuffix}`,
        cursorOffset: prefix.length + name.length,
        detail: `${table.name}${dataType ? ` · ${dataType}` : ""}`,
        kind: "column" as const,
      }));
  }

  if (expectsTable(beforeWord)) {
    return catalog.tables
      .filter(({ name }) => starts(name, partial))
      .map(({ name }) => ({ label: name, ...make(name), detail: "table", kind: "table" as const }));
  }

  const referenced = referencedTables(input, catalog);
  if (referenced.length > 0 && expectsColumn(beforeWord)) {
    const seen = new Set<string>();
    const columns: Completion[] = [];
    for (const table of referenced) {
      for (const column of table.columns) {
        if (partial !== "*" && !starts(column.name, partial)) continue;
        const key = column.name.toUpperCase();
        if (seen.has(key)) continue;
        seen.add(key);
        columns.push({
          label: column.name,
          ...make(column.name),
          detail: `${table.name}${column.dataType ? ` · ${column.dataType}` : ""}`,
          kind: "column",
        });
      }
    }
    if (columns.length) return columns;
  }

  return keywordCompletions(partial, make);
}

function expectsTable(beforeWord: string): boolean {
  return /\b(?:FROM|JOIN|UPDATE|INTO)\s*$/i.test(beforeWord) || /\bDELETE\s+FROM\s*$/i.test(beforeWord);
}

function expectsColumn(beforeWord: string): boolean {
  return /\b(?:SELECT|WHERE|ON|SET|HAVING|BY|AND|OR)\s*(?:\(?\s*)$/i.test(beforeWord) || /,\s*$/.test(beforeWord);
}

function referencedTables(input: string, catalog: DatabaseCatalog): DatabaseCatalog["tables"] {
  const found: DatabaseCatalog["tables"] = [];
  const seen = new Set<string>();
  for (const match of input.matchAll(/\b(?:FROM|JOIN|UPDATE|INTO)\s+([A-Za-z][\w$#]*)/gi)) {
    const name = match[1].toUpperCase();
    const table = catalog.tables.find((candidate) => candidate.name.toUpperCase() === name);
    if (table && !seen.has(name)) {
      seen.add(name);
      found.push(table);
    }
  }
  return found;
}

function resolveQualifier(input: string, qualifier: string, catalog: DatabaseCatalog): DatabaseCatalog["tables"][number] | undefined {
  const upper = qualifier.toUpperCase();
  const direct = catalog.tables.find(({ name }) => name.toUpperCase() === upper);
  if (direct) return direct;
  for (const match of input.matchAll(/\b(?:FROM|JOIN)\s+([A-Za-z][\w$#]*)\s+(?:AS\s+)?([A-Za-z][\w$#]*)/gi)) {
    if (match[2].toUpperCase() === upper && !RESERVED.has(match[2].toUpperCase())) {
      return catalog.tables.find(({ name }) => name.toUpperCase() === match[1].toUpperCase());
    }
  }
  return undefined;
}

function keywordCompletions(
  partial: string,
  make: (candidate: string) => { value: string; cursorOffset: number },
): Completion[] {
  if (!partial || partial === "*") return [];
  return KEYWORDS.filter((keyword) => starts(keyword, partial)).map((keyword) => ({
    label: keyword,
    ...make(keyword),
    detail: "SQL keyword",
    kind: "keyword",
  }));
}

function names(
  candidates: string[],
  partial: string,
  kind: Completion["kind"],
  make: (candidate: string) => { value: string; cursorOffset: number },
): Completion[] {
  return candidates.filter((candidate) => starts(candidate, partial)).sort().map((candidate) => ({
    label: candidate,
    ...make(candidate),
    kind,
  }));
}

function item(
  label: string,
  inserted: string,
  suffix: string,
  kind: Completion["kind"],
  detail?: string,
): Completion {
  return { label, value: `${inserted}${suffix}`, cursorOffset: inserted.length, kind, detail };
}

function starts(value: string, partial: string): boolean {
  return value.toLowerCase().startsWith(partial.toLowerCase());
}

function needsArgument(command: string): boolean {
  return ["/connect", "/use", "/autocommit", "/describe", "/template"].includes(command);
}
