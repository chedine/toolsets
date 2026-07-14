import type { Completion, ExecutionResult, SessionInfo } from "./types.js";

export type OutputBlock =
  | { type: "input"; text: string }
  | { type: "message"; text: string; tone?: "normal" | "muted" | "success" | "error" }
  | { type: "result"; result: ExecutionResult };

export type CommandOutcome = {
  blocks: OutputBlock[];
  clear?: boolean;
  exit?: boolean;
};

export interface DbcApplication {
  submit(input: string): Promise<CommandOutcome>;
  completions(input: string, cursorOffset?: number): Promise<Completion[]>;
  cancel(): Promise<void>;
  close(): Promise<void>;
  context(): SessionInfo | undefined;
}
