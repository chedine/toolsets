import DOMPurify from "/vendor/purify.es.mjs";
import { marked, Renderer } from "/vendor/marked.esm.js";

const markdownRenderer = new Renderer();
markdownRenderer.html = ({ text }) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
marked.setOptions({ gfm: true, breaks: false, renderer: markdownRenderer });

const elements = Object.fromEntries(
  [
    "login", "login-form", "token-input", "login-error", "app", "sidebar", "sidebar-toggle", "sidebar-collapse",
    "empty-new-session", "session-list", "connection", "command-palette-trigger", "command-palette-dialog",
    "command-palette-input", "command-palette-count", "command-palette-results", "session-title", "session-path",
    "thinking-select", "empty-state", "conversation", "composer", "queue-bar", "image-tray", "image-picker", "image-input", "prompt",
    "send", "send-follow-up", "abort", "tool-toggle", "theme-toggle", "details-panel", "details-toggle", "details-collapse", "cost-value", "context-label", "context-bar",
    "tokens-in", "tokens-out", "tool-count", "turn-count", "user-count", "message-count", "model-list",
    "show-tools", "show-thinking", "auto-compaction", "font-options", "user-font", "user-font-size",
    "agent-font", "agent-font-size", "message-font-stylesheet",
    "session-search-dialog", "session-search-close", "session-search-input", "session-search-status", "session-search-results",
    "new-dialog", "new-form", "cwd-input", "browse-cwd", "name-input", "directory-dialog", "directory-form",
    "directory-path", "directory-up", "directory-count", "directory-list", "directory-error", "select-directory",
    "approve-input", "new-error", "create-session", "delete-session-dialog", "delete-session-form", "delete-session-name",
    "delete-session-error", "confirm-delete-session", "extension-dialog", "extension-form", "extension-title",
    "extension-message", "extension-field", "extension-cancel", "extension-submit", "toast-region",
  ].map((id) => [id, document.getElementById(id)]),
);

const MESSAGE_FONTS = {
  "Space Grotesk": { css: "'Space Grotesk', sans-serif" },
  "JetBrains Mono": { css: "'JetBrains Mono', monospace" },
  Archivo: { css: "Archivo, Helvetica, sans-serif" },
  Inter: { css: "Inter, sans-serif", google: "Inter:wght@400;600" },
  "IBM Plex Sans": { css: "'IBM Plex Sans', sans-serif", google: "IBM+Plex+Sans:wght@400;600" },
  "Source Sans 3": { css: "'Source Sans 3', sans-serif", google: "Source+Sans+3:wght@400;600" },
  "DM Sans": { css: "'DM Sans', sans-serif", google: "DM+Sans:wght@400;600" },
  Manrope: { css: "Manrope, sans-serif", google: "Manrope:wght@400;600" },
  "Instrument Sans": { css: "'Instrument Sans', sans-serif", google: "Instrument+Sans:wght@400;600" },
  Lora: { css: "Lora, serif", google: "Lora:wght@400;600" },
  "Roboto Mono": { css: "'Roboto Mono', monospace", google: "Roboto+Mono:wght@400;600" },
};

const MAX_IMAGE_COUNT = 4;
const MAX_IMAGE_SIZE = 8 * 1024 * 1024;
const MAX_TOTAL_IMAGE_SIZE = 20 * 1024 * 1024;
const SUPPORTED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

const state = {
  socket: undefined,
  connected: false,
  reconnectTimer: undefined,
  requests: new Map(),
  requestId: 0,
  sessions: [],
  selectedId: undefined,
  snapshot: undefined,
  partialAssistant: undefined,
  thinkingGeneration: 0,
  sessionTitleEditing: false,
  sessionTitleOriginal: "",
  deleteTarget: undefined,
  toolArgumentBuffers: new Map(),
  liveTools: new Map(),
  queues: { steering: [], followUp: [] },
  pendingImages: [],
  imageReads: 0,
  imageReadBytes: 0,
  statuses: new Map(),
  pendingExtension: undefined,
  extensionQueue: [],
  sessionSearchTimer: undefined,
  sessionSearchGeneration: 0,
  directoryBrowseGeneration: 0,
  currentDirectory: undefined,
  parentDirectory: undefined,
  commandPaletteSelection: 0,
  showTools: false,
  showThinking: true,
  renderScheduled: false,
  manuallyDisconnected: false,
};

const COMMAND_PALETTE_KEY = "k";
const COMMANDS = [
  {
    id: "new-session",
    icon: "+",
    title: "New session",
    description: "Start a new Pi agent session",
    category: "SESSION",
    keywords: "create project working directory",
    action: showNewDialog,
  },
  {
    id: "find-pi-sessions",
    icon: "⌕",
    title: "Find Pi sessions",
    description: "Search and resume native Pi session history",
    category: "SESSION",
    keywords: "open import previous history resume",
    action: showSessionSearch,
  },
];

function toast(message, type = "info") {
  const item = document.createElement("div");
  item.className = `toast ${type}`;
  item.textContent = message;
  elements["toast-region"].append(item);
  setTimeout(() => item.remove(), 5_000);
}

function connectionLabel(label, online) {
  elements.connection.className = `connection ${online ? "online" : "offline"}`;
  elements.connection.lastChild.textContent = label;
}

function currentToken() {
  return localStorage.getItem("pi-web-token") ?? "";
}

function connect() {
  clearTimeout(state.reconnectTimer);
  state.manuallyDisconnected = false;
  connectionLabel("CONNECTING", false);
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  const token = encodeURIComponent(currentToken());
  const socket = new WebSocket(`${scheme}://${location.host}/ws?token=${token}`);
  state.socket = socket;

  socket.addEventListener("open", () => {
    if (state.socket !== socket) return;
    state.connected = true;
    elements.login.classList.add("hidden");
    connectionLabel("CONNECTED", true);
  });
  socket.addEventListener("message", (event) => {
    if (state.socket !== socket) return;
    try {
      handleServerMessage(JSON.parse(event.data));
    } catch (error) {
      toast(error.message, "error");
    }
  });
  socket.addEventListener("close", () => {
    if (state.socket !== socket) return;
    state.connected = false;
    state.snapshot = undefined;
    state.partialAssistant = undefined;
    state.liveTools.clear();
    connectionLabel("DISCONNECTED", false);
    rejectRequests(new Error("Disconnected from pi-web"));
    scheduleRender();
    if (state.manuallyDisconnected) return;
    if (!currentToken()) elements.login.classList.remove("hidden");
    state.reconnectTimer = setTimeout(connect, 2_000);
  });
  socket.addEventListener("error", () => {
    if (!state.connected) {
      elements["login-error"].textContent = "Could not connect. Check the token and server address.";
      elements.login.classList.remove("hidden");
    }
  });
}

function rejectRequests(error) {
  for (const pending of state.requests.values()) {
    clearTimeout(pending.timer);
    pending.reject(error);
  }
  state.requests.clear();
}

