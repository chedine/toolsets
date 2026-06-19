const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ---------------------------------------------------------------------------
// Public commands
// ---------------------------------------------------------------------------

async function toHtml(uri) {
  const src = resolveSource(uri);
  if (!src) return;

  const { style, body } = parseFile(fs.readFileSync(src, 'utf8'));
  const fileDir = path.dirname(src);
  let bodyHtml = mdToHtml(body);
  const headings = [];
  bodyHtml = addHeadingIds(bodyHtml, headings);
  const toc = style.toc ? buildToc(headings) : '';
  const resolved = resolveImages(bodyHtml, fileDir, style.embedImages);
  const html = buildDocHtml(resolved, style, { forPrint: false, toc });

  const outPath = path.join(fileDir, path.basename(src, path.extname(src)) + '.html');
  if (!(await confirmOverwrite(outPath))) return;

  fs.writeFileSync(outPath, html, 'utf8');
  const pick = await vscode.window.showInformationMessage(
    `Wrote ${path.basename(outPath)}`,
    'Open'
  );
  if (pick === 'Open') vscode.env.openExternal(vscode.Uri.file(outPath));
}

async function toPdf(uri) {
  const src = resolveSource(uri);
  if (!src) return;

  const { style, body } = parseFile(fs.readFileSync(src, 'utf8'));
  const fileDir = path.dirname(src);
  let bodyHtml = mdToHtml(body);
  const headings = [];
  bodyHtml = addHeadingIds(bodyHtml, headings);
  const toc = style.toc ? buildToc(headings) : '';
  // Browser needs file:// URIs for local images (embed still works if opted-in).
  const resolved = resolveImages(bodyHtml, fileDir, style.embedImages);
  const html = buildDocHtml(resolved, style, { forPrint: true, toc });

  const tmpFile = path.join(
    os.tmpdir(),
    'md-doc-' + path.basename(src, path.extname(src)) + '-' + Date.now() + '.html'
  );
  fs.writeFileSync(tmpFile, html, 'utf8');
  vscode.env.openExternal(vscode.Uri.file(tmpFile));
  vscode.window.showInformationMessage('Opened print-ready page. Use the browser’s Save as PDF.');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveSource(uri) {
  if (uri && uri.fsPath) return uri.fsPath;
  if (vscode.window.activeTextEditor) return vscode.window.activeTextEditor.document.uri.fsPath;
  vscode.window.showErrorMessage('No markdown file selected.');
  return null;
}

async function confirmOverwrite(outPath) {
  if (!fs.existsSync(outPath)) return true;
  const pick = await vscode.window.showWarningMessage(
    `${path.basename(outPath)} exists. Overwrite?`,
    { modal: true },
    'Overwrite'
  );
  return pick === 'Overwrite';
}

// ---------------------------------------------------------------------------
// Frontmatter
// ---------------------------------------------------------------------------

const DEFAULT_STYLE = {
  title: '',
  author: '',
  date: '',
  font: 'system-ui',
  fontSize: '16',
  color: '#222',
  bgColor: '#fff',
  titleColor: '',
  linkColor: '#0366d6',
  codeTheme: 'light',
  maxWidth: '760px',
  margin: '1in',
  pageSize: 'Letter',
  embedImages: false,
  toc: true,
};

function parseFile(content) {
  content = content.replace(/\r\n/g, '\n');
  let style = { ...DEFAULT_STYLE };
  let body = content;

  if (content.startsWith('---')) {
    const end = content.indexOf('\n---', 3);
    if (end !== -1) {
      style = parseFrontmatter(content.slice(3, end).trim(), style);
      body = content.slice(end + 4);
    }
  }
  return { style, body };
}

function parseFrontmatter(text, defaults) {
  const style = { ...defaults };
  for (const line of text.split('\n')) {
    const m = line.match(/^(\w+)\s*:\s*"?([^"]*)"?\s*$/);
    if (!m) continue;
    const [, key, raw] = m;
    if (!(key in style)) continue;
    if (typeof style[key] === 'boolean') style[key] = /^(true|yes|1)$/i.test(raw);
    else style[key] = raw;
  }
  return style;
}

