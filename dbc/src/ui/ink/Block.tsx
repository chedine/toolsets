import React from "react";
import { Box, Text } from "ink";
import type { OutputBlock } from "../../core/output.js";
import { formatResult } from "./format.js";

export function Block({ block }: { block: OutputBlock }): React.JSX.Element {
  if (block.type === "input") {
    return <Box marginTop={1}><Text color="cyan">› </Text><Text>{block.text}</Text></Box>;
  }
  if (block.type === "message") {
    const color = block.tone === "error" ? "red" : block.tone === "success" ? "green" : undefined;
    return <Box><Text color={color} dimColor={block.tone === "muted"}>{block.text}</Text></Box>;
  }
  if (block.result.kind === "mutation") {
    return (
      <Box>
        <Text color="green">{block.result.rowsAffected} row{block.result.rowsAffected === 1 ? "" : "s"} affected</Text>
        <Text dimColor> · {block.result.elapsedMs} ms · {block.result.committed ? "committed" : "pending"}</Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column">
      <Text>{formatResult(block.result, Math.max(40, (process.stdout.columns ?? 120) - 2))}</Text>
      <Text dimColor>{block.result.rows.length} row{block.result.rows.length === 1 ? "" : "s"} · {block.result.elapsedMs} ms{block.result.truncated ? " · more rows not fetched" : ""}</Text>
    </Box>
  );
}
