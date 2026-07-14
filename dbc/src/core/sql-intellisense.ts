import type { DatabaseCatalog } from "./types.js";

export type SqlSuggestion = {
  label: string;
  detail?: string;
  kind: "table" | "column" | "keyword";
  from: number;
};

const KEYWORDS = [
  "SELECT", "FROM", "WHERE", "JOIN", "LEFT JOIN", "RIGHT JOIN", "INNER JOIN",
  "ON", "GROUP BY", "ORDER BY", "HAVING", "INSERT INTO", "UPDATE", "DELETE FROM",
  "SET", "VALUES", "AND", "OR", "AS", "NULL", "IS NULL", "IS NOT NULL",
];

const RESERVED = new Set([
  ...KEYWORDS.flatMap((keyword) => keyword.split(" ")),
  "FULL", "CROSS", "OUTER", "UNION", "MINUS", "FETCH", "OFFSET", "CONNECT", "START",
]);

export function sqlSuggestions(
  sql: string,
  cursor: number,
  catalog: DatabaseCatalog,
): SqlSuggestion[] {
  const position = Math.max(0, Math.min(cursor, sql.length));
  const left = sql.slice(0, position);
  const qualified = left.match(/([A-Za-z][\w$#]*)\.([A-Za-z0-9_$#]*)$/);
  const references = referencedTables(sql, catalog);

  if (qualified) {
    const qualifier = qualified[1].toUpperCase();
    const partial = qualified[2];
    const reference = references.find(({ table, alias }) => alias === qualifier || table.name.toUpperCase() === qualifier);
    if (!reference) return [];
    return reference.table.columns
      .filter((column) => starts(column.name, partial))
      .map((column) => columnSuggestion(column.name, reference.table.name, column.dataType, position - partial.length));
  }

  const partial = left.match(/([A-Za-z][A-Za-z0-9_$#]*)?$/)?.[0] ?? "";
  const from = position - partial.length;
  const beforeWord = left.slice(0, from);

  if (expectsTable(beforeWord)) {
    return catalog.tables
      .filter((table) => starts(table.name, partial))
      .map((table) => ({ label: table.name, detail: "table", kind: "table" as const, from }));
  }

  if (expectsColumn(beforeWord) && references.length > 0) {
    const seen = new Set<string>();
    const suggestions: SqlSuggestion[] = [];
    for (const { table } of references) {
      for (const column of table.columns) {
        const key = column.name.toUpperCase();
        if (seen.has(key) || !starts(column.name, partial)) continue;
        seen.add(key);
        suggestions.push(columnSuggestion(column.name, table.name, column.dataType, from));
      }
    }
    return suggestions.sort((a, b) => a.label.localeCompare(b.label));
  }

  if (!partial) return [];
  return KEYWORDS
    .filter((keyword) => starts(keyword, partial))
    .map((keyword) => ({ label: keyword, detail: "keyword", kind: "keyword" as const, from }));
}

function referencedTables(sql: string, catalog: DatabaseCatalog): Array<{ table: DatabaseCatalog["tables"][number]; alias?: string }> {
  const references: Array<{ table: DatabaseCatalog["tables"][number]; alias?: string }> = [];
  const pattern = /\b(?:FROM|JOIN|UPDATE|INTO)\s+((?:"[^"]+"|[A-Za-z][\w$#]*)(?:\s*\.\s*(?:"[^"]+"|[A-Za-z][\w$#]*))?)(?:\s+(?:AS\s+)?([A-Za-z][\w$#]*))?/gi;
  for (const match of sql.matchAll(pattern)) {
    const tableName = match[1].split(".").at(-1)?.trim().replaceAll('"', "").toUpperCase();
    const table = catalog.tables.find((candidate) => candidate.name.toUpperCase() === tableName);
    if (!table || references.some((reference) => reference.table.name === table.name)) continue;
    const possibleAlias = match[2]?.toUpperCase();
    references.push({ table, alias: possibleAlias && !RESERVED.has(possibleAlias) ? possibleAlias : undefined });
  }
  return references;
}

function expectsTable(beforeWord: string): boolean {
  return /\b(?:FROM|JOIN|UPDATE|INTO)\s*$/i.test(beforeWord) || /\bDELETE\s+FROM\s*$/i.test(beforeWord);
}

function expectsColumn(beforeWord: string): boolean {
  return /\b(?:SELECT|WHERE|HAVING|ON|SET|AND|OR)\s*\(?\s*$/i.test(beforeWord)
    || /\b(?:ORDER|GROUP)\s+BY\s*$/i.test(beforeWord)
    || /,\s*$/.test(beforeWord);
}

function columnSuggestion(label: string, table: string, dataType: string | undefined, from: number): SqlSuggestion {
  return { label, detail: `${table}${dataType ? ` · ${dataType}` : ""}`, kind: "column", from };
}

function starts(value: string, partial: string): boolean {
  return value.toLowerCase().startsWith(partial.toLowerCase());
}