function sendRequest(message, timeout = 10 * 60 * 1000) {
  if (!state.connected || state.socket?.readyState !== WebSocket.OPEN) {
    return Promise.reject(new Error("Not connected"));
  }
  const requestId = `browser_${++state.requestId}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      state.requests.delete(requestId);
      reject(new Error(`Request timed out: ${message.type}`));
    }, timeout);
    state.requests.set(requestId, { resolve, reject, timer });
    state.socket.send(JSON.stringify({ ...message, requestId }));
  });
}

function resolveRequest(message) {
  if (!message.requestId) return false;
  const pending = state.requests.get(message.requestId);
  if (!pending) return false;
  state.requests.delete(message.requestId);
  clearTimeout(pending.timer);
  if (message.type === "error") pending.reject(new Error(message.error));
  else pending.resolve(message);
  return true;
}

function handleServerMessage(message) {
  if (message.type === "error") {
    if (!resolveRequest(message)) toast(message.error, "error");
    return;
  }
  if (["attached", "rpc_response", "session_stopped", "session_deleted", "sessions", "session_search_results", "directory_listing"].includes(message.type)) resolveRequest(message);

  switch (message.type) {
    case "hello": {
      state.sessions = message.sessions;
      renderSessions();
      const preferred = state.selectedId ?? localStorage.getItem("pi-web-last-session");
      if (preferred && state.sessions.some(({ id }) => id === preferred)) void openSession(preferred);
      break;
    }
    case "sessions":
    case "sessions_changed":
      state.sessions = message.sessions;
      renderSessions();
      break;
    case "attached":
      cancelSessionTitleEdit();
      state.selectedId = message.sessionId;
      applySnapshot(message.snapshot);
      localStorage.setItem("pi-web-last-session", message.sessionId);
      renderSessions();
      for (const request of message.pendingUi ?? []) handleExtensionRequest(request);
      break;
    case "session_snapshot":
      if (message.sessionId === state.selectedId) applySnapshot(message.snapshot);
      break;
    case "session_event":
      if (message.sessionId === state.selectedId) applyEvent(message.event);
      break;
    case "session_error":
      if (message.sessionId === state.selectedId) toast(message.error, "error");
      break;
    case "session_status":
      renderSessions();
      break;
    case "session_deleted":
      state.deleteTarget = undefined;
      elements["delete-session-dialog"].close();
      if (message.sessionId === state.selectedId) {
        state.selectedId = undefined;
        state.snapshot = undefined;
        state.partialAssistant = undefined;
        state.liveTools.clear();
        if (localStorage.getItem("pi-web-last-session") === message.sessionId) {
          localStorage.removeItem("pi-web-last-session");
        }
        scheduleRender();
      }
      break;
  }
}

function applySnapshot(snapshot) {
  state.snapshot = snapshot;
  state.partialAssistant = undefined;
  state.thinkingGeneration = 0;
  state.toolArgumentBuffers.clear();
  state.liveTools.clear();
  state.queues = { steering: [], followUp: [] };
  scheduleRender();
}

function applyEvent(event) {
  if (!state.snapshot) return;
  switch (event.type) {
    case "agent_start":
      state.snapshot.state.isStreaming = true;
      break;
    case "agent_settled":
      state.snapshot.state.isStreaming = false;
      break;
    case "message_start":
      if (event.message?.role === "assistant") {
        state.partialAssistant = structuredClone(event.message);
        state.toolArgumentBuffers.clear();
      }
      break;
    case "message_update":
      applyAssistantDelta(event.assistantMessageEvent);
      break;
    case "message_end":
      appendMessage(event.message);
      if (event.message?.role === "assistant") state.partialAssistant = undefined;
      break;
    case "tool_execution_start":
      state.liveTools.set(event.toolCallId, { name: event.toolName, args: event.args, status: "running" });
      break;
    case "tool_execution_update": {
      const tool = state.liveTools.get(event.toolCallId) ?? { name: event.toolName, args: event.args };
      state.liveTools.set(event.toolCallId, { ...tool, status: "running", result: event.partialResult });
      break;
    }
    case "tool_execution_end":
      state.liveTools.set(event.toolCallId, {
        name: event.toolName,
        status: event.isError ? "error" : "complete",
        result: event.result,
      });
      break;
    case "queue_update":
      state.queues = { steering: event.steering ?? [], followUp: event.followUp ?? [] };
      break;
    case "compaction_start":
      state.snapshot.state.isCompacting = true;
      break;
    case "compaction_end":
      state.snapshot.state.isCompacting = false;
      break;
    case "auto_retry_start":
      state.statuses.set("retry", `Retry ${event.attempt}/${event.maxAttempts}`);
      break;
    case "auto_retry_end":
      state.statuses.delete("retry");
      break;
    case "extension_ui_request":
      handleExtensionRequest(event);
      break;
    case "process_exit":
      state.snapshot.state.isStreaming = false;
      toast(event.error, "error");
      break;
  }
  scheduleRender();
}

function ensureAssistantPart(index, type) {
  if (!state.partialAssistant) return undefined;
  if (!Array.isArray(state.partialAssistant.content)) state.partialAssistant.content = [];
  while (state.partialAssistant.content.length <= index) state.partialAssistant.content.push({ type: "text", text: "" });
  let part = state.partialAssistant.content[index];
  if (part.type !== type) {
    part = type === "thinking" ? { type, thinking: "" } : type === "toolCall" ? { type, id: "", name: "", arguments: {} } : { type, text: "" };
    state.partialAssistant.content[index] = part;
  }
  return part;
}

function applyAssistantDelta(delta) {
  if (!delta || !state.partialAssistant) return;
  const index = delta.contentIndex ?? 0;
  if (delta.type.startsWith("text_")) {
    const part = ensureAssistantPart(index, "text");
    if (delta.type === "text_delta") part.text += delta.delta;
    if (delta.type === "text_end" && typeof delta.content === "string") part.text = delta.content;
  } else if (delta.type.startsWith("thinking_")) {
    const part = ensureAssistantPart(index, "thinking");
    const wasEmpty = !part.thinking.trim();
    if (delta.type === "thinking_delta") part.thinking += delta.delta;
    if (delta.type === "thinking_end" && typeof delta.content === "string") part.thinking = delta.content;
    if (wasEmpty && part.thinking.trim()) state.thinkingGeneration += 1;
  } else if (delta.type.startsWith("toolcall_")) {
    const part = ensureAssistantPart(index, "toolCall");
    const key = String(index);
    if (delta.type === "toolcall_start") {
      part.id = delta.id;
      part.name = delta.toolName;
      state.toolArgumentBuffers.set(key, "");
    } else if (delta.type === "toolcall_delta") {
      const buffer = (state.toolArgumentBuffers.get(key) ?? "") + delta.delta;
      state.toolArgumentBuffers.set(key, buffer);
      part.arguments = buffer;
    } else if (delta.type === "toolcall_end") {
      state.partialAssistant.content[index] = delta.toolCall;
      state.toolArgumentBuffers.delete(key);
    }
  }
}

function appendMessage(message) {
  if (!message || !state.snapshot) return;
  const messages = state.snapshot.messages;
  const exists = messages.some((candidate) => candidate.role === message.role && candidate.timestamp === message.timestamp);
  if (!exists) messages.push(structuredClone(message));
}

function scheduleRender() {
  if (state.renderScheduled) return;
  state.renderScheduled = true;
  requestAnimationFrame(() => {
    state.renderScheduled = false;
    renderCurrentSession();
  });
}

function trashIcon() {
  const namespace = "http://www.w3.org/2000/svg";
  const icon = document.createElementNS(namespace, "svg");
  icon.setAttribute("viewBox", "0 0 16 16");
  icon.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(namespace, "path");
  path.setAttribute("d", "M3 4h10M6 4V2h4v2m2 0-.6 10H4.6L4 4m3 3v4m3-4v4");
  icon.append(path);
  return icon;
}

function renderSessions() {
  elements["session-list"].replaceChildren();
  for (const session of state.sessions) {
    const item = document.createElement("div");
    item.className = `session-item ${session.id === state.selectedId ? "active" : ""}`;
    const open = document.createElement("button");
    open.className = "session-open";
    const title = document.createElement("strong");
    title.textContent = session.name || "Untitled session";
    const path = document.createElement("small");
    path.textContent = session.cwd;
    const dot = document.createElement("span");
    dot.className = `status-dot ${session.status}`;
    open.append(title, dot, path);
    open.addEventListener("click", () => void openSession(session.id));
    const remove = document.createElement("button");
    remove.className = "session-delete icon-delete";
    remove.title = `Delete ${session.name || "Untitled session"}`;
    remove.setAttribute("aria-label", remove.title);
    remove.append(trashIcon());
    remove.addEventListener("click", () => showDeleteSessionDialog({
      sessionId: session.id,
      sessionFile: session.sessionFile,
      name: session.name || "Untitled session",
    }));
    item.append(open, remove);
    elements["session-list"].append(item);
  }
}

function endSessionTitleEdit() {
  state.sessionTitleEditing = false;
  const title = elements["session-title"];
  title.removeAttribute("contenteditable");
  title.removeAttribute("role");
  title.classList.remove("editing");
}

function cancelSessionTitleEdit() {
  if (!state.sessionTitleEditing) return;
  const original = state.sessionTitleOriginal;
  endSessionTitleEdit();
  elements["session-title"].textContent = original;
}

function beginSessionTitleEdit() {
  if (!state.selectedId || !state.snapshot || state.sessionTitleEditing) return;
  const title = elements["session-title"];
  state.sessionTitleEditing = true;
  state.sessionTitleOriginal = title.textContent;
  title.setAttribute("contenteditable", "plaintext-only");
  title.setAttribute("role", "textbox");
  title.classList.add("editing");
  title.focus();
  const selection = getSelection();
  const range = document.createRange();
  range.selectNodeContents(title);
  selection.removeAllRanges();
  selection.addRange(range);
}

async function commitSessionTitleEdit() {
  if (!state.sessionTitleEditing) return;
  const sessionId = state.selectedId;
  const originalDisplay = state.sessionTitleOriginal;
  const selected = state.sessions.find((session) => session.id === sessionId);
  const originalName = selected?.name;
  const name = elements["session-title"].textContent.replace(/\s+/g, " ").trim().slice(0, 200);
  endSessionTitleEdit();
  if (!name) {
    elements["session-title"].textContent = originalDisplay;
    toast("Session name cannot be empty", "error");
    return;
  }
  if (name === originalDisplay) return;

  if (selected) selected.name = name;
  if (state.snapshot && state.selectedId === sessionId) state.snapshot.state.sessionName = name;
  elements["session-title"].textContent = name;
  renderSessions();
  try {
    await sendRequest({
      type: "rpc",
      sessionId,
      command: { type: "set_session_name", name },
    });
  } catch (error) {
    const current = state.sessions.find((session) => session.id === sessionId);
    if (current) current.name = originalName;
    if (state.snapshot && state.selectedId === sessionId) {
      state.snapshot.state.sessionName = originalName;
      elements["session-title"].textContent = originalDisplay;
    }
    renderSessions();
    toast(error.message, "error");
  }
}

async function openSession(sessionId) {
  cancelSessionTitleEdit();
  elements.sidebar.classList.remove("open");
  if (sessionId === state.selectedId && state.snapshot) return;
  try {
    elements["session-title"].textContent = "Opening…";
    await sendRequest({ type: "attach_session", sessionId }, 60_000);
  } catch (error) {
    toast(error.message, "error");
    scheduleRender();
  }
}

function renderCurrentSession() {
  const snapshot = state.snapshot;
  const selected = state.sessions.find((session) => session.id === state.selectedId);
  const hasSession = Boolean(snapshot && selected);
  elements["empty-state"].classList.toggle("hidden", hasSession);
  elements.conversation.classList.toggle("hidden", !hasSession);
  elements.composer.classList.toggle("hidden", !hasSession);
  const sessionTitle = elements["session-title"];
  sessionTitle.classList.toggle("renamable", hasSession);
  sessionTitle.title = hasSession ? "Double-click to rename session" : "";
  if (!state.sessionTitleEditing) {
    sessionTitle.textContent = selected?.name || (hasSession ? "Untitled session" : "Select a session");
  }
  if (!hasSession) {
    elements["session-path"].textContent = "IDLE";
    return;
  }

  const running = Boolean(snapshot.state.isStreaming || snapshot.state.isCompacting);
  const modelId = snapshot.state.model?.id ?? "no model";
  elements["session-path"].textContent = `${running ? "RUNNING" : "IDLE · RUN COMPLETE"} · ${modelId}`;
  renderControls(snapshot);
  renderConversation(snapshot);
  renderQueue();
}

function renderControls(snapshot) {
  const running = Boolean(snapshot.state.isStreaming || snapshot.state.isCompacting);
  elements.abort.classList.toggle("hidden", !running);
  elements.send.textContent = running ? "Steer" : "Send";
  const supportsImages = snapshot.state.model?.input?.includes("image") ?? false;
  elements["send-follow-up"].disabled = !snapshot.state.isStreaming;
  elements.prompt.disabled = snapshot.state.isCompacting;
  elements.send.disabled = snapshot.state.isCompacting || state.imageReads > 0;
  elements["image-picker"].disabled = snapshot.state.isCompacting || !supportsImages;
  elements["image-picker"].title = supportsImages ? "Attach images" : "The selected model does not support images";

  const thinkingSelect = elements["thinking-select"];
  const thinkingSignature = snapshot.thinkingLevels.join("|");
  if (thinkingSelect.dataset.signature !== thinkingSignature) {
    thinkingSelect.replaceChildren();
    for (const level of snapshot.thinkingLevels) {
      const option = document.createElement("option");
      option.value = level;
      option.textContent = level;
      thinkingSelect.append(option);
    }
    thinkingSelect.dataset.signature = thinkingSignature;
  }
  thinkingSelect.value = snapshot.state.thinkingLevel;
  thinkingSelect.disabled = running;

  renderModelList(snapshot, running);
  renderStats(snapshot);
  elements["show-tools"].classList.toggle("active", state.showTools);
  elements["tool-toggle"].classList.toggle("active", state.showTools);
  elements["show-thinking"].classList.toggle("active", state.showThinking);
  elements["auto-compaction"].classList.toggle("active", snapshot.state.autoCompactionEnabled);
}

function renderModelList(snapshot, running) {
  const active = snapshot.state.model ? `${snapshot.state.model.provider}\u0000${snapshot.state.model.id}` : "";
  const signature = `${active}|${running}|${snapshot.models.map((model) => `${model.provider}/${model.id}`).join("|")}`;
  if (elements["model-list"].dataset.signature === signature) return;
  elements["model-list"].dataset.signature = signature;
  elements["model-list"].replaceChildren();

  const models = [...snapshot.models].sort((left, right) => {
    const leftActive = `${left.provider}\u0000${left.id}` === active;
    const rightActive = `${right.provider}\u0000${right.id}` === active;
    return Number(rightActive) - Number(leftActive) || left.provider.localeCompare(right.provider) || left.id.localeCompare(right.id);
  });
  for (const model of models) {
    const value = `${model.provider}\u0000${model.id}`;
    const button = document.createElement("button");
    button.className = `model-option ${value === active ? "active" : ""}`;
    button.disabled = running;
    const marker = document.createElement("i");
    const text = document.createElement("span");
    const name = document.createElement("strong");
    name.textContent = `${model.provider} / ${model.id}`;
    const detail = document.createElement("small");
    const input = model.cost?.input;
    const output = model.cost?.output;
    const price = Number.isFinite(input) && Number.isFinite(output) ? `$${input} / $${output} per Mtok` : "pricing unavailable";
    detail.textContent = `${price} · ${formatCompact(model.contextWindow)} ctx`;
    text.append(name, detail);
    button.append(marker, text);
    button.addEventListener("click", () => void setModel(model.provider, model.id));
    elements["model-list"].append(button);
  }
}

function renderStats(snapshot) {
  const stats = snapshot.stats ?? {};
  const tokens = stats.tokens ?? {};
  const context = stats.contextUsage;
  const percent = Number.isFinite(context?.percent) ? context.percent : 0;
  elements["cost-value"].textContent = `$${Number(stats.cost ?? 0).toFixed(3)}`;
  elements["context-label"].textContent = context
    ? `${Math.round(percent)}% · ${formatNumber(context.tokens)} / ${formatCompact(context.contextWindow)}`
    : "0% · 0 / —";
  elements["context-bar"].style.width = `${Math.max(0, Math.min(100, percent))}%`;
  elements["tokens-in"].textContent = formatNumber(tokens.input);
  elements["tokens-out"].textContent = formatNumber(tokens.output);
  elements["tool-count"].textContent = formatNumber(stats.toolCalls);
  elements["turn-count"].textContent = formatNumber(stats.userMessages);
  elements["user-count"].textContent = formatNumber(stats.assistantMessages);
  elements["message-count"].textContent = formatNumber(stats.totalMessages ?? snapshot.messages.length);
}

function formatNumber(value) {
  return Number.isFinite(value) ? value.toLocaleString() : "0";
}

function formatCompact(value) {
  if (!Number.isFinite(value)) return "—";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1)}m`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(value);
}

