import type { CatalogTable, DatabaseCatalog } from "./types.js";

export function resolveEditableTable(
  sql: string,
  catalog: DatabaseCatalog | undefined,
  resultColumns: string[],
): CatalogTable | undefined {
  if (!catalog || /\bjoin\b/i.test(withoutComments(sql))) return undefined;
  const normalizedSql = withoutComments(sql);
  const source = normalizedSql.match(/\bfrom\s+((?:"[^"]+"|[A-Za-z][\w$#]*)(?:\s*\.\s*(?:"[^"]+"|[A-Za-z][\w$#]*))?)/i)?.[1];
  if (source) {
    const tableName = source.split(".").at(-1)?.trim().replaceAll('"', "");
    const direct = catalog.tables.find((table) => same(table.name, tableName));
    if (direct) return direct;
  }

  const names = new Set(resultColumns.map((name) => name.toUpperCase()));
  return catalog.tables
    .filter((table) => {
      const keys = table.columns.filter((column) => column.primaryKey);
      return keys.length > 0 && keys.every((key) => names.has(key.name.toUpperCase()));
    })
    .map((table) => ({
      table,
      score: table.columns.filter((column) => names.has(column.name.toUpperCase())).length,
    }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)[0]?.table;
}

export function sameIdentifier(left: string, right: string | undefined): boolean {
  return right !== undefined && left.toUpperCase() === right.toUpperCase();
}

function same(left: string, right: string | undefined): boolean {
  return sameIdentifier(left, right);
}

function withoutComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--.*$/gm, " ");
}
