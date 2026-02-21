const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');

function activate(context) {
  const disposable = vscode.commands.registerCommand('mdPresenter.present', async (uri) => {
    let filePath;
    if (uri && uri.fsPath) {
      filePath = uri.fsPath;
    } else if (vscode.window.activeTextEditor) {
      filePath = vscode.window.activeTextEditor.document.uri.fsPath;
    } else {
      vscode.window.showErrorMessage('No markdown file selected.');
      return;
    }

    let content;
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch (e) {
      vscode.window.showErrorMessage(`Could not read file: ${e.message}`);
      return;
    }

    const { slides, style } = parseFile(content);
    if (slides.length === 0) {
      vscode.window.showWarningMessage('No slides found in this file.');
      return;
    }

    const fileDir = path.dirname(filePath);

    const panel = vscode.window.createWebviewPanel(
      'mdPresenter',
      path.basename(filePath, '.md') + ' — Present',
      vscode.ViewColumn.One,
      { enableScripts: true, localResourceRoots: [vscode.Uri.file(fileDir)] }
    );

    // Webview needs vscode-resource URIs for local images
    const webviewSlides = resolveImages(slides, fileDir, abs =>
      panel.webview.asWebviewUri(vscode.Uri.file(abs)).toString()
    );
    panel.webview.html = buildHtml(webviewSlides, style);

    panel.webview.onDidReceiveMessage(msg => {
      if (msg.command !== 'exportPdf') return;
      // Browser can handle file:// URIs for local images
      const printSlides = resolveImages(slides, fileDir, abs =>
        vscode.Uri.file(abs).toString()
      );
      const printHtml = buildPrintHtml(printSlides, style);
      const tmpFile = path.join(os.tmpdir(), 'md-presenter-print.html');
      fs.writeFileSync(tmpFile, printHtml, 'utf8');
      vscode.env.openExternal(vscode.Uri.file(tmpFile));
    }, null, context.subscriptions);
  });

  context.subscriptions.push(disposable);
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function parseFile(content) {
  // Normalize line endings
  content = content.replace(/\r\n/g, '\n');

  let style = { bgColor: '#1a1a2e', color: '#e8e8e8', font: 'sans-serif', fontSize: '24', laserColor: '#39ff14' };
  let body = content;

  // Strip frontmatter (first --- ... --- block)
  if (content.startsWith('---')) {
    const end = content.indexOf('\n---', 3);
    if (end !== -1) {
      const fm = content.slice(3, end).trim();
      style = parseFrontmatter(fm, style);
      body = content.slice(end + 4); // skip past the closing ---\n
    }
  }

  // Split remaining content into slides by \n---\n (or --- at boundaries)
  const rawSlides = body.split(/\n---(?:\n|$)/);
  const slides = rawSlides
    .map(s => s.trim())
    .filter(s => s.length > 0)
    .map(mdToHtml);

  return { slides, style };
}

function parseFrontmatter(text, defaults) {
  const style = { ...defaults };
  for (const line of text.split('\n')) {
    // Accept:  key : "value"   or   key:"value"   or   key : value
    const m = line.match(/^(\w+)\s*:\s*"?([^"]*)"?\s*$/);
    if (!m) continue;
    const [, key, val] = m;
    if (key === 'bgColor')    style.bgColor    = val;
    if (key === 'color')      style.color      = val;
    if (key === 'font')       style.font       = val;
    if (key === 'fontSize')   style.fontSize   = val;
    if (key === 'titleColor')  style.titleColor  = val;
    if (key === 'laserColor')  style.laserColor  = val;
  }
  return style;
}

// ---------------------------------------------------------------------------
// Markdown → HTML (handles the basics shown in the sample)
// ---------------------------------------------------------------------------