const THEMES = ["dark", "light", "nordic"];

function applyTheme(theme) {
  const selected = THEMES.includes(theme) ? theme : "dark";
  document.documentElement.dataset.theme = selected;
  elements.app.dataset.theme = selected;
  elements["theme-toggle"].textContent = `◐ ${selected.toUpperCase()}`;
  document.querySelector('meta[name="theme-color"]').content = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();
  localStorage.setItem("pi-web-theme", selected);
}

function initializeFontTester() {
  for (const name of Object.keys(MESSAGE_FONTS)) {
    const option = document.createElement("option");
    option.value = name;
    elements["font-options"].append(option);
  }
  const storedUserFont = localStorage.getItem("pi-web-user-font")?.trim();
  const storedAgentFont = localStorage.getItem("pi-web-agent-font")?.trim();
  elements["user-font"].value = resolveMessageFont(storedUserFont) ? storedUserFont : "Space Grotesk";
  elements["agent-font"].value = resolveMessageFont(storedAgentFont) ? storedAgentFont : "JetBrains Mono";
  elements["user-font-size"].value = String(normalizeFontSize(localStorage.getItem("pi-web-user-font-size"), 15));
  elements["agent-font-size"].value = String(normalizeFontSize(localStorage.getItem("pi-web-agent-font-size"), 13));
  applyMessageFonts();
}

