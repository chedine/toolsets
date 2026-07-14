import type { QueryResult } from "../../core/types.js";

const MAX_COLUMN_WIDTH = 32;

export function formatResult(result: QueryResult, terminalWidth = 120): string {
  if (!result.columns.length) return "No columns";
  const values = result.rows.map((row) => row.map(formatValue));
  const widths = result.columns.map((column, index) => Math.min(
    MAX_COLUMN_WIDTH,
    Math.max(column.name.length, ...values.map((row) => (row[index] ?? "").length)),
  ));

  while (tableWidth(widths) > terminalWidth && widths.some((width) => width > 8)) {
    const widest = widths.indexOf(Math.max(...widths));
    widths[widest]--;
  }

  const line = (cells: string[]) => cells.map((cell, index) => pad(truncate(cell, widths[index]), widths[index])).join("  ").trimEnd();
  return [
    line(result.columns.map((column) => column.name)),
    widths.map((width) => "─".repeat(width)).join("  "),
    ...values.map(line),
  ].join("\n");
}

function tableWidth(widths: number[]): number {
  return widths.reduce((sum, width) => sum + width, 0) + (widths.length - 1) * 2;
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return `<buffer ${value.length}b>`;
  if (typeof value === "object") {
    try { return JSON.stringify(value); } catch { return String(value); }
  }
  return String(value).replaceAll("\n", "↵");
}

function truncate(value: string, width: number): string {
  return value.length <= width ? value : `${value.slice(0, Math.max(0, width - 1))}…`;
}

function pad(value: string, width: number): string { return value.padEnd(width, " "); }
