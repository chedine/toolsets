import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const cssPath = new URL("../public/styles.css", import.meta.url);
const appPath = new URL("../public/app.js", import.meta.url);
const htmlPath = new URL("../public/index.html", import.meta.url);
const serverPath = new URL("../src/server.js", import.meta.url);
const packagePath = new URL("../package.json", import.meta.url);

test("conversation overflow stays inside the viewport above the composer", async () => {
  const css = await readFile(cssPath, "utf8");
  const mainRule = css.match(/\.main\s*\{([^}]+)\}/)?.[1] ?? "";
  assert.match(mainRule, /min-height:\s*0/);
  assert.match(mainRule, /overflow:\s*hidden/);
  assert.match(mainRule, /grid-template-rows:\s*auto minmax\(0, 1fr\) auto/);
});

test("sidebar branding has no workspace path and collapse preserves the main column", async () => {
  const [css, app, html] = await Promise.all([
    readFile(cssPath, "utf8"),
    readFile(appPath, "utf8"),
    readFile(htmlPath, "utf8"),
  ]);
  assert.doesNotMatch(html, /NEUROCLAMP/);
  assert.doesNotMatch(html, /id="sidebar-cwd"/);
  assert.doesNotMatch(app, /sidebar-cwd/);
  assert.match(html, /<div class="wordmark"><i><\/i>HARNESS<\/div>/);
  assert.match(css, /\.app-shell\.sidebar-collapsed\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/s);
  assert.doesNotMatch(css, /\.app-shell\.sidebar-collapsed\s*\{[^}]*--sidebar-width:\s*0px/s);
});

test("sidebar status and ledger stay inside the panel", async () => {
  const [css, html] = await Promise.all([readFile(cssPath, "utf8"), readFile(htmlPath, "utf8")]);
  assert.match(css, /\.sidebar-scroll\s*\{[^}]*overflow-x:\s*hidden/s);
  assert.match(css, /\.connection\s*\{[^}]*flex:\s*none[^}]*white-space:\s*nowrap/s);
  assert.match(css, /\.ledger-summary\s*\{[^}]*width:\s*calc\(100% - 32px\)[^}]*max-width:\s*calc\(100% - 32px\)/s);
  assert.match(css, /\.context-row span:last-child\s*\{[^}]*flex:\s*none[^}]*white-space:\s*nowrap/s);
  assert.match(css, /\.stats-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) minmax\(0, 1fr\)/s);
  assert.match(html, /href="\/styles\.css\?v=[^"]+"/);
});