function resolveMessageFont(name) {
  const trimmed = name?.trim();
  if (!trimmed || !/^[A-Za-z0-9 -]{1,80}$/.test(trimmed)) return undefined;
  return MESSAGE_FONTS[trimmed] ?? {
    css: `'${trimmed}', sans-serif`,
    google: trimmed.replaceAll(" ", "+"),
  };
}

function normalizeFontSize(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(10, Math.min(24, Math.round(parsed * 2) / 2)) : fallback;
}

function applyMessageFonts() {
  const userName = elements["user-font"].value.trim();
  const agentName = elements["agent-font"].value.trim();
  const userFont = resolveMessageFont(userName);
  const agentFont = resolveMessageFont(agentName);
  elements["user-font"].setCustomValidity(userFont ? "" : "Enter a Google Font family name using letters, numbers, spaces, or hyphens.");
  elements["agent-font"].setCustomValidity(agentFont ? "" : "Enter a Google Font family name using letters, numbers, spaces, or hyphens.");
  if (!userFont || !agentFont) return;

  const userSize = normalizeFontSize(elements["user-font-size"].value, 15);
  const agentSize = normalizeFontSize(elements["agent-font-size"].value, 13);
  elements["user-font-size"].value = String(userSize);
  elements["agent-font-size"].value = String(agentSize);
  document.documentElement.style.setProperty("--user-font", userFont.css);
  document.documentElement.style.setProperty("--agent-font", agentFont.css);
  document.documentElement.style.setProperty("--user-font-size", `${userSize}px`);
  document.documentElement.style.setProperty("--agent-font-size", `${agentSize}px`);

  const googleFamilies = [...new Set([userFont.google, agentFont.google].filter(Boolean))];
  if (googleFamilies.length > 0) {
    elements["message-font-stylesheet"].href = `https://fonts.googleapis.com/css2?${googleFamilies.map((family) => `family=${family}`).join("&")}&display=swap`;
  } else {
    elements["message-font-stylesheet"].removeAttribute("href");
  }
  localStorage.setItem("pi-web-user-font", userName);
  localStorage.setItem("pi-web-agent-font", agentName);
  localStorage.setItem("pi-web-user-font-size", String(userSize));
  localStorage.setItem("pi-web-agent-font-size", String(agentSize));
}

async function setModel(provider, modelId) {
  try {
    await sendRequest({ type: "rpc", sessionId: state.selectedId, command: { type: "set_model", provider, modelId } });
  } catch (error) {
    toast(error.message, "error");
  }
}

function conversationRows(messages, partialAssistant, showTools, showThinking) {
  const source = messages.map((message) => ({ message, streaming: false }));
  if (partialAssistant) source.push({ message: partialAssistant, streaming: true });
  if (showTools || !showThinking) return source;

  const rows = [];
  let pendingThinking;
  for (const row of source) {
    const { message } = row;
    if (message.role === "toolResult") continue;
    if (message.role === "assistant" && Array.isArray(message.content)) {
      const latestThinking = message.content.findLast((block) =>
        block.type === "thinking" && Boolean(block.thinking?.trim()));
      const hasText = message.content.some((block) => block.type === "text" && Boolean(block.text?.trim()));
      if (latestThinking && !hasText) {
        pendingThinking = {
          ...row,
          message: { ...message, content: [{ ...latestThinking }] },
        };
        continue;
      }
      if (!hasText) continue;
      if (latestThinking) pendingThinking = undefined;
    }
    if (pendingThinking) {
      rows.push(pendingThinking);
      pendingThinking = undefined;
    }
    rows.push(row);
  }
  if (pendingThinking) rows.push(pendingThinking);
  return rows;
}

function renderConversation(snapshot) {
  const conversation = elements.conversation;
  const nearBottom = conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight < 120;
  const fragment = document.createDocumentFragment();
  for (const { message, streaming } of conversationRows(
    snapshot.messages,
    state.partialAssistant,
    state.showTools,
    state.showThinking,
  )) {
    if (messageIsVisible(message)) fragment.append(renderMessage(message, streaming));
  }
  if (state.showTools) {
    for (const [id, tool] of state.liveTools) fragment.append(renderLiveTool(id, tool));
  }
  const nextThinking = !state.showTools && snapshot.state.isStreaming
    && fragment.lastElementChild?.classList.contains("thinking-only")
    ? fragment.lastElementChild
    : undefined;
  if (nextThinking) {
    nextThinking.classList.add("thinking-active");
    nextThinking.dataset.sessionId = state.selectedId;
    nextThinking.dataset.thinkingGeneration = String(state.thinkingGeneration);
    const currentThinking = conversation.querySelector(":scope > .thinking-active");
    if (
      currentThinking?.dataset.sessionId === nextThinking.dataset.sessionId
      && currentThinking.dataset.thinkingGeneration === nextThinking.dataset.thinkingGeneration
    ) {
      const currentPreview = currentThinking.querySelector(".thinking-preview");
      const nextPreview = nextThinking.querySelector(".thinking-preview");
      currentPreview.textContent = nextPreview.textContent;
      currentPreview.title = nextPreview.title;
      nextThinking.replaceWith(currentThinking);
    } else if (currentThinking) {
      nextThinking.classList.add("thinking-replaced");
    }
  }
  conversation.replaceChildren(fragment);
  if (nearBottom || snapshot.messages.length < 3) conversation.scrollTop = conversation.scrollHeight;
}

