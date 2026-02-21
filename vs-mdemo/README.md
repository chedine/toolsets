# MD Presenter

A VSCode extension that presents a Markdown file as slides — one at a time, like a lightweight PowerPoint.

## Usage

Right-click any `.md` file in the Explorer or editor → **Present**.

Navigate with arrow keys, Space, or the Prev / Next buttons. Export to PDF via the footer button.

---

## Slide format

Slides are separated by `---`. The file opens with a frontmatter block (also delimited by `---`) that sets global styles.

```
---
bgColor  : "#1a1a2e"
color    : "#e8e8e8"
titleColor: "#7eb8f7"
font     : "SF Mono"
fontSize : "24"
---

# Slide 1
- Bullet point
    - Nested bullet
- Another point

---

# Slide 2
> A blockquote

\```js
function hello() { return "world"; }
\```
```

### Frontmatter keys

| Key          | Description                          | Default       |
|--------------|--------------------------------------|---------------|
| `bgColor`    | Slide background color               | `#1a1a2e`     |
| `color`      | Body text color                      | `#e8e8e8`     |
| `titleColor` | Heading color (falls back to `color`)| —             |
| `font`       | Font family                          | `sans-serif`  |
| `fontSize`   | Base font size in px                 | `24`          |

### Supported Markdown

- Headings `#` through `######`
- Unordered (`-`, `*`) and ordered (`1.`) lists, arbitrarily nested
- Blockquotes `>`
- Fenced code blocks (` ``` ` or `~~~`), including inside list items
- Inline **bold**, *italic*, `code`

---

## Install

Requires [Node.js](https://nodejs.org) and `vsce`:

```bash
npm install -g @vscode/vsce
```

Then from this folder:

```bash
vsce package
code --install-extension md-presenter-0.0.1.vsix
```

Reload VSCode (`Ctrl+Shift+P` → **Developer: Reload Window**).

---

## Update

1. Make your changes to `src/extension.js` or `package.json`
2. Bump `"version"` in `package.json` (e.g. `"0.0.2"`)
3. Repackage and reinstall:

```bash
vsce package
code --install-extension md-presenter-0.0.3.vsix
```

4. Reload VSCode (`Ctrl+Shift+P` → **Developer: Reload Window**)