test("cyberpunk harness provides persistent dark, light, and nordic themes", async () => {
  const [css, app, html] = await Promise.all([
    readFile(cssPath, "utf8"),
    readFile(appPath, "utf8"),
    readFile(htmlPath, "utf8"),
  ]);
  assert.match(css, /--bg:\s*#07080d/);
  assert.match(css, /:root\[data-theme='light'\]/);
  assert.match(css, /:root\[data-theme='nordic'\]/);
  assert.match(html, /id="theme-toggle"/);
  assert.match(app, /const THEMES = \["dark", "light", "nordic"\]/);
  assert.match(app, /localStorage\.setItem\("pi-web-theme", selected\)/);
});

test("transcript uses the harness flow layout and compact thinking previews", async () => {
  const [css, app] = await Promise.all([readFile(cssPath, "utf8"), readFile(appPath, "utf8")]);
  assert.match(css, /\.message\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/s);
  const messageBodyRule = css.match(/\.message-body\s*\{([^}]+)\}/)?.[1] ?? "";
  assert.doesNotMatch(messageBodyRule, /border-left/);
  assert.match(css, /\.thinking-preview\s*\{[^}]*-webkit-line-clamp:\s*2/s);
  assert.match(app, /role === "user" \? "YOU" : role === "assistant" \? "AGENT"/);
  assert.match(app, /showTools:\s*false/);
  assert.match(app, /conversationRows\([\s\S]*state\.showTools,[\s\S]*state\.showThinking/);
  assert.match(app, /let pendingThinking;/);
  assert.match(app, /if \(latestThinking && !hasText\) \{[\s\S]*pendingThinking =/);
  assert.match(app, /message: \{ \.\.\.message, content: \[\{ \.\.\.latestThinking \}\] \}/);
  assert.match(app, /if \(messageIsVisible\(message\)\) fragment\.append\(renderMessage\(message, streaming\)\)/);
});

test("active thinking uses persistent motion and animates thought replacement", async () => {
  const [css, app] = await Promise.all([readFile(cssPath, "utf8"), readFile(appPath, "utf8")]);
  assert.match(css, /\.message\.thinking-active \.message-body::after/);
  assert.match(css, /animation:\s*thinking-sweep/);
  assert.match(css, /\.message\.thinking-replaced\s*\{[^}]*animation:\s*thinking-replace/s);
  assert.match(css, /@media \(prefers-reduced-motion:\s*reduce\)/);
  assert.match(app, /dataset\.thinkingGeneration = String\(state\.thinkingGeneration\)/);
  assert.match(app, /nextThinking\.replaceWith\(currentThinking\)/);
  assert.match(app, /nextThinking\.classList\.add\("thinking-replaced"\)/);
});

test("session title supports inline rename", async () => {
  const [css, app, html] = await Promise.all([
    readFile(cssPath, "utf8"),
    readFile(appPath, "utf8"),
    readFile(htmlPath, "utf8"),
  ]);
  assert.match(html, /id="session-title"/);
  assert.match(app, /addEventListener\("dblclick", beginSessionTitleEdit\)/);
  assert.match(app, /setAttribute\("contenteditable", "plaintext-only"\)/);
  assert.match(app, /command: \{ type: "set_session_name", name \}/);
  assert.match(app, /event\.key === "Enter"/);
  assert.match(app, /event\.key === "Escape"/);
  assert.match(css, /\.session-heading strong\.editing/);
});

test("agent Markdown is rendered through pinned libraries and sanitized", async () => {
  const [css, app, server, packageSource] = await Promise.all([
    readFile(cssPath, "utf8"),
    readFile(appPath, "utf8"),
    readFile(serverPath, "utf8"),
    readFile(packagePath, "utf8"),
  ]);
  const packageJson = JSON.parse(packageSource);
  assert.equal(packageJson.dependencies.marked, "18.0.11");
  assert.equal(packageJson.dependencies.dompurify, "3.4.14");
  assert.match(app, /import DOMPurify from "\/vendor\/purify\.es\.mjs"/);
  assert.match(app, /block\.innerHTML = DOMPurify\.sanitize\(rendered/);
  assert.match(app, /const text = markdownBlock\(block\.text\)/);
  assert.match(server, /\/vendor\/marked\.esm\.js/);
  assert.match(server, /\/vendor\/purify\.es\.mjs/);
  assert.match(css, /\.markdown-block pre\s*\{/);
  assert.match(css, /\.markdown-block table\s*\{/);
});

test("composer accepts pasted and dropped image attachments", async () => {
  const [css, app, html, server] = await Promise.all([
    readFile(cssPath, "utf8"),
    readFile(appPath, "utf8"),
    readFile(htmlPath, "utf8"),
    readFile(serverPath, "utf8"),
  ]);
  assert.match(html, /id="image-input"[^>]*accept="image\/png,image\/jpeg,image\/webp,image\/gif"/);
  assert.match(html, /id="image-tray"/);
  assert.match(app, /elements\.prompt\.addEventListener\("paste"/);
  assert.match(app, /elements\.composer\.addEventListener\("drop"/);
  assert.match(app, /\{ type: "image", data, mimeType \}/);
  assert.match(app, /command: \{ type, message, \.\.\.\(images\.length > 0 \? \{ images \} : \{\}\) \}/);
  assert.match(css, /\.image-chip\s*\{/);
  assert.match(css, /\.composer\.drop-active\s*\{/);
  assert.match(server, /maxPayload:\s*32 \* 1024 \* 1024/);
});

test("command palette exposes session actions without duplicate sidebar buttons", async () => {
  const [css, app, html] = await Promise.all([
    readFile(cssPath, "utf8"),
    readFile(appPath, "utf8"),
    readFile(htmlPath, "utf8"),
  ]);
  assert.match(html, /id="command-palette-trigger"/);
  assert.match(html, /id="command-palette-dialog"/);
  assert.doesNotMatch(html, /id="disconnect"/);
  assert.doesNotMatch(html, /id="new-session"/);
  assert.doesNotMatch(html, /id="discover-sessions"/);
  assert.match(html, /id="empty-new-session"/);
  assert.match(app, /id: "new-session"[\s\S]*action: showNewDialog/);
  assert.match(app, /id: "find-pi-sessions"[\s\S]*action: showSessionSearch/);
  assert.match(app, /const COMMAND_PALETTE_KEY = "k"/);
  assert.match(app, /event\.key === "ArrowDown" \|\| event\.key === "ArrowUp"/);
  assert.match(css, /\.command-palette-command\.selected/);
});

test("new sessions use a host-side working directory picker", async () => {
  const [css, app, html, server] = await Promise.all([
    readFile(cssPath, "utf8"),
    readFile(appPath, "utf8"),
    readFile(htmlPath, "utf8"),
    readFile(serverPath, "utf8"),
  ]);
  assert.match(html, /id="browse-cwd"/);
  assert.match(html, /id="directory-dialog"/);
  assert.match(html, /id="directory-list"[^>]*role="listbox"/);
  assert.match(app, /type: "browse_directories", path/);
  assert.match(app, /function selectCurrentDirectory\(\)/);
  assert.match(app, /elements\["cwd-input"\]\.value = state\.currentDirectory/);
  assert.match(server, /case "browse_directories"/);
  assert.match(server, /listDirectories\(message\.path\)/);
  assert.match(css, /\.directory-list\s*\{/);
  assert.match(css, /\.directory-entry\s*\{/);
});

test("session lists expose confirmed trash actions", async () => {
  const [css, app, html, server] = await Promise.all([
    readFile(cssPath, "utf8"),
    readFile(appPath, "utf8"),
    readFile(htmlPath, "utf8"),
    readFile(serverPath, "utf8"),
  ]);
  assert.doesNotMatch(html, /id="delete-session"[^-]/);
  assert.match(html, /id="delete-session-dialog"/);
  assert.match(html, /Any Pi Web-managed run will be stopped\. This cannot be undone/);
  assert.match(app, /className = "session-delete icon-delete"/);
  assert.match(app, /className = "icon-delete"/);
  assert.match(app, /function trashIcon\(\)/);
  assert.match(app, /type: "delete_session",[\s\S]*sessionFile: target\.sessionFile/);
  assert.match(app, /localStorage\.removeItem\("pi-web-last-session"\)/);
  assert.match(server, /case "delete_session"/);
  assert.match(server, /deleteSessionFile\(config\.sessionDir, message\.sessionFile\)/);
  assert.match(css, /\.icon-delete svg/);
  assert.match(css, /\.session-delete\s*\{[^}]*opacity:\s*0[^}]*pointer-events:\s*none/s);
  assert.match(css, /\.session-item:hover \.session-delete, \.session-item:focus-within \.session-delete\s*\{[^}]*opacity:\s*1/s);
  assert.match(css, /@media \(hover:\s*none\)/);
  assert.match(css, /button\.danger/);
});

test("header and control deck remove redundant copy and dismiss outside", async () => {
  const [css, app, html] = await Promise.all([
    readFile(cssPath, "utf8"),
    readFile(appPath, "utf8"),
    readFile(htmlPath, "utf8"),
  ]);
  assert.doesNotMatch(html, /id="run-status"/);
  assert.doesNotMatch(app, /\["run-status"\]/);
  assert.doesNotMatch(css, /\.run-status/);
  assert.doesNotMatch(html, /Enter any Google Fonts family name/);
  assert.doesNotMatch(css, /\.font-help/);
  assert.match(app, /document\.addEventListener\("pointerdown"/);
  assert.match(app, /!elements\["details-panel"\]\.contains\(event\.target\)/);
  assert.match(app, /!elements\["details-toggle"\]\.contains\(event\.target\)/);
});

test("native Pi sessions can be searched and resumed from the browser", async () => {
  const [app, html, server] = await Promise.all([
    readFile(appPath, "utf8"),
    readFile(htmlPath, "utf8"),
    readFile(serverPath, "utf8"),
  ]);
  assert.match(html, /id="session-search-input"/);
  assert.match(app, /id: "find-pi-sessions"/);
  assert.match(app, /type: "search_sessions", query/);
  assert.match(app, /type: "import_session", sessionFile: session\.sessionFile/);
  assert.match(server, /case "search_sessions"/);
  assert.match(server, /case "import_session"/);
});

test("local harness fonts and temporary Google font tester are available", async () => {
  const [css, app, html, server] = await Promise.all([
    readFile(cssPath, "utf8"),
    readFile(appPath, "utf8"),
    readFile(htmlPath, "utf8"),
    readFile(serverPath, "utf8"),
  ]);
  assert.match(css, /fonts\/space-grotesk\.woff2/);
  assert.match(html, /id="user-font"[^>]*list="font-options"/);
  assert.match(html, /id="agent-font"[^>]*list="font-options"/);
  assert.match(html, /id="user-font-size"[^>]*type="number"/);
  assert.match(html, /id="agent-font-size"[^>]*type="number"/);
  assert.match(app, /resolveMessageFont\(name\)/);
  assert.match(app, /replaceAll\(" ", "\+"\)/);
  assert.match(css, /#prompt\s*\{[^}]*font-family:\s*var\(--user-font\)/s);
  assert.match(server, /fonts\/space-grotesk\.woff2/);
  assert.match(server, /style-src 'self' https:\/\/fonts\.googleapis\.com/);
  assert.match(server, /font-src 'self' https:\/\/fonts\.gstatic\.com/);
});