function messageIsVisible(message) {
  if (message.role === "toolResult") return state.showTools;
  if (message.role !== "assistant" || !Array.isArray(message.content)) return true;
  return message.content.some((block) =>
    (block.type === "text" && Boolean(block.text?.trim()))
    || (block.type === "thinking" && state.showThinking && Boolean(block.thinking?.trim()))
    || (block.type === "toolCall" && state.showTools));
}

function renderMessage(message, streaming = false) {
  const article = document.createElement("article");
  const role = message.role ?? "custom";
  article.className = `message ${role}`;
  if (role === "assistant" && Array.isArray(message.content)) {
    const hasThinking = message.content.some((block) => block.type === "thinking" && block.thinking?.trim());
    const hasResponse = message.content.some((block) =>
      (block.type === "text" && block.text?.trim()) || (block.type === "toolCall" && state.showTools));
    if (hasThinking && !hasResponse) article.classList.add("thinking-only");
  }
  const avatar = document.createElement("div");
  avatar.className = "avatar";
  avatar.textContent = role === "user" ? "YOU" : role === "assistant" ? "AGENT" : role === "toolResult" ? "TOOL" : "EVENT";
  if (message.timestamp) {
    const time = document.createElement("small");
    time.textContent = new Date(message.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    avatar.append(time);
  }
  const body = document.createElement("div");
  body.className = "message-body";
  const label = document.createElement("div");
  label.className = "message-label";
  label.textContent = role === "assistant" ? "Pi" : role === "toolResult" ? message.toolName || "Tool" : role;
  body.append(label);

  if (role === "assistant") renderAssistantContent(body, message.content, streaming);
  else if (role === "toolResult") body.append(renderToolResult(message));
  else if (role === "bashExecution") body.append(textBlock(`$ ${message.command}\n${message.output ?? ""}`));
  else if (role === "compactionSummary" || role === "branchSummary") body.append(textBlock(message.summary ?? ""));
  else renderGenericContent(body, message.content);

  if (message.timestamp) {
    const meta = document.createElement("div");
    meta.className = "message-meta";
    meta.textContent = new Date(message.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    body.append(meta);
  }
  article.append(avatar, body);
  return article;
}

function renderAssistantContent(body, content, streaming) {
  const blocks = Array.isArray(content) ? content : [{ type: "text", text: String(content ?? "") }];
  for (const block of blocks) {
    if (block.type === "text") {
      const text = markdownBlock(block.text);
      if (streaming) text.classList.add("streaming-caret");
      body.append(text);
    } else if (block.type === "thinking" && state.showThinking) {
      const thought = document.createElement("div");
      thought.className = "thinking-preview";
      thought.textContent = block.thinking;
      thought.title = block.thinking;
      body.append(thought);
    } else if (block.type === "toolCall" && state.showTools) {
      body.append(toolCard(block.name, block.arguments ?? block.input, "Requested"));
    }
  }
}

function renderGenericContent(body, content) {
  if (typeof content === "string") {
    body.append(textBlock(content));
    return;
  }
  for (const block of Array.isArray(content) ? content : []) {
    if (block.type === "text") {
      body.append(textBlock(block.text));
    } else if (block.type === "image" && block.data && block.mimeType) {
      const image = document.createElement("img");
      image.className = "message-image";
      image.src = `data:${block.mimeType};base64,${block.data}`;
      image.alt = "Attached image";
      image.loading = "lazy";
      body.append(image);
    }
  }
}

function renderToolResult(message) {
  const wrapper = document.createElement("div");
  wrapper.className = `tool-result ${message.isError ? "error" : ""}`;
  const content = (message.content ?? []).map((block) => block.type === "text" ? block.text : `[${block.type}]`).join("\n");
  wrapper.append(toolCard(message.toolName, content, message.isError ? "Error" : "Result", message.isError));
  return wrapper;
}

function renderLiveTool(id, tool) {
  const article = document.createElement("article");
  article.className = "message toolResult";
  const avatar = document.createElement("div");
  avatar.className = "avatar";
  avatar.textContent = "TOOL";
  const body = document.createElement("div");
  body.className = "message-body";
  const label = document.createElement("div");
  label.className = "message-label";
  label.textContent = tool.status === "running" ? "Running tool" : "Tool complete";
  body.append(label, toolCard(tool.name || id, tool.result ?? tool.args, tool.status, tool.status === "error"));
  article.append(avatar, body);
  return article;
}

function toolCard(name, value, status, error = false) {
  const details = document.createElement("details");
  details.className = `tool-card ${error ? "error" : ""}`;
  const summary = document.createElement("summary");
  summary.textContent = `${name || "tool"} · ${status}`;
  const pre = document.createElement("pre");
  pre.textContent = typeof value === "string" ? value : JSON.stringify(value ?? {}, null, 2);
  details.append(summary, pre);
  return details;
}

function markdownBlock(value) {
  const block = document.createElement("div");
  block.className = "markdown-block";
  const rendered = marked.parse(value ?? "");
  block.innerHTML = DOMPurify.sanitize(rendered, { USE_PROFILES: { html: true } });
  for (const link of block.querySelectorAll("a")) {
    link.target = "_blank";
    link.rel = "noopener noreferrer";
  }
  return block;
}

function textBlock(value) {
  const block = document.createElement("div");
  block.className = "text-block";
  block.textContent = value ?? "";
  return block;
}

function renderQueue() {
  const steering = state.queues.steering.length;
  const followUp = state.queues.followUp.length;
  const count = steering + followUp;
  elements["queue-bar"].classList.toggle("hidden", count === 0);
  elements["queue-bar"].textContent = `${steering} steering · ${followUp} follow-up queued`;
}

function renderImageTray() {
  const tray = elements["image-tray"];
  tray.replaceChildren();
  for (const pending of state.pendingImages) {
    const item = document.createElement("div");
    item.className = "image-chip";
    const image = document.createElement("img");
    image.src = `data:${pending.mimeType};base64,${pending.data}`;
    image.alt = pending.fileName;
    const details = document.createElement("span");
    details.textContent = `${pending.fileName} · ${formatFileSize(pending.size)}`;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.title = `Remove ${pending.fileName}`;
    remove.setAttribute("aria-label", `Remove ${pending.fileName}`);
    remove.textContent = "×";
    remove.addEventListener("click", () => {
      state.pendingImages = state.pendingImages.filter(({ id }) => id !== pending.id);
      renderImageTray();
    });
    item.append(image, details, remove);
    tray.append(item);
  }
  if (state.imageReads > 0) {
    const loading = document.createElement("div");
    loading.className = "image-loading";
    loading.textContent = `READING ${state.imageReads} IMAGE${state.imageReads === 1 ? "" : "S"}…`;
    tray.append(loading);
  }
  tray.classList.toggle("hidden", state.pendingImages.length === 0 && state.imageReads === 0);
  elements.send.disabled = Boolean(state.snapshot?.state.isCompacting || state.imageReads > 0);
}

function formatFileSize(bytes) {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;
}

function readImageFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const separator = result.indexOf(",");
      if (separator === -1) reject(new Error(`Could not read ${file.name}`));
      else resolve(result.slice(separator + 1));
    });
    reader.addEventListener("error", () => reject(reader.error ?? new Error(`Could not read ${file.name}`)));
    reader.readAsDataURL(file);
  });
}

