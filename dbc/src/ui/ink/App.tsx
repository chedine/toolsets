import React, { useEffect, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import type { DbcApplication, OutputBlock } from "../../core/output.js";
import type { Completion } from "../../core/types.js";
import { Block } from "./Block.js";
import { PromptInput } from "./PromptInput.js";

export function InkApp({ application, defaultConnection }: { application: DbcApplication; defaultConnection?: string }): React.JSX.Element {
  const { exit } = useApp();
  const [blocks, setBlocks] = useState<OutputBlock[]>([
    { type: "message", tone: "muted", text: "ACID Trip · /help for commands" },
  ]);
  const [input, setInput] = useState("");
  const [cursorOffset, setCursorOffset] = useState(0);
  const [busy, setBusy] = useState(false);
  const [completions, setCompletions] = useState<Completion[]>([]);
  const [selectedCompletion, setSelectedCompletion] = useState(0);
  const [promptHistory, setPromptHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number | undefined>();

  const submit = async (value: string): Promise<void> => {
    if (busy || !value.trim()) return;
    setInput("");
    setCursorOffset(0);
    setPromptHistory((current) => current.at(-1) === value.trim() ? current : [...current, value.trim()]);
    setHistoryIndex(undefined);
    setBusy(true);
    const outcome = await application.submit(value);
    setBlocks((current) => outcome.clear ? [] : [...current, ...outcome.blocks]);
    setBusy(false);
    if (outcome.exit) {
      await application.close();
      exit();
    }
  };

  useEffect(() => {
    if (defaultConnection) void submit(`/connect ${defaultConnection}`);
  }, []); // Connect only at startup.

  useEffect(() => {
    let active = true;
    if (!input || busy) {
      setCompletions([]);
      return () => { active = false; };
    }
    const timer = setTimeout(() => {
      void application.completions(input, cursorOffset).then((items) => {
        if (!active) return;
        setCompletions(items.slice(0, 8));
        setSelectedCompletion(0);
      });
    }, 80);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [application, input, cursorOffset, busy]);

  useInput((character, key) => {
    if (key.ctrl && character === "c" && busy) {
      void application.cancel();
      return;
    }
    if (key.ctrl && character === "d" && !busy) {
      void application.close().finally(exit);
      return;
    }
    const previousHistory = key.ctrl && character === "p";
    const nextHistory = key.ctrl && character === "n";
    const navigatingHistory = historyIndex !== undefined && (key.upArrow || key.downArrow);
    if (!busy && (previousHistory || (navigatingHistory && key.upArrow)) && promptHistory.length) {
      const next = historyIndex === undefined ? promptHistory.length - 1 : Math.max(0, historyIndex - 1);
      const value = promptHistory[next] ?? "";
      setHistoryIndex(next);
      setInput(value);
      setCursorOffset(value.length);
      return;
    }
    if (!busy && (nextHistory || (navigatingHistory && key.downArrow)) && historyIndex !== undefined) {
      const next = historyIndex + 1;
      if (next >= promptHistory.length) {
        setHistoryIndex(undefined);
        setInput("");
        setCursorOffset(0);
      } else {
        const value = promptHistory[next] ?? "";
        setHistoryIndex(next);
        setInput(value);
        setCursorOffset(value.length);
      }
      return;
    }
    if (!busy && completions.length && key.downArrow) {
      setSelectedCompletion((current) => (current + 1) % completions.length);
      return;
    }
    if (!busy && completions.length && key.upArrow) {
      setSelectedCompletion((current) => (current - 1 + completions.length) % completions.length);
      return;
    }
    if (!busy && completions.length && key.tab) {
      const completion = completions[selectedCompletion];
      if (completion) {
        setInput(completion.value);
        setCursorOffset(completion.cursorOffset);
      }
      setCompletions([]);
      return;
    }
    if (!busy && key.upArrow && promptHistory.length) {
      const next = promptHistory.length - 1;
      const value = promptHistory[next] ?? "";
      setHistoryIndex(next);
      setInput(value);
      setCursorOffset(value.length);
    }
  });

  const context = application.context();
  return (
    <Box flexDirection="column">
      <Box justifyContent="space-between">
        <Text bold> ACID Trip </Text>
        <Text dimColor>
          {context ? `${context.name} · autocommit ${context.autoCommit ? "ON" : "OFF"}${context.dirty ? " · UNCOMMITTED" : ""}` : "not connected"}
        </Text>
      </Box>
      <Text dimColor>{"─".repeat(Math.max(20, process.stdout.columns ?? 80))}</Text>
      {blocks.map((block, index) => <Block key={index} block={block} />)}
      <Box marginTop={1}>
        <Text color={busy ? "yellow" : "cyan"}>{busy ? "running… " : "› "}</Text>
        {!busy && (
          <PromptInput
            value={input}
            cursorOffset={cursorOffset}
            onChange={(value) => {
              setInput(value);
              setHistoryIndex(undefined);
            }}
            onCursorChange={setCursorOffset}
            onSubmit={(value) => void submit(value)}
          />
        )}
      </Box>
      {!busy && completions.length > 0 && (
        <Box flexDirection="column" marginLeft={2}>
          {completions.map((completion, index) => (
            <Box key={`${completion.kind}:${completion.label}`}>
              <Text color={index === selectedCompletion ? "cyan" : undefined} bold={index === selectedCompletion}>
                {index === selectedCompletion ? "› " : "  "}{completion.label}
              </Text>
              {completion.detail && <Text dimColor>  {completion.detail}</Text>}
            </Box>
          ))}
        </Box>
      )}
      <Box>
        <Text dimColor>{busy ? "Ctrl+C cancel" : completions.length ? "Tab accept · ↑↓ select · Enter run" : "↑↓ history · Enter run · Ctrl+D exit"}</Text>
      </Box>
    </Box>
  );
}
