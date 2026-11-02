# Margin tutor

Tell it what you want to learn; it drafts a course outline you can edit, then writes each chapter when you open it: a short lesson followed by practice questions. Five question types:

| Type | Answered with | Checked by |
| --- | --- | --- |
| Multiple choice | buttons | the browser |
| Fill in the blanks | inline inputs | the browser (accepted answers, numeric equivalence) |
| Free-form | text | the model, against a rubric |
| Math | [MathLive](https://cortexjs.io/mathlive/) math fields: optional working, one step per line, plus a final answer | an exact match is accepted instantly; anything else goes to the model, which checks the steps |
| Python | a code editor | AI-written `test_*` functions, run in the browser by [Pyodide](https://pyodide.org) |

Every question has an **Ask tutor** button: a chat thread per question (or per lesson) that sees the question, the intended solution and your current answer, and gives hints before solutions. The tutor can also **change the course**: "3 more questions like this", "rewrite the lesson more simply", "add a chapter on X".

It's built for a household: **profiles** (each with their own notebooks, XP, level and daily streak), and the tutor pitches its words and examples to each profile's "about" text. Hints are free and never cost points. Confetti is optional.

## Run

```bash
python3 server.py                 # http://127.0.0.1:8585, notebooks in ~/Tutor
python3 server.py --data ~/Tutor --host 0.0.0.0 --port 8585
```

Standard library only (Python 3.9+). The page loads KaTeX, marked, DOMPurify, MathLive, canvas-confetti and Pyodide from CDNs.

## Models: no extra cost

There is no API key anywhere. Every model call runs a CLI you are already logged into, one stateless turn at a time, with tools, MCP servers, skills and session history all disabled:

- **`claude:<model>`** (haiku, sonnet, opus) runs **Claude Code headless** (`claude -p`) on your Claude subscription. `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` are stripped from its environment, so it can never fall back to paid API billing. Claude is always reached this way: Pi's own `anthropic` provider is hidden (`hide_pi_providers`).
- **`pi:<provider>/<model>`** runs `pi -p` with whatever Pi is logged into (Codex, Gemini, local LM Studio models...), the same way tidbits' Ask does.

Each task has its own model, effort and timeout, set on the **Settings** page:

| Task | Default | Used for |
| --- | --- | --- |
| `outline` | `claude:sonnet` | drafting the course outline |
| `chapter` | `claude:sonnet` | lessons, questions, and the tutor's course changes |
| `grade` | `claude:haiku` | free-form and math grading |
| `tutor` | `claude:haiku` | tutor chat |

Effort maps to `claude --effort` (low ... max) or `pi --thinking` (off ... xhigh).

## Configuration

Everything is configurable, and your edits live in the data folder, so they survive app updates:

- `config.default.json` holds the shipped defaults. `<data>/config.json` is deep-merged over it (the Settings page writes it): models per task, Claude aliases, chapters and questions per course, depths, XP values, confetti, suggestions, and the CLI paths (`claude_bin`, `pi_bin`).
- `prompts/*.md` holds the prompt templates (`outline`, `chapter`, `more_questions`, `rewrite_lesson`, `grade`, `tutor`, and `question_schema`, which is shared by the chapter prompts). A file with the same name in `<data>/prompts/` replaces the shipped one; edit them on the Settings page. `{{placeholders}}` such as `{{learner}}` are filled in by the app.

| Flag / env | Default |
| --- | --- |
| `--data` / `TUTOR_DATA` | `~/Tutor` |
| `--host` / `TUTOR_HOST` | `host` in config (`127.0.0.1`) |
| `--port` / `TUTOR_PORT` | `port` in config (`8585`) |

## Notebooks on disk

```
~/Tutor/
  config.json, prompts/          your settings overrides
  profiles.json                  learners, XP, active days
  courses/<course-id>/
    course.json                  title, outline, per-chapter progress
    <chapter-id>.json            lesson, questions, answers, grades, hints used, tutor threads
```

Plain JSON with atomic writes, so the folder is safe to back up or put under git. Lessons the tutor rewrote keep their previous versions in `lesson_history`.

## How a course adapts

Chapters are written lazily. When you open chapter 3, its prompt includes the concepts you got wrong in chapters 1-2, so they get reinforced. Outline edits (rename, reorder, add, remove) are allowed at any time; removing a chapter that has already been written deletes its notebook file, and the app asks first.

## Tests

```bash
python3 -m unittest discover tests
```
