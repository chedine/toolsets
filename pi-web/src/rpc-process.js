import { spawn } from "node:child_process";
import { attachJsonlReader, serializeJsonLine } from "./jsonl.js";

const MAX_STDERR_LENGTH = 64 * 1024;

export class PiRpcProcess {
  #options;
  #process;
  #stopReader;
  #listeners = new Set();
  #pending = new Map();
  #requestId = 0;
  #stderr = "";
  #exitError;
  #stopPromise;
  #stopping = false;

  constructor(options) {
    this.#options = options;
  }

  get running() {
    return Boolean(this.#process && this.#process.exitCode === null && !this.#exitError);
  }

  get stderr() {
    return this.#stderr;
  }

  async start() {
    if (this.#process) throw new Error("Pi RPC process already started");
    const args = ["--mode", "rpc"];
    if (this.#options.sessionFile) args.push("--session", this.#options.sessionFile);
    if (this.#options.name && !this.#options.sessionFile) args.push("--name", this.#options.name);
    args.push(this.#options.approveProject ? "--approve" : "--no-approve");

    const child = spawn(this.#options.piBin, args, {
      cwd: this.#options.cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.#process = child;

    child.stderr.on("data", (chunk) => {
      this.#stderr = `${this.#stderr}${chunk.toString()}`.slice(-MAX_STDERR_LENGTH);
    });
    this.#stopReader = attachJsonlReader(child.stdout, (line) => this.#handleLine(line));

    child.once("error", (error) => this.#handleExit(new Error(`Could not start Pi: ${error.message}`)));
    child.once("exit", (code, signal) => {
      this.#handleExit(new Error(`Pi exited (code=${code}, signal=${signal})${this.#stderr ? `: ${this.#stderr}` : ""}`));
    });
    child.stdin.on("error", (error) => {
      if (!this.#exitError) this.#handleExit(new Error(`Pi stdin failed: ${error.message}`));
    });

    await new Promise((resolve, reject) => {
      const onSpawn = () => {
        child.off("error", onError);
        resolve();
      };
      const onError = (error) => {
        child.off("spawn", onSpawn);
        reject(error);
      };
      child.once("spawn", onSpawn);
      child.once("error", onError);
    });

    const response = await this.request({ type: "get_state" }, 30_000);
    return response.data;
  }

  onEvent(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  request(command, timeoutMs = this.#options.rpcTimeoutMs) {
    const child = this.#process;
    if (!child?.stdin || !this.running || !child.stdin.writable) {
      return Promise.reject(this.#exitError ?? new Error("Pi RPC process is not running"));
    }

    const id = `web_${++this.#requestId}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Timed out waiting for Pi response to ${command.type}`));
      }, timeoutMs);
      this.#pending.set(id, {
        resolve: (message) => {
          clearTimeout(timer);
          if (!message.success) reject(new Error(message.error || `${command.type} failed`));
          else resolve(message);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      child.stdin.write(serializeJsonLine({ ...command, id }), (error) => {
        if (!error) return;
        const pending = this.#pending.get(id);
        this.#pending.delete(id);
        pending?.reject(error);
      });
    });
  }

  sendExtensionResponse(response) {
    const stdin = this.#process?.stdin;
    if (!stdin || !this.running || !stdin.writable) throw new Error("Pi RPC process is not running");
    stdin.write(serializeJsonLine(response));
  }

  async snapshot() {
    const [stateResponse, messagesResponse, commandsResponse, modelsResponse, thinkingResponse, statsResponse] = await Promise.all([
      this.request({ type: "get_state" }, 30_000),
      this.request({ type: "get_messages" }, 30_000),
      this.request({ type: "get_commands" }, 30_000),
      this.request({ type: "get_available_models" }, 30_000),
      this.request({ type: "get_available_thinking_levels" }, 30_000),
      this.request({ type: "get_session_stats" }, 30_000),
    ]);
    return {
      state: stateResponse.data,
      messages: messagesResponse.data.messages,
      commands: commandsResponse.data.commands,
      models: modelsResponse.data.models,
      thinkingLevels: thinkingResponse.data.levels,
      stats: statsResponse.data,
    };
  }

  stop() {
    if (this.#stopPromise) return this.#stopPromise;
    const child = this.#process;
    if (!child || child.exitCode !== null) return Promise.resolve();
    this.#stopping = true;
    this.#stopPromise = new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 2_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill("SIGTERM");
    });
    return this.#stopPromise;
  }

  #handleLine(line) {
    if (!line) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.type === "response" && message.id && this.#pending.has(message.id)) {
      const pending = this.#pending.get(message.id);
      this.#pending.delete(message.id);
      pending.resolve(message);
      return;
    }
    for (const listener of this.#listeners) {
      try {
        listener(message);
      } catch {
        // A UI listener cannot affect the agent process.
      }
    }
  }

  #handleExit(error) {
    if (this.#exitError) return;
    this.#exitError = error;
    this.#stopReader?.();
    this.#stopReader = undefined;
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    if (!this.#stopping) {
      for (const listener of this.#listeners) {
        try {
          listener({ type: "process_exit", error: error.message });
        } catch {
          // A UI listener cannot affect cleanup.
        }
      }
    }
  }
}
