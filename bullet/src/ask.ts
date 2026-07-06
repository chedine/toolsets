import { CreateMLCEngine, type MLCEngine } from "@mlc-ai/web-llm";
import { query, type SearchHit } from "./search";

// `ask <question>`: local RAG. Hybrid retrieval picks the most
// relevant note sections, a small local model (WebGPU, downloaded once
// and cached by the browser) answers strictly from them. No API calls.

const MODEL = "Qwen2.5-1.5B-Instruct-q4f16_1-MLC";
const CONTEXT_CHUNKS = 6;

const SYSTEM = `You answer questions about the user's personal notes.
Answer in 2-5 plain, complete sentences using only facts from the
provided note excerpts. Do not output citation markers or lists of
references. If the excerpts do not contain the answer, say plainly
that the notes don't cover it.`;

let enginePromise: Promise<MLCEngine> | null = null;

function ensureEngine(notify: (msg: string) => void): Promise<MLCEngine> {
  enginePromise ??= CreateMLCEngine(MODEL, {
    initProgressCallback: (p) => {
      notify(`loading model… ${Math.round(p.progress * 100)}%`);
    },
  }).catch((err) => {
    enginePromise = null; // allow retry
    throw err;
  });
  return enginePromise;
}

export interface AskContext {
  notify(msg: string): void;
  openAt(path: string, line: number): void;
}

export async function ask(question: string, ctx: AskContext): Promise<void> {
  if (!("gpu" in navigator)) {
    throw new Error("WebGPU not available in this browser");
  }
  const hits = (await query(question)).slice(0, CONTEXT_CHUNKS);
  if (hits.length === 0) throw new Error("no relevant notes found");

  const popup = showAskPopup(question, hits, ctx.openAt);
  try {
    const engine = await ensureEngine(ctx.notify);
    if (popup.closed) return;

    const context = hits
      .map((h) => `From ${h.path}${h.section ? ` (${h.section})` : ""}:\n${h.text}`)
      .join("\n\n");
    const stream = await engine.chat.completions.create({
      stream: true,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: `Note excerpts:\n\n${context}\n\nQuestion: ${question}` },
      ],
      temperature: 0.2,
      max_tokens: 400,
    });
    popup.setAnswer("");
    let answer = "";
    for await (const part of stream) {
      if (popup.closed) {
        void engine.interruptGenerate();
        return;
      }
      answer += part.choices[0]?.delta?.content ?? "";
      popup.setAnswer(answer);
    }
  } catch (err) {
    popup.setAnswer(`failed: ${(err as Error).message}`);
    throw err;
  }
}

interface AskPopup {
  setAnswer(text: string): void;
  closed: boolean;
}

function showAskPopup(
  question: string,
  hits: SearchHit[],
  openAt: (path: string, line: number) => void,
): AskPopup {
  document.getElementById("ask-popup")?.remove();
  const popup = document.createElement("div");
  popup.id = "ask-popup";

  const q = document.createElement("div");
  q.className = "ask-question";
  q.textContent = question;
  const answer = document.createElement("div");
  answer.className = "ask-answer";
  answer.textContent = "thinking…";
  const sources = document.createElement("div");
  sources.className = "ask-sources";
  let selected = -1;
  const rows = hits.map((hit, i) => {
    const row = document.createElement("div");
    row.className = "ask-source";
    row.textContent = `[${i + 1}] ${hit.path}${hit.section ? ` — ${hit.section}` : ""}`;
    row.addEventListener("click", () => open(i));
    row.addEventListener("mousemove", () => select(i));
    sources.appendChild(row);
    return row;
  });
  popup.append(q, answer, sources);

  function select(i: number): void {
    rows[selected]?.classList.remove("selected");
    selected = i;
    rows[selected]?.classList.add("selected");
    rows[selected]?.scrollIntoView({ block: "nearest" });
  }

  function open(i: number): void {
    dismiss();
    openAt(hits[i].path, hits[i].line);
  }

  const state: AskPopup = {
    closed: false,
    setAnswer(text: string) {
      answer.textContent = text || "…";
    },
  };

  const dismiss = () => {
    state.closed = true;
    popup.remove();
    window.removeEventListener("keydown", onKey, true);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      dismiss();
    } else if (e.key === "ArrowDown" || (e.key === "n" && e.ctrlKey)) {
      e.preventDefault();
      e.stopPropagation();
      select(Math.min(selected + 1, hits.length - 1));
    } else if (e.key === "ArrowUp" || (e.key === "p" && e.ctrlKey)) {
      e.preventDefault();
      e.stopPropagation();
      select(Math.max(selected - 1, 0));
    } else if (e.key === "Enter" && selected >= 0) {
      e.preventDefault();
      e.stopPropagation();
      open(selected);
    }
  };
  window.addEventListener("keydown", onKey, true);
  document.body.appendChild(popup);
  return state;
}