async function addImageFiles(fileList) {
  if (!state.snapshot?.state.model?.input?.includes("image")) {
    toast("The selected model does not support image input.", "error");
    return;
  }
  const files = Array.from(fileList);
  const slots = MAX_IMAGE_COUNT - state.pendingImages.length - state.imageReads;
  if (slots <= 0) {
    toast(`Attach at most ${MAX_IMAGE_COUNT} images.`, "error");
    return;
  }

  const accepted = [];
  let totalBytes = state.pendingImages.reduce((total, image) => total + image.size, 0) + state.imageReadBytes;
  for (const file of files) {
    if (accepted.length >= slots) {
      toast(`Attach at most ${MAX_IMAGE_COUNT} images.`, "error");
      break;
    }
    if (!SUPPORTED_IMAGE_TYPES.has(file.type)) {
      toast(`${file.name || "Image"} is not a supported PNG, JPEG, WebP, or GIF image.`, "error");
      continue;
    }
    if (file.size > MAX_IMAGE_SIZE) {
      toast(`${file.name} exceeds the ${formatFileSize(MAX_IMAGE_SIZE)} per-image limit.`, "error");
      continue;
    }
    if (totalBytes + file.size > MAX_TOTAL_IMAGE_SIZE) {
      toast(`Attached images exceed the ${formatFileSize(MAX_TOTAL_IMAGE_SIZE)} total limit.`, "error");
      break;
    }
    accepted.push(file);
    totalBytes += file.size;
  }

  state.imageReads += accepted.length;
  state.imageReadBytes += accepted.reduce((total, file) => total + file.size, 0);
  renderImageTray();
  for (const file of accepted) {
    try {
      const data = await readImageFile(file);
      state.pendingImages.push({
        id: crypto.randomUUID(),
        fileName: file.name || `pasted-image.${file.type.split("/")[1]}`,
        mimeType: file.type,
        size: file.size,
        data,
      });
    } catch (error) {
      toast(error.message, "error");
    } finally {
      state.imageReads -= 1;
      state.imageReadBytes -= file.size;
      renderImageTray();
    }
  }
}

async function sendPrompt(mode) {
  const message = elements.prompt.value.trim();
  if ((!message && state.pendingImages.length === 0) || !state.selectedId || !state.snapshot) return;
  if (state.imageReads > 0) {
    toast("Wait for the images to finish loading.", "error");
    return;
  }
  if (state.pendingImages.length > 0 && !state.snapshot.state.model?.input?.includes("image")) {
    toast("The selected model does not support image input.", "error");
    return;
  }

  const type = mode === "follow_up" ? "follow_up" : state.snapshot.state.isStreaming ? "steer" : "prompt";
  const pendingImages = state.pendingImages;
  const images = pendingImages.map(({ data, mimeType }) => ({ type: "image", data, mimeType }));
  elements.prompt.value = "";
  state.pendingImages = [];
  renderImageTray();
  resizePrompt();
  try {
    await sendRequest({
      type: "rpc",
      sessionId: state.selectedId,
      command: { type, message, ...(images.length > 0 ? { images } : {}) },
    });
  } catch (error) {
    elements.prompt.value = message;
    state.pendingImages = [...pendingImages, ...state.pendingImages];
    renderImageTray();
    resizePrompt();
    toast(error.message, "error");
  }
}

function resizePrompt() {
  elements.prompt.style.height = "auto";
  elements.prompt.style.height = `${Math.min(elements.prompt.scrollHeight, 220)}px`;
}

function matchingPaletteCommands() {
  const terms = elements["command-palette-input"].value.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return COMMANDS.filter((command) => {
    const text = `${command.title} ${command.description} ${command.category} ${command.keywords}`.toLocaleLowerCase();
    return terms.every((term) => text.includes(term));
  });
}

function showCommandPalette() {
  const dialog = elements["command-palette-dialog"];
  if (dialog.open) return;
  if (document.querySelector("dialog[open]")) return;
  elements["command-palette-input"].value = "";
  state.commandPaletteSelection = 0;
  renderCommandPalette();
  dialog.showModal();
  elements["command-palette-input"].focus();
}

function renderCommandPalette() {
  const commands = matchingPaletteCommands();
  const results = elements["command-palette-results"];
  results.replaceChildren();
  state.commandPaletteSelection = Math.max(0, Math.min(state.commandPaletteSelection, commands.length - 1));
  elements["command-palette-count"].textContent = `${commands.length} / ${COMMANDS.length}`;
  if (commands.length === 0) {
    const empty = document.createElement("div");
    empty.className = "command-palette-empty";
    empty.textContent = "NO MATCHING COMMANDS";
    results.append(empty);
    return;
  }
  commands.forEach((command, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `command-palette-command ${index === state.commandPaletteSelection ? "selected" : ""}`;
    button.dataset.commandId = command.id;
    button.setAttribute("role", "option");
    button.setAttribute("aria-selected", String(index === state.commandPaletteSelection));
    const icon = document.createElement("i");
    icon.textContent = command.icon;
    const copy = document.createElement("span");
    const title = document.createElement("strong");
    title.textContent = command.title;
    const description = document.createElement("small");
    description.textContent = command.description;
    copy.append(title, description);
    const category = document.createElement("em");
    category.textContent = command.category;
    button.append(icon, copy, category);
    button.addEventListener("mousemove", () => {
      if (state.commandPaletteSelection === index) return;
      state.commandPaletteSelection = index;
      updateCommandPaletteSelection();
    });
    button.addEventListener("click", () => runPaletteCommand(command));
    results.append(button);
  });
}

function updateCommandPaletteSelection() {
  const buttons = [...elements["command-palette-results"].querySelectorAll(".command-palette-command")];
  buttons.forEach((button, index) => {
    const selected = index === state.commandPaletteSelection;
    button.classList.toggle("selected", selected);
    button.setAttribute("aria-selected", String(selected));
  });
  buttons[state.commandPaletteSelection]?.scrollIntoView({ block: "nearest" });
}

function runPaletteCommand(command) {
  elements["command-palette-dialog"].close();
  command.action();
}

function showSessionSearch() {
  clearTimeout(state.sessionSearchTimer);
  state.sessionSearchGeneration += 1;
  elements["session-search-input"].value = "";
  elements["session-search-results"].replaceChildren();
  elements["session-search-status"].textContent = "SEARCHING PI SESSIONS…";
  elements["session-search-dialog"].showModal();
  elements["session-search-input"].focus();
  void searchSessions();
}

async function searchSessions() {
  const generation = ++state.sessionSearchGeneration;
  const query = elements["session-search-input"].value.trim();
  elements["session-search-status"].textContent = "SEARCHING PI SESSIONS…";
  try {
    const response = await sendRequest({ type: "search_sessions", query }, 60_000);
    if (generation !== state.sessionSearchGeneration) return;
    renderSessionSearchResults(response.sessions);
  } catch (error) {
    if (generation !== state.sessionSearchGeneration) return;
    elements["session-search-status"].textContent = error.message;
    elements["session-search-results"].replaceChildren();
  }
}