// ---------------------------------------------------------------------------
// Markdown → HTML (document, no slide split)
// ---------------------------------------------------------------------------

function mdToHtml(md) {
  const lines = md.split('\n');
  let html = '';
  const stack = []; // {indent, tag, liOpen, isTask}
  let inCode = false;
  let codeLines = [];
  let codeLang = '';
  let paraBuf = [];

  const flushPara = () => {
    if (paraBuf.length) {
      html += `<p>${inline(paraBuf.join(' '))}</p>\n`;
      paraBuf = [];
    }
  };

  const closeTo = (target) => {
    while (stack.length > 0 && stack[stack.length - 1].indent > target) {
      const top = stack[stack.length - 1];
      if (top.liOpen) { html += '</li>\n'; top.liOpen = false; }
      html += `</${top.tag}>\n`;
      stack.pop();
    }
  };
  const flushLists = () => closeTo(-1);

  const closeAllBlocks = () => { flushPara(); flushLists(); };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // fenced code
    const fence = line.match(/^(\s*)(`{3,}|~{3,})\s*(\S*)\s*$/);
    if (fence && !inCode) {
      closeAllBlocks();
      inCode = true;
      codeLines = [];
      codeLang = fence[3] || '';
      continue;
    }
    if (inCode) {
      if (/^(\s*)(`{3,}|~{3,})\s*$/.test(line)) {
        const cls = codeLang ? ` class="language-${esc(codeLang)}"` : '';
        html += `<pre><code${cls}>${esc(codeLines.join('\n'))}</code></pre>\n`;
        inCode = false;
        codeLines = [];
        codeLang = '';
      } else {
        codeLines.push(line);
      }
      continue;
    }

    // blank line
    if (line.trim() === '') {
      flushPara();
      flushLists();
      continue;
    }

    // hr
    if (/^\s{0,3}(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      closeAllBlocks();
      html += '<hr>\n';
      continue;
    }

    // heading
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      closeAllBlocks();
      html += `<h${h[1].length}>${inline(h[2].trim())}</h${h[1].length}>\n`;
      continue;
    }

    // blockquote
    if (/^>\s?/.test(line)) {
      closeAllBlocks();
      // gather consecutive quote lines
      const qLines = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        qLines.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      i--;
      html += `<blockquote>${inline(qLines.join(' '))}</blockquote>\n`;
      continue;
    }

    // table (GFM pipe)
    if (isTableStart(lines, i)) {
      closeAllBlocks();
      const { html: tHtml, consumed } = parseTable(lines, i);
      html += tHtml;
      i += consumed - 1;
      continue;
    }

    // list item (ul/ol/task)
    const ulMatch = line.match(/^(\s*)([-*])\s+(.*)$/);
    const olMatch = line.match(/^(\s*)(\d+)\.\s+(.*)$/);

    if (ulMatch || olMatch) {
      flushPara();
      const indent = (ulMatch || olMatch)[1].length;
      let content = ulMatch ? ulMatch[3] : olMatch[3];
      const tag = ulMatch ? 'ul' : 'ol';

      // Task list syntax
      let taskBox = '';
      const tm = content.match(/^\[([ xX])\]\s+(.*)$/);
      if (tm) {
        const checked = tm[1].toLowerCase() === 'x' ? ' checked' : '';
        taskBox = `<input type="checkbox" disabled${checked}> `;
        content = tm[2];
      }

      closeTo(indent);
      let top = stack[stack.length - 1];
      // Same indent but different list type — close the old list
      if (top && top.indent === indent && top.tag !== tag) {
        if (top.liOpen) html += '</li>\n';
        html += `</${top.tag}>\n`;
        stack.pop();
        top = stack[stack.length - 1];
      }
      if (!top || top.indent < indent) {
        html += `<${tag}${taskBox ? ' class="task-list"' : ''}>\n`;
        stack.push({ indent, tag, liOpen: false });
      } else if (top.liOpen) {
        html += '</li>\n';
        top.liOpen = false;
      }

      const liClass = taskBox ? ' class="task-item"' : '';
      html += `<li${liClass}>${taskBox}${inline(content)}`;
      stack[stack.length - 1].liOpen = true;
      continue;
    }

    // paragraph text (lazy-accumulate until blank line / block)
    flushLists();
    paraBuf.push(line);
  }

  if (inCode && codeLines.length) {
    const cls = codeLang ? ` class="language-${esc(codeLang)}"` : '';
    html += `<pre><code${cls}>${esc(codeLines.join('\n'))}</code></pre>\n`;
  }
  closeAllBlocks();
  return html;
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

