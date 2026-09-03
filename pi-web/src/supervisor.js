import { access, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { PiRpcProcess } from "./rpc-process.js";
import { deleteSessionFile } from "./session-files.js";

const ALLOWED_RPC_COMMANDS = new Set([
  "prompt",
  "steer",
  "follow_up",
  "abort",
  "clear_queue",
  "get_state",
  "set_model",
  "cycle_model",
  "get_available_models",
  "set_thinking_level",
  "cycle_thinking_level",
  "get_available_thinking_levels",
  "set_steering_mode",
  "set_follow_up_mode",
  "compact",
  "set_auto_compaction",
  "set_auto_retry",
  "abort_retry",
  "bash",
  "abort_bash",
  "get_session_stats",
  "export_html",
  "get_fork_messages",
  "get_entries",
  "get_tree",
  "get_last_assistant_text",
  "set_session_name",
  "get_messages",
  "get_commands",
]);

export class SessionSupervisor {
  #config;
  #store;
  #runtimes = new Map();
  #starting = new Map();
  #pendingUi = new Map();
  #listeners = new Set();

  constructor(config, store) {
    this.#config = config;
    this.#store = store;
  }

  onEvent(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  list() {
    return this.#store.list().map((record) => ({
      ...record,
      status: this.#runtimes.get(record.id)?.running ? "running" : "dormant",
    }));
  }

  async create(options) {
    if (typeof options.cwd !== "string" || !isAbsolute(options.cwd)) {
      throw new Error("Working directory must be an absolute path");
    }
    const cwd = await realpath(options.cwd);
    await access(cwd);
    const name = typeof options.name === "string" ? options.name.trim().slice(0, 200) : "";
    const approveProject = options.approveProject === true;
    const runtime = this.#newRuntime({ cwd, name, approveProject });
    let state;
    try {
      state = await runtime.start();
    } catch (error) {
      await runtime.stop();
      throw error;
    }
    const now = Date.now();
    const record = {
      id: state.sessionId,
      cwd,
      sessionFile: state.sessionFile,
      name: state.sessionName || name || undefined,
      approveProject,
      createdAt: now,
      updatedAt: now,
    };
    await this.#store.put(record);
    this.#bind(record.id, runtime);
    this.#emit({ type: "sessions_changed", sessions: this.list() });
    return { record, snapshot: await runtime.snapshot(), pendingUi: this.#getPendingUi(record.id) };
  }

  async importSession(metadata) {
    const existing = this.#store.list().find((record) =>
      record.id === metadata.id || record.sessionFile === metadata.sessionFile);
    if (existing) return this.attach(existing.id);

    const runtime = this.#newRuntime({
      cwd: metadata.cwd,
      sessionFile: metadata.sessionFile,
      name: metadata.name,
      approveProject: false,
    });
    let state;
    try {
      state = await runtime.start();
    } catch (error) {
      await runtime.stop();
      throw error;
    }
    const now = Date.now();
    const record = {
      id: state.sessionId,
      cwd: metadata.cwd,
      sessionFile: state.sessionFile ?? metadata.sessionFile,
      name: state.sessionName || metadata.name || undefined,
      approveProject: false,
      createdAt: metadata.createdAt ?? now,
      updatedAt: now,
    };
    const idCollision = this.#store.get(record.id);
    if (idCollision) {
      await runtime.stop();
      return this.attach(idCollision.id);
    }
    await this.#store.put(record);
    this.#bind(record.id, runtime);
    this.#emit({ type: "sessions_changed", sessions: this.list() });
    return { record, snapshot: await runtime.snapshot(), pendingUi: this.#getPendingUi(record.id) };
  }

  async attach(sessionId) {
    const record = this.#store.get(sessionId);
    if (!record) throw new Error(`Unknown session: ${sessionId}`);
    let runtime = this.#runtimes.get(sessionId);
    if (!runtime?.running) runtime = await this.#start(record);
    return {
      record: this.#store.get(sessionId),
      snapshot: await runtime.snapshot(),
      pendingUi: this.#getPendingUi(sessionId),
    };
  }

  async request(sessionId, command) {
    if (!command || typeof command.type !== "string" || !ALLOWED_RPC_COMMANDS.has(command.type)) {
      throw new Error(`Unsupported RPC command: ${command?.type ?? "unknown"}`);
    }
    const record = this.#store.get(sessionId);
    if (!record) throw new Error(`Unknown session: ${sessionId}`);
    let runtime = this.#runtimes.get(sessionId);
    if (!runtime?.running) runtime = await this.#start(record);
    const { id: _ignoredId, ...safeCommand } = command;
    const response = await runtime.request(safeCommand);
    if (["set_model", "cycle_model", "set_thinking_level", "cycle_thinking_level", "set_session_name"].includes(command.type)) {
      void this.#publishSnapshot(sessionId, runtime);
    }
    return response;
  }

  sendExtensionResponse(sessionId, response) {
    const runtime = this.#runtimes.get(sessionId);
    if (!runtime?.running) throw new Error(`Session is not running: ${sessionId}`);
    const pending = this.#pendingUi.get(sessionId)?.get(response.id);
    if (pending?.timer) clearTimeout(pending.timer);
    this.#pendingUi.get(sessionId)?.delete(response.id);
    runtime.sendExtensionResponse(response);
  }

  async stopSession(sessionId) {
    const runtime = this.#runtimes.get(sessionId);
    if (!runtime) return;
    this.#runtimes.delete(sessionId);
    this.#clearPendingUi(sessionId);
    await runtime.stop();
    this.#emit({ type: "session_status", sessionId, status: "dormant" });
    this.#emit({ type: "sessions_changed", sessions: this.list() });
  }

  async deleteSession(sessionId) {
    const record = this.#store.get(sessionId);
    if (!record) throw new Error(`Unknown session: ${sessionId}`);

    let runtime = this.#runtimes.get(sessionId);
    const starting = this.#starting.get(sessionId);
    if (!runtime && starting) {
      try {
        runtime = await starting;
      } catch {
        // A failed startup does not prevent deletion of the saved session.
      }
    }
    this.#runtimes.delete(sessionId);
    this.#clearPendingUi(sessionId);
    if (runtime) await runtime.stop();

    try {
      await deleteSessionFile(this.#config.sessionDir, record.sessionFile);
    } catch (error) {
      this.#emit({ type: "sessions_changed", sessions: this.list() });
      throw error;
    }
    await this.#store.remove(sessionId);
    this.#emit({ type: "sessions_changed", sessions: this.list() });
  }

  async close() {
    const runtimes = [...this.#runtimes.values()];
    this.#runtimes.clear();
    for (const sessionId of this.#pendingUi.keys()) this.#clearPendingUi(sessionId);
    await Promise.allSettled(runtimes.map((runtime) => runtime.stop()));
  }

  async #start(record) {
    const existing = this.#starting.get(record.id);
    if (existing) return existing;
    const pending = (async () => {
      const runtime = this.#newRuntime(record);
      try {
        const state = await runtime.start();
        if (record.name && !state.sessionName) {
          await runtime.request({ type: "set_session_name", name: record.name }, 30_000);
        }
        this.#bind(record.id, runtime);
        this.#emit({ type: "session_status", sessionId: record.id, status: "running" });
        this.#emit({ type: "sessions_changed", sessions: this.list() });
        return runtime;
      } catch (error) {
        await runtime.stop();
        throw error;
      }
    })();
    this.#starting.set(record.id, pending);
    try {
      return await pending;
    } finally {
      this.#starting.delete(record.id);
    }
  }

  #newRuntime(record) {
    return new PiRpcProcess({
      piBin: this.#config.piBin,
      rpcTimeoutMs: this.#config.rpcTimeoutMs,
      cwd: record.cwd,
      name: record.name,
      sessionFile: record.sessionFile,
      approveProject: record.approveProject,
    });
  }

  #bind(sessionId, runtime) {
    const previous = this.#runtimes.get(sessionId);
    if (previous && previous !== runtime) {
      this.#clearPendingUi(sessionId);
      void previous.stop();
    }
    this.#runtimes.set(sessionId, runtime);
    runtime.onEvent((event) => {
      if (event.type === "process_exit") {
        if (this.#runtimes.get(sessionId) === runtime) this.#runtimes.delete(sessionId);
        this.#clearPendingUi(sessionId);
        this.#emit({ type: "session_event", sessionId, event });
        this.#emit({ type: "sessions_changed", sessions: this.list() });
        return;
      }
      if (
        event.type === "extension_ui_request" &&
        ["select", "confirm", "input", "editor"].includes(event.method)
      ) {
        let requests = this.#pendingUi.get(sessionId);
        if (!requests) {
          requests = new Map();
          this.#pendingUi.set(sessionId, requests);
        }
        const timer = event.timeout
          ? setTimeout(() => requests.delete(event.id), event.timeout + 1_000)
          : undefined;
        requests.set(event.id, { request: structuredClone(event), timer });
      }
      this.#emit({ type: "session_event", sessionId, event });
      if (event.type === "agent_settled") void this.#publishSnapshot(sessionId, runtime);
    });
  }

  async #publishSnapshot(sessionId, runtime) {
    try {
      const snapshot = await runtime.snapshot();
      if (this.#runtimes.get(sessionId) !== runtime) return;
      const record = this.#store.get(sessionId);
      await this.#store.update(sessionId, {
        sessionFile: snapshot.state.sessionFile,
        name: snapshot.state.sessionName ?? record?.name,
        updatedAt: Date.now(),
      });
      this.#emit({ type: "session_snapshot", sessionId, snapshot });
      this.#emit({ type: "sessions_changed", sessions: this.list() });
    } catch (error) {
      if (runtime.running) this.#emit({ type: "session_error", sessionId, error: error.message });
    }
  }

  #getPendingUi(sessionId) {
    return [...(this.#pendingUi.get(sessionId)?.values() ?? [])].map(({ request }) => structuredClone(request));
  }

  #clearPendingUi(sessionId) {
    const pending = this.#pendingUi.get(sessionId);
    if (!pending) return;
    for (const { timer } of pending.values()) if (timer) clearTimeout(timer);
    this.#pendingUi.delete(sessionId);
  }

  #emit(event) {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {
        // Observation cannot affect session execution.
      }
    }
  }
}