function renderSessionSearchResults(sessions) {
  const results = elements["session-search-results"];
  results.replaceChildren();
  elements["session-search-status"].textContent = sessions.length === 0
    ? "NO MATCHING PI SESSIONS"
    : `${sessions.length} SESSION${sessions.length === 1 ? "" : "S"} FOUND`;
  for (const session of sessions) {
    const item = document.createElement("div");
    item.className = `session-search-item ${session.cwdExists ? "" : "unavailable"}`;
    const title = document.createElement("strong");
    title.textContent = session.displayName;
    const meta = document.createElement("div");
    meta.className = "search-meta";
    const updated = new Date(session.updatedAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
    meta.textContent = `${updated} · ${session.model ?? "unknown model"} · ${session.cwd}`;
    const snippet = document.createElement("div");
    snippet.className = "search-snippet";
    snippet.textContent = session.snippet || session.id;
    const actions = document.createElement("div");
    actions.className = "search-actions";
    const resume = document.createElement("button");
    resume.type = "button";
    resume.textContent = session.managed ? "OPEN" : "RESUME";
    resume.disabled = !session.cwdExists;
    resume.title = session.cwdExists ? "" : "The original working directory no longer exists";
    resume.addEventListener("click", async () => {
      resume.disabled = true;
      resume.textContent = "OPENING…";
      try {
        if (session.managed) await openSession(session.id);
        else await sendRequest({ type: "import_session", sessionFile: session.sessionFile }, 60_000);
        elements["session-search-dialog"].close();
      } catch (error) {
        resume.disabled = false;
        resume.textContent = session.managed ? "OPEN" : "RESUME";
        toast(error.message, "error");
      }
    });
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "icon-delete";
    remove.title = `Delete ${session.displayName}`;
    remove.setAttribute("aria-label", remove.title);
    remove.append(trashIcon());
    remove.addEventListener("click", () => showDeleteSessionDialog({
      sessionId: session.id,
      sessionFile: session.sessionFile,
      name: session.displayName,
    }));
    actions.append(resume, remove);
    item.append(title, meta, snippet, actions);
    results.append(item);
  }
}

function showDeleteSessionDialog(target) {
  if (!target?.sessionId || !target.sessionFile) return;
  state.deleteTarget = target;
  elements["delete-session-name"].textContent = target.name;
  elements["delete-session-error"].textContent = "";
  elements["confirm-delete-session"].disabled = false;
  elements["delete-session-dialog"].showModal();
}

async function deleteTargetSession() {
  const target = state.deleteTarget;
  if (!target) return;
  elements["confirm-delete-session"].disabled = true;
  elements["delete-session-error"].textContent = "";
  try {
    await sendRequest({
      type: "delete_session",
      sessionId: target.sessionId,
      sessionFile: target.sessionFile,
    }, 60_000);
    if (elements["session-search-dialog"].open) await searchSessions();
  } catch (error) {
    elements["confirm-delete-session"].disabled = false;
    elements["delete-session-error"].textContent = error.message;
  }
}

function showNewDialog() {
  elements["new-error"].textContent = "";
  elements["cwd-input"].value = localStorage.getItem("pi-web-last-cwd") ?? "";
  elements["name-input"].value = "";
  elements["new-dialog"].showModal();
  elements["cwd-input"].focus();
}

function showDirectoryPicker() {
  elements["directory-error"].textContent = "";
  elements["directory-list"].replaceChildren();
  elements["directory-dialog"].showModal();
  void browseDirectories(elements["cwd-input"].value.trim());
}

async function browseDirectories(path) {
  const generation = ++state.directoryBrowseGeneration;
  state.currentDirectory = undefined;
  state.parentDirectory = undefined;
  elements["directory-path"].value = path;
  elements["directory-count"].textContent = "LOADING…";
  elements["directory-error"].textContent = "";
  elements["directory-up"].disabled = true;
  elements["select-directory"].disabled = true;
  elements["directory-list"].setAttribute("aria-busy", "true");
  try {
    const response = await sendRequest({ type: "browse_directories", path }, 60_000);
    if (generation !== state.directoryBrowseGeneration) return;
    state.currentDirectory = response.path;
    state.parentDirectory = response.parent;
    elements["directory-path"].value = response.path;
    elements["directory-up"].disabled = !response.parent;
    elements["select-directory"].disabled = false;
    elements["directory-count"].textContent = `${response.directories.length} DIRECTOR${response.directories.length === 1 ? "Y" : "IES"}`;
    const fragment = document.createDocumentFragment();
    for (const directory of response.directories) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "directory-entry";
      const marker = document.createElement("i");
      marker.textContent = "▸";
      const name = document.createElement("span");
      name.textContent = directory.name;
      button.append(marker, name);
      button.addEventListener("click", () => void browseDirectories(directory.path));
      fragment.append(button);
    }
    elements["directory-list"].replaceChildren(fragment);
  } catch (error) {
    if (generation !== state.directoryBrowseGeneration) return;
    elements["directory-count"].textContent = "UNAVAILABLE";
    elements["directory-list"].replaceChildren();
    elements["directory-error"].textContent = error.message;
  } finally {
    if (generation === state.directoryBrowseGeneration) elements["directory-list"].removeAttribute("aria-busy");
  }
}

function selectCurrentDirectory() {
  if (!state.currentDirectory) return;
  elements["cwd-input"].value = state.currentDirectory;
  elements["directory-dialog"].close();
  elements["name-input"].focus();
}

async function createSession() {
  const cwd = elements["cwd-input"].value.trim();
  const name = elements["name-input"].value.trim();
  if (!cwd) return;
  elements["create-session"].disabled = true;
  elements["new-error"].textContent = "";
  try {
    await sendRequest({ type: "create_session", cwd, name, approveProject: elements["approve-input"].checked }, 60_000);
    localStorage.setItem("pi-web-last-cwd", cwd);
    elements["new-dialog"].close();
  } catch (error) {
    elements["new-error"].textContent = error.message;
  } finally {
    elements["create-session"].disabled = false;
  }
}

function handleExtensionRequest(request) {
  const scopedRequest = request.sessionId ? request : { ...request, sessionId: state.selectedId };
  if (["notify", "setStatus", "setWidget", "setTitle", "set_editor_text"].includes(scopedRequest.method)) {
    if (scopedRequest.method === "notify") toast(scopedRequest.message, scopedRequest.notifyType === "error" ? "error" : "info");
    if (scopedRequest.method === "setStatus") {
      if (scopedRequest.statusText) state.statuses.set(scopedRequest.statusKey, scopedRequest.statusText);
      else state.statuses.delete(scopedRequest.statusKey);
    }
    if (scopedRequest.method === "setWidget" && scopedRequest.widgetLines?.length) toast(scopedRequest.widgetLines.join("\n"));
    if (scopedRequest.method === "setTitle" && scopedRequest.title) document.title = scopedRequest.title;
    if (scopedRequest.method === "set_editor_text") {
      elements.prompt.value = scopedRequest.text;
      resizePrompt();
    }
    scheduleRender();
    return;
  }

  if (state.pendingExtension) {
    state.extensionQueue.push(scopedRequest);
    return;
  }
  state.pendingExtension = scopedRequest;
  elements["extension-title"].textContent = scopedRequest.title || "Pi needs input";
  elements["extension-message"].textContent = scopedRequest.message || "";
  const field = elements["extension-field"];
  field.replaceChildren();
  if (scopedRequest.method === "select") {
    const select = document.createElement("select");
    select.id = "extension-value";
    for (const value of scopedRequest.options) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = value;
      select.append(option);
    }
    field.append(select);
  } else if (scopedRequest.method === "input" || scopedRequest.method === "editor") {
    const input = scopedRequest.method === "editor" ? document.createElement("textarea") : document.createElement("input");
    input.id = "extension-value";
    input.value = scopedRequest.prefill ?? "";
    input.placeholder = scopedRequest.placeholder ?? "";
    field.append(input);
  }
  elements["extension-dialog"].showModal();
}

function answerExtension(cancelled) {
  const request = state.pendingExtension;
  if (!request?.sessionId) return;
  const field = document.getElementById("extension-value");
  const message = {
    type: "extension_ui_response",
    sessionId: request.sessionId,
    id: request.id,
    ...(cancelled ? { cancelled: true } : request.method === "confirm" ? { confirmed: true } : { value: field?.value ?? "" }),
  };
  state.socket.send(JSON.stringify(message));
  state.pendingExtension = undefined;
  elements["extension-dialog"].close();
  const next = state.extensionQueue.shift();
  if (next) setTimeout(() => handleExtensionRequest(next), 0);
}