function isTableStart(lines, i) {
  if (i + 1 >= lines.length) return false;
  if (!lines[i].includes('|')) return false;
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[i + 1]);
}

function splitRow(row) {
  let s = row.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map(c => c.trim());
}

function parseTable(lines, start) {
  const header = splitRow(lines[start]);
  const aligns = splitRow(lines[start + 1]).map(spec => {
    const l = spec.startsWith(':');
    const r = spec.endsWith(':');
    if (l && r) return 'center';
    if (r) return 'right';
    if (l) return 'left';
    return '';
  });

  const rows = [];
  let i = start + 2;
  while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
    rows.push(splitRow(lines[i]));
    i++;
  }

  const td = (c, align, tag) => {
    const style = align ? ` style="text-align:${align}"` : '';
    return `<${tag}${style}>${inline(c)}</${tag}>`;
  };

  let html = '<table>\n<thead><tr>';
  header.forEach((c, idx) => { html += td(c, aligns[idx] || '', 'th'); });
  html += '</tr></thead>\n<tbody>\n';
  for (const row of rows) {
    html += '<tr>';
    row.forEach((c, idx) => { html += td(c, aligns[idx] || '', 'td'); });
    html += '</tr>\n';
  }
  html += '</tbody>\n</table>\n';

  return { html, consumed: i - start };
}

// ---------------------------------------------------------------------------
// Inline
// ---------------------------------------------------------------------------