function mdToHtml(md) {
  const lines = md.split('\n');
  let html = '';
  // Each entry: { indent: number, tag: 'ul'|'ol', liOpen: boolean }
  const stack = [];
  let inCode = false;
  let codeLines = [];
  let codeInList = false;

  // Close list levels with indent strictly greater than targetIndent
  const closeTo = (targetIndent) => {
    while (stack.length > 0 && stack[stack.length - 1].indent > targetIndent) {
      const top = stack[stack.length - 1];
      if (top.liOpen) { html += '</li>\n'; top.liOpen = false; }
      html += `</${top.tag}>\n`;
      stack.pop();
    }
  };

  const flushLists = () => closeTo(-1);

  for (const line of lines) {
    // Fenced code blocks (``` or ~~~)
    if (/^(`{3,}|~{3,})/.test(line)) {
      if (!inCode) {
        codeInList = stack.length > 0;
        if (!codeInList) flushLists();
        inCode = true;
        codeLines = [];
      } else {
        html += `<pre><code>${esc(codeLines.join('\n'))}</code></pre>\n`;
        inCode = false;
        codeLines = [];
        codeInList = false;
      }
      continue;
    }
    if (inCode) { codeLines.push(line); continue; }

    const ulMatch = line.match(/^(\s*)[-*] (.*)$/);
    const olMatch = line.match(/^(\s*)(\d+)\. (.*)$/);

    if (ulMatch || olMatch) {
      const indent  = (ulMatch || olMatch)[1].length;
      const content = ulMatch ? ulMatch[2] : olMatch[3];
      const tag     = ulMatch ? 'ul' : 'ol';

      if (stack.length === 0) {
        html += `<${tag}>\n`;
        stack.push({ indent, tag, liOpen: false });
      } else {
        const top = stack[stack.length - 1];
        if (indent > top.indent) {
          // Deeper — open new list inside the still-open <li>
          html += `<${tag}>\n`;
          stack.push({ indent, tag, liOpen: false });
        } else {
          // Same level or going back up
          if (indent < top.indent) closeTo(indent);
          // Close the current <li> at this level before opening a new one
          const cur = stack[stack.length - 1];
          if (cur && cur.liOpen) { html += '</li>\n'; cur.liOpen = false; }
        }
      }

      html += `<li>${inline(content)}`;
      stack[stack.length - 1].liOpen = true;
      continue;
    }

    // Non-list line — close all open lists first
    flushLists();

    if (/^#{1,6} /.test(line)) {
      const level = line.match(/^(#+) /)[1].length;
      html += `<h${level}>${inline(line.slice(level + 1))}</h${level}>\n`;
    } else if (/^> /.test(line)) {
      html += `<blockquote>${inline(line.slice(2))}</blockquote>\n`;
    } else if (line.trim() !== '') {
      html += `<p>${inline(line)}</p>\n`;
    }
  }

  if (inCode && codeLines.length) {
    html += `<pre><code>${esc(codeLines.join('\n'))}</code></pre>\n`;
  }
  flushLists();
  return html;
}

function resolveImages(slides, fileDir, toUri) {
  return slides.map(html =>
    html.replace(/\bsrc="([^"]*)"/g, (match, src) => {
      if (/^(https?:|data:|vscode-)/.test(src)) return match;
      const abs = path.isAbsolute(src) ? src : path.join(fileDir, src);
      return `src="${toUri(abs)}"`;
    })
  );
}

function esc(t) {
  return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function inline(text) {
  return esc(text)
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img alt="$1" src="$2">')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g,     '<em>$1</em>')
    .replace(/`(.+?)`/g,       '<code>$1</code>');
}

// ---------------------------------------------------------------------------
// Webview HTML
// ---------------------------------------------------------------------------

function buildHtml(slides, style) {
  const { bgColor, color, font, fontSize, titleColor, laserColor } = style;
  const resolvedTitleColor = titleColor || color;
  const slidesJson = JSON.stringify(slides);

  return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    background: ${bgColor};
    color: ${color};
    font-family: "${font}", system-ui, sans-serif;
    font-size: ${fontSize}px;
    height: 100vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    user-select: none;
  }

  /* ---- slide area ---- */
  #slide {
    flex: 1;
    display: flex;
    flex-direction: column;
    justify-content: center;
    padding: 64px 96px;
    overflow: auto;
    line-height: 1.55;
  }

  #slide h1, #slide h2, #slide h3,
  #slide h4, #slide h5, #slide h6 { color: ${resolvedTitleColor}; }
  #slide h1 { font-size: 2em;   margin-bottom: 0.45em; }
  #slide h2 { font-size: 1.6em; margin-bottom: 0.4em;  }
  #slide h3 { font-size: 1.3em; margin-bottom: 0.35em; }
  #slide h4,
  #slide h5,
  #slide h6 { font-size: 1.1em; margin-bottom: 0.3em;  }

  #slide p         { margin: 0.35em 0; }
  #slide ul,
  #slide ol        { padding-left: 1.6em; margin: 0.4em 0; }
  #slide li        { margin: 0.25em 0; }
  #slide blockquote {
    border-left: 4px solid currentColor;
    padding: 0.1em 1em;
    margin: 0.5em 0;
    opacity: 0.75;
    font-style: italic;
  }
  #slide code {
    font-family: "SF Mono", "Cascadia Code", monospace;
    font-size: 0.88em;
    background: rgba(128,128,128,0.2);
    padding: 0.1em 0.35em;
    border-radius: 4px;
  }
  #slide pre {
    font-family: "SF Mono", "Cascadia Code", monospace;
    font-size: 0.82em;
    background: rgba(128,128,128,0.12);
    border: 1px solid rgba(128,128,128,0.25);
    border-radius: 6px;
    padding: 0.9em 1.2em;
    margin: 0.6em 0;
    overflow-x: auto;
    white-space: pre;
    line-height: 1.5;
  }
  #slide pre code {
    background: none;
    padding: 0;
    border-radius: 0;
    font-size: inherit;
  }
  #slide img {
    max-width: 100%;
    max-height: 55vh;
    object-fit: contain;
    display: block;
    margin: 0.5em auto;
  }

  /* ---- laser pointer + draw trail ---- */
  #drawCanvas {
    position: fixed;
    inset: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
    z-index: 9998;
  }

  /* ---- slide transition ---- */
  #slide.fade { animation: fadeIn 0.18s ease; }
  @keyframes fadeIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }

  /* ---- controls bar ---- */
  #bar {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 14px;
    padding: 10px 20px;
    background: rgba(0,0,0,0.18);
    border-top: 1px solid rgba(128,128,128,0.15);
    font-size: 13px;
  }

  button {
    background: rgba(128,128,128,0.18);
    color: inherit;
    border: 1px solid rgba(128,128,128,0.35);
    padding: 5px 18px;
    border-radius: 5px;
    cursor: pointer;
    font-size: 13px;
    font-family: inherit;
    transition: background 0.15s;
  }
  button:hover:not(:disabled) { background: rgba(128,128,128,0.32); }
  button:disabled { opacity: 0.28; cursor: default; }

  #counter { min-width: 72px; text-align: center; opacity: 0.6; }
  #hint     { opacity: 0.35; font-size: 11px; }
  #sep      { opacity: 0.2; }

</style>
</head>
<body>

<canvas id="drawCanvas"></canvas>
<div id="slide"></div>

<div id="bar">
  <button id="prev">&#8592; Prev</button>
  <span id="counter"></span>
  <button id="next">Next &#8594;</button>
  <span id="hint">arrow keys &nbsp;|&nbsp; space</span>
  <span id="sep">|</span>
  <button id="exportPdf">&#8659; Export PDF</button>
</div>

<script>
  const vscodeApi = acquireVsCodeApi();
  const slides  = ${slidesJson};
  let current = 0;

  const slideEl  = document.getElementById('slide');
  const counterEl = document.getElementById('counter');
  const prevBtn  = document.getElementById('prev');
  const nextBtn  = document.getElementById('next');

  function render(animate) {
    if (animate) {
      slideEl.classList.remove('fade');
      void slideEl.offsetWidth;          // force reflow to restart animation
      slideEl.classList.add('fade');
    }
    slideEl.innerHTML = slides[current];
    counterEl.textContent = (current + 1) + ' / ' + slides.length;
    prevBtn.disabled = current === 0;
    nextBtn.disabled = current === slides.length - 1;
  }

  function goNext() { if (current < slides.length - 1) { current++; render(true); } }
  function goPrev() { if (current > 0)                 { current--; render(true); } }

  prevBtn.addEventListener('click', goPrev);
  nextBtn.addEventListener('click', goNext);

  document.addEventListener('keydown', e => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === ' ')  goNext();
    if (e.key === 'ArrowLeft'  || e.key === 'ArrowUp')                      goPrev();
  });

  render(false);

  // ---- Excalidraw-style draw trail ----
  const canvas = document.getElementById('drawCanvas');
  const ctx    = canvas.getContext('2d');
  const LASER  = '${laserColor}';
  const FADE_MS = 1800;

  function syncCanvas() {
    canvas.width  = window.innerWidth;
    canvas.height = window.innerHeight;
  }
  syncCanvas();
  window.addEventListener('resize', syncCanvas);

  let strokes   = [];   // Array of {x,y,t}[]
  let activePts = null;
  let drawing   = false;

  slideEl.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    drawing   = true;
    activePts = [];
    strokes.push(activePts);
    e.preventDefault();
  });

  document.addEventListener('mouseup', () => {
    drawing   = false;
    activePts = null;
  });

  slideEl.addEventListener('mousemove', e => {
    if (drawing && activePts)
      activePts.push({ x: e.clientX, y: e.clientY, t: Date.now() });
  });

  (function drawLoop() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const now = Date.now();

    // Expire old points; drop empty strokes (but keep the active one)
    strokes = strokes
      .map(s => s === activePts ? s : s.filter(p => now - p.t < FADE_MS))
      .filter(s => s === activePts || s.length > 0);

    ctx.lineCap  = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 4;

    for (const stroke of strokes) {
      for (let i = 1; i < stroke.length; i++) {
        const p0    = stroke[i - 1];
        const p1    = stroke[i];
        const age   = stroke === activePts ? 0 : now - p1.t;
        const alpha = Math.max(0, 1 - age / FADE_MS);
        ctx.globalAlpha = alpha;
        ctx.shadowColor = LASER;
        ctx.shadowBlur  = 8;
        ctx.strokeStyle = LASER;
        ctx.beginPath();
        ctx.moveTo(p0.x, p0.y);
        ctx.lineTo(p1.x, p1.y);
        ctx.stroke();
      }
    }

    ctx.globalAlpha = 1;
    ctx.shadowBlur  = 0;
    requestAnimationFrame(drawLoop);
  })();

  document.getElementById('exportPdf').addEventListener('click', () =>
    vscodeApi.postMessage({ command: 'exportPdf' })
  );
</script>
</body>
</html>`;
}

function buildPrintHtml(slides, style) {
  const { bgColor, color, font, fontSize, titleColor } = style;
  const resolvedTitleColor = titleColor || color;

  const slideDivs = slides.map(h => `<div class="slide">${h}</div>`).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  .slide {
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
    width: 100vw; height: 100vh;
    display: flex; flex-direction: column; justify-content: center;
    padding: 64px 96px;
    background: ${bgColor}; color: ${color};
    font-family: "${font}", system-ui, sans-serif;
    font-size: ${fontSize}px; line-height: 1.55;
    overflow: hidden;
  }
  .slide h1,.slide h2,.slide h3,.slide h4,.slide h5,.slide h6 { color: ${resolvedTitleColor}; }
  .slide h1 { font-size: 2em;   margin-bottom: 0.45em; }
  .slide h2 { font-size: 1.6em; margin-bottom: 0.4em;  }
  .slide h3 { font-size: 1.3em; margin-bottom: 0.35em; }
  .slide h4,.slide h5,.slide h6 { font-size: 1.1em; margin-bottom: 0.3em; }
  .slide p  { margin: 0.35em 0; }
  .slide ul,.slide ol { padding-left: 1.6em; margin: 0.4em 0; }
  .slide li { margin: 0.25em 0; }
  .slide blockquote {
    border-left: 4px solid currentColor; padding: 0.1em 1em;
    margin: 0.5em 0; opacity: 0.75; font-style: italic;
  }
  .slide code {
    font-family: "SF Mono","Cascadia Code",monospace; font-size: 0.88em;
    background: rgba(128,128,128,0.2); padding: 0.1em 0.35em; border-radius: 4px;
  }
  .slide pre {
    font-family: "SF Mono","Cascadia Code",monospace; font-size: 0.82em;
    background: rgba(128,128,128,0.12); border: 1px solid rgba(128,128,128,0.25);
    border-radius: 6px; padding: 0.9em 1.2em; margin: 0.6em 0;
    white-space: pre; line-height: 1.5;
  }
  .slide pre code { background: none; padding: 0; border-radius: 0; font-size: inherit; }
  .slide img {
    max-width: 100%;
    max-height: 55vh;
    object-fit: contain;
    display: block;
    margin: 0.5em auto;
  }

  @media screen {
    body { background: #555; padding: 20px; }
    .slide { margin: 0 auto 24px; max-width: 1200px; box-shadow: 0 4px 24px rgba(0,0,0,0.4); }
    #print-bar {
      position: fixed; bottom: 24px; right: 24px;
    }
    #print-bar button {
      background: #222; color: #fff; border: none;
      padding: 10px 22px; border-radius: 6px; cursor: pointer;
      font-size: 14px; box-shadow: 0 2px 8px rgba(0,0,0,0.4);
    }
    #print-bar button:hover { background: #444; }
  }

  @media print {
    body { background: none; padding: 0; }
    .slide { page-break-after: always; break-after: page; }
    .slide:last-child { page-break-after: avoid; break-after: avoid; }
    #print-bar { display: none; }
  }
</style>
</head>
<body>
${slideDivs}
<div id="print-bar">
  <button onclick="window.print()">&#8659; Save as PDF</button>
</div>
</body>
</html>`;
}

function deactivate() {}

module.exports = { activate, deactivate };