elements["login-form"].addEventListener("submit", (event) => {
  event.preventDefault();
  localStorage.setItem("pi-web-token", elements["token-input"].value.trim());
  elements["login-error"].textContent = "";
  state.manuallyDisconnected = true;
  state.socket?.close();
  setTimeout(connect, 50);
});
elements["command-palette-trigger"].addEventListener("click", showCommandPalette);
elements["command-palette-dialog"].addEventListener("click", (event) => {
  if (event.target === elements["command-palette-dialog"]) elements["command-palette-dialog"].close();
});
elements["command-palette-input"].addEventListener("input", () => {
  state.commandPaletteSelection = 0;
  renderCommandPalette();
});
elements["command-palette-input"].addEventListener("keydown", (event) => {
  const commands = matchingPaletteCommands();
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    if (commands.length === 0) return;
    const direction = event.key === "ArrowDown" ? 1 : -1;
    state.commandPaletteSelection = (state.commandPaletteSelection + direction + commands.length) % commands.length;
    updateCommandPaletteSelection();
  } else if (event.key === "Enter" && commands[state.commandPaletteSelection]) {
    event.preventDefault();
    runPaletteCommand(commands[state.commandPaletteSelection]);
  }
});
document.addEventListener("keydown", (event) => {
  if (event.isComposing || event.key.toLocaleLowerCase() !== COMMAND_PALETTE_KEY || (!event.metaKey && !event.ctrlKey)) return;
  event.preventDefault();
  if (!elements.login.classList.contains("hidden")) return;
  if (elements["command-palette-dialog"].open) elements["command-palette-dialog"].close();
  else showCommandPalette();
});
elements["empty-new-session"].addEventListener("click", showNewDialog);
elements["session-search-close"].addEventListener("click", () => elements["session-search-dialog"].close());
elements["session-search-input"].addEventListener("input", () => {
  clearTimeout(state.sessionSearchTimer);
  state.sessionSearchTimer = setTimeout(() => void searchSessions(), 250);
});
elements["session-search-dialog"].addEventListener("close", () => {
  clearTimeout(state.sessionSearchTimer);
  state.sessionSearchGeneration += 1;
});
elements["browse-cwd"].addEventListener("click", showDirectoryPicker);
elements["directory-up"].addEventListener("click", () => {
  if (state.parentDirectory) void browseDirectories(state.parentDirectory);
});
elements["directory-form"].addEventListener("submit", (event) => {
  event.preventDefault();
  if (event.submitter?.value === "cancel") elements["directory-dialog"].close();
  else if (event.submitter === elements["select-directory"]) selectCurrentDirectory();
  else void browseDirectories(elements["directory-path"].value.trim());
});
elements["directory-dialog"].addEventListener("close", () => {
  state.directoryBrowseGeneration += 1;
});
elements["new-form"].addEventListener("submit", (event) => {
  event.preventDefault();
  if (event.submitter?.value === "cancel") elements["new-dialog"].close();
  else void createSession();
});
elements["session-title"].addEventListener("dblclick", beginSessionTitleEdit);
elements["session-title"].addEventListener("blur", () => void commitSessionTitleEdit());
elements["session-title"].addEventListener("keydown", (event) => {
  if (!state.sessionTitleEditing) return;
  if (event.key === "Enter") {
    event.preventDefault();
    elements["session-title"].blur();
  } else if (event.key === "Escape") {
    event.preventDefault();
    cancelSessionTitleEdit();
    elements["session-title"].blur();
  }
});
elements["sidebar-toggle"].addEventListener("click", () => {
  elements.app.classList.remove("sidebar-collapsed");
  if (matchMedia("(max-width: 900px)").matches) elements.sidebar.classList.add("open");
});
elements["sidebar-collapse"].addEventListener("click", () => {
  if (matchMedia("(max-width: 900px)").matches) elements.sidebar.classList.remove("open");
  else elements.app.classList.add("sidebar-collapsed");
});
elements["details-toggle"].addEventListener("click", () => elements["details-panel"].classList.toggle("open"));
elements["details-collapse"].addEventListener("click", () => elements["details-panel"].classList.remove("open"));
document.addEventListener("pointerdown", (event) => {
  if (
    elements["details-panel"].classList.contains("open")
    && !elements["details-panel"].contains(event.target)
    && !elements["details-toggle"].contains(event.target)
  ) {
    elements["details-panel"].classList.remove("open");
  }
});
elements["delete-session-form"].addEventListener("submit", (event) => {
  event.preventDefault();
  if (event.submitter?.value === "cancel") elements["delete-session-dialog"].close();
  else void deleteTargetSession();
});
elements["delete-session-dialog"].addEventListener("close", () => {
  state.deleteTarget = undefined;
});
elements["theme-toggle"].addEventListener("click", () => {
  const current = document.documentElement.dataset.theme || "dark";
  applyTheme(THEMES[(THEMES.indexOf(current) + 1) % THEMES.length]);
});
elements["image-picker"].addEventListener("click", () => elements["image-input"].click());
elements["image-input"].addEventListener("change", () => {
  void addImageFiles(elements["image-input"].files ?? []);
  elements["image-input"].value = "";
});
elements.prompt.addEventListener("paste", (event) => {
  const files = [...(event.clipboardData?.items ?? [])]
    .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter(Boolean);
  if (files.length === 0) return;
  event.preventDefault();
  void addImageFiles(files);
});
elements.composer.addEventListener("dragover", (event) => {
  if (!event.dataTransfer?.types.includes("Files")) return;
  event.preventDefault();
  elements.composer.classList.add("drop-active");
});
elements.composer.addEventListener("dragleave", (event) => {
  if (!elements.composer.contains(event.relatedTarget)) elements.composer.classList.remove("drop-active");
});
elements.composer.addEventListener("drop", (event) => {
  elements.composer.classList.remove("drop-active");
  if (!event.dataTransfer?.files.length) return;
  event.preventDefault();
  void addImageFiles(event.dataTransfer.files);
});
elements.prompt.addEventListener("input", resizePrompt);
elements.prompt.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    void sendPrompt("default");
  }
});
elements.send.addEventListener("click", () => void sendPrompt("default"));
elements["send-follow-up"].addEventListener("click", () => void sendPrompt("follow_up"));
elements.abort.addEventListener("click", async () => {
  try {
    await sendRequest({ type: "rpc", sessionId: state.selectedId, command: { type: "abort" } });
  } catch (error) {
    toast(error.message, "error");
  }
});
elements["thinking-select"].addEventListener("change", async () => {
  try {
    await sendRequest({
      type: "rpc",
      sessionId: state.selectedId,
      command: { type: "set_thinking_level", level: elements["thinking-select"].value },
    });
  } catch (error) {
    toast(error.message, "error");
  }
});
for (const id of ["show-tools", "tool-toggle"]) {
  elements[id].addEventListener("click", () => {
    state.showTools = !state.showTools;
    scheduleRender();
  });
}
elements["show-thinking"].addEventListener("click", () => {
  state.showThinking = !state.showThinking;
  scheduleRender();
});
elements["auto-compaction"].addEventListener("click", async () => {
  if (!state.snapshot || !state.selectedId) return;
  const enabled = !state.snapshot.state.autoCompactionEnabled;
  try {
    await sendRequest({
      type: "rpc",
      sessionId: state.selectedId,
      command: { type: "set_auto_compaction", enabled },
    });
    state.snapshot.state.autoCompactionEnabled = enabled;
    scheduleRender();
  } catch (error) {
    toast(error.message, "error");
  }
});
for (const id of ["user-font", "agent-font"]) {
  elements[id].addEventListener("change", () => {
    applyMessageFonts();
    elements[id].reportValidity();
  });
}
for (const id of ["user-font-size", "agent-font-size"]) {
  elements[id].addEventListener("input", applyMessageFonts);
}
elements["extension-form"].addEventListener("submit", (event) => {
  event.preventDefault();
  answerExtension(event.submitter?.value === "cancel");
});
elements["extension-dialog"].addEventListener("cancel", (event) => {
  event.preventDefault();
  answerExtension(true);
});

applyTheme(localStorage.getItem("pi-web-theme") ?? "dark");
initializeFontTester();
connect();