function esc(t) {
  return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function inline(text) {
  // Protect inline code spans first.
  const codeSpans = [];
  let s = text.replace(/`([^`]+)`/g, (_m, c) => {
    codeSpans.push(c);
    return ` CODE${codeSpans.length - 1} `;
  });

  s = esc(s);

  // Images (must run before links)
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g,
    (_m, alt, src, title) => `<img alt="${alt}" src="${src}"${title ? ` title="${title}"` : ''}>`);

  // Links
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g,
    (_m, label, href, title) => `<a href="${href}"${title ? ` title="${title}"` : ''}>${label}</a>`);

  // Angle-bracket autolinks: <http://...> or <name@host>
  s = s.replace(/&lt;((?:https?|ftp):\/\/[^\s&]+)&gt;/g, '<a href="$1">$1</a>');
  s = s.replace(/&lt;([^\s@&]+@[^\s&]+\.[^\s&]+)&gt;/g, '<a href="mailto:$1">$1</a>');

  // Bare URL autolinks (avoid ones already inside href="...")
  s = s.replace(/(^|[\s(])((?:https?|ftp):\/\/[^\s<)]+)/g,
    (_m, pre, url) => `${pre}<a href="${url}">${url}</a>`);

  // Emphasis
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\s].*?)\*/g, '$1<em>$2</em>');

  // Restore code spans
  s = s.replace(/ CODE(\d+) /g, (_m, i) => `<code>${esc(codeSpans[+i])}</code>`);

  return s;
}

// ---------------------------------------------------------------------------
// Image resolution
// ---------------------------------------------------------------------------

function resolveImages(html, fileDir, embed) {
  return html.replace(/\bsrc="([^"]*)"/g, (match, src) => {
    if (/^(https?:|data:|vscode-|file:)/.test(src)) return match;
    const abs = path.isAbsolute(src) ? src : path.join(fileDir, src);
    if (embed) {
      try {
        const buf = fs.readFileSync(abs);
        const mime = mimeFromExt(path.extname(abs));
        return `src="data:${mime};base64,${buf.toString('base64')}"`;
      } catch {
        return match;
      }
    }
    return `src="${vscode.Uri.file(abs).toString()}"`;
  });
}

function mimeFromExt(ext) {
  const e = ext.toLowerCase();
  if (e === '.png') return 'image/png';
  if (e === '.jpg' || e === '.jpeg') return 'image/jpeg';
  if (e === '.gif') return 'image/gif';
  if (e === '.svg') return 'image/svg+xml';
  if (e === '.webp') return 'image/webp';
  return 'application/octet-stream';
}

// ---------------------------------------------------------------------------
// Table of contents
// ---------------------------------------------------------------------------

function slugify(s) {
  return s
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 80) || 'section';
}

function addHeadingIds(html, out) {
  const seen = new Map();
  return html.replace(/<h([1-6])>([\s\S]*?)<\/h\1>/g, (_m, lvl, inner) => {
    let id = slugify(inner);
    const n = seen.get(id) || 0;
    seen.set(id, n + 1);
    if (n > 0) id = `${id}-${n}`;
    out.push({ level: +lvl, text: inner, id });
    return `<h${lvl} id="${id}">${inner}</h${lvl}>`;
  });
}

function buildToc(headings) {
  if (!headings.length) return '';
  const minLevel = Math.min(...headings.map(h => h.level));
  let html = '<nav class="toc"><h2 class="toc-title">Table of Contents</h2><ul>';
  let cur = minLevel;
  for (const h of headings) {
    while (cur < h.level) { html += '<ul>'; cur++; }
    while (cur > h.level) { html += '</ul>'; cur--; }
    html += `<li><a href="#${h.id}">${h.text}</a></li>`;
  }
  while (cur-- > minLevel) html += '</ul>';
  html += '</ul></nav>';
  return html;
}

// ---------------------------------------------------------------------------
// HTML shell
// ---------------------------------------------------------------------------

function buildDocHtml(body, style, { forPrint, toc }) {
  const {
    title, author, date, font, fontSize, color, bgColor, titleColor, linkColor,
    codeTheme, maxWidth, margin, pageSize,
  } = style;

  const codeBg    = codeTheme === 'dark' ? '#1e1e1e' : '#f6f8fa';
  const codeColor = codeTheme === 'dark' ? '#e8e8e8' : '#24292e';
  const codeBorder = codeTheme === 'dark' ? '#333' : '#e1e4e8';
  const hColor = titleColor || color;

  const titleTag = title ? `<title>${esc(title)}</title>` : '';

  let header = '';
  if (title || author || date) {
    header += '<header class="doc-header">';
    if (title)  header += `<h1 class="doc-title">${esc(title)}</h1>`;
    if (author || date) {
      header += '<p class="doc-meta">';
      if (author) header += `<span class="doc-author">${esc(author)}</span>`;
      if (author && date) header += ' &middot; ';
      if (date)   header += `<span class="doc-date">${esc(date)}</span>`;
      header += '</p>';
    }
    header += '</header>';
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
${titleTag}
<style>
  *, *::before, *::after { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    background: ${bgColor};
    color: ${color};
    font-family: "${font}", system-ui, -apple-system, Segoe UI, sans-serif;
    font-size: ${fontSize}px;
    line-height: 1.6;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  main {
    max-width: ${maxWidth};
    margin: 0 auto;
    padding: 48px 32px;
  }
  h1, h2, h3, h4, h5, h6 { line-height: 1.25; margin: 1.4em 0 0.5em; color: ${hColor}; }
  h1 { font-size: 2em; border-bottom: 1px solid ${codeBorder}; padding-bottom: 0.3em; }
  h2 { font-size: 1.55em; border-bottom: 1px solid ${codeBorder}; padding-bottom: 0.25em; }
  h3 { font-size: 1.25em; }
  h4 { font-size: 1.05em; }
  p, ul, ol, blockquote, pre, table { margin: 0.75em 0; }
  a { color: ${linkColor}; text-decoration: none; }
  a:hover { text-decoration: underline; }
  ul, ol { padding-left: 1.8em; }
  li { margin: 0.2em 0; }
  ul.task-list { list-style: none; padding-left: 1.2em; }
  li.task-item { position: relative; }
  li.task-item input[type="checkbox"] { margin-right: 0.4em; transform: translateY(1px); }
  blockquote {
    border-left: 4px solid ${codeBorder};
    padding: 0.2em 1em;
    color: ${color};
    opacity: 0.78;
    margin-left: 0;
  }
  code {
    font-family: "SF Mono", "Cascadia Code", Menlo, Consolas, monospace;
    font-size: 0.88em;
    background: ${codeBg};
    color: ${codeColor};
    padding: 0.15em 0.4em;
    border-radius: 4px;
  }
  pre {
    background: ${codeBg};
    color: ${codeColor};
    border: 1px solid ${codeBorder};
    border-radius: 6px;
    padding: 0.9em 1.1em;
    overflow-x: auto;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
    overflow-wrap: anywhere;
  }
  pre code {
    background: none; padding: 0; border-radius: 0; font-size: 0.9em;
    white-space: pre-wrap;
    word-break: break-word;
    overflow-wrap: anywhere;
  }
  img { max-width: 100%; height: auto; display: block; margin: 0.6em 0; }
  hr { border: none; border-top: 1px solid ${codeBorder}; margin: 2em 0; }
  table {
    border-collapse: collapse;
    width: 100%;
    font-size: 0.95em;
  }
  th, td {
    border: 1px solid ${codeBorder};
    padding: 0.5em 0.8em;
  }
  th { background: ${codeBg}; font-weight: 600; text-align: left; }
  tbody tr:nth-child(even) td { background: ${codeTheme === 'dark' ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.02)'}; }
  .doc-header { margin-bottom: 1.5em; }
  .doc-title { margin-top: 0; color: ${hColor}; border-bottom: none; padding-bottom: 0; }
  .doc-meta { opacity: 0.7; font-size: 0.95em; margin: 0.3em 0 0; }
  .toc {
    border: 1px solid ${codeBorder};
    background: ${codeBg};
    border-radius: 6px;
    padding: 1em 1.3em;
    margin: 1.5em 0 2em;
    font-size: 0.95em;
  }
  .toc-title { font-size: 1.05em; margin: 0 0 0.5em; border: none; padding: 0; color: ${hColor}; }
  .toc ul { margin: 0.2em 0; padding-left: 1.4em; list-style: none; }
  .toc > ul { padding-left: 0; }
  .toc li { margin: 0.15em 0; }
  .toc a { color: ${linkColor}; }
  .toc a:hover { text-decoration: underline; }

  @media print {
    @page { size: ${pageSize}; margin: ${margin}; }
    body { background: ${bgColor}; }
    main { max-width: none; padding: 0; }
    blockquote, table, img { page-break-inside: avoid; break-inside: avoid; }
    pre, pre code {
      white-space: pre-wrap !important;
      word-break: break-word;
      overflow-wrap: anywhere;
      overflow: visible;
    }
    h1, h2, h3, h4 { page-break-after: avoid; break-after: avoid; }
    .toc { page-break-after: always; break-after: page; }
    #print-bar { display: none; }
  }
  ${forPrint ? `
  @media screen {
    #print-bar { position: fixed; bottom: 24px; right: 24px; }
    #print-bar button {
      background: #222; color: #fff; border: none;
      padding: 10px 22px; border-radius: 6px; cursor: pointer;
      font-size: 14px; box-shadow: 0 2px 8px rgba(0,0,0,0.4);
    }
    #print-bar button:hover { background: #444; }
  }` : ''}
</style>
</head>
<body>
<main>
${header}
${toc || ''}
${body}
</main>
${forPrint ? `<div id="print-bar"><button onclick="window.print()">&#8659; Save as PDF</button></div>` : ''}
</body>
</html>`;
}

module.exports = { toHtml, toPdf };
