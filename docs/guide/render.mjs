import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const root = resolve(dir, '../..');
const sourcePath = resolve(dir, 'rf-hardware-chain.md');
const htmlPath = resolve(dir, 'rf-hardware-chain.html');
const pdfPath = resolve(dir, 'rf-hardware-chain.pdf');

function escapeHtml(text) {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function inline(text) {
  const tokens = [];
  const hold = (html) => {
    const id = tokens.push(html) - 1;
    return `\u0000${id}\u0000`;
  };
  let value = text
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, (_, label, href) =>
      hold(`<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>`))
    .replace(/`([^`]+)`/g, (_, code) => hold(`<code>${escapeHtml(code)}</code>`))
    .replace(/\*\*(.+?)\*\*/g, (_, strong) => hold(`<strong>${escapeHtml(strong)}</strong>`))
    .replace(/(https?:\/\/[^\s<>"\]]+)/g, (url) => {
      const trailing = url.match(/[.,;:)]+$/)?.[0] ?? '';
      const clean = trailing ? url.slice(0, -trailing.length) : url;
      return hold(`<a href="${escapeHtml(clean)}">${escapeHtml(clean)}</a>${escapeHtml(trailing)}`);
    });
  value = escapeHtml(value);
  value = value.replace(/\u0000(\d+)\u0000/g, (_, id) => tokens[Number(id)]);
  return value;
}

function cells(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
}

function renderMarkdown(markdown) {
  const lines = markdown.replaceAll('\r', '').split('\n');
  const output = [];
  let i = 0;
  let inSources = false;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      const text = heading[2];
      inSources = text === 'Источники';
      const className = inSources ? ' class="sources-heading"' : '';
      output.push(`<h${level}${className}>${inline(text)}</h${level}>`);
      i++;
      continue;
    }

    if (line.startsWith('> ')) {
      const quote = [];
      while (i < lines.length && lines[i].startsWith('> ')) quote.push(lines[i++].slice(2));
      output.push(`<blockquote><p>${inline(quote.join(' '))}</p></blockquote>`);
      continue;
    }

    if (line.startsWith('|') && i + 1 < lines.length && /^\|?\s*:?-{3,}/.test(lines[i + 1])) {
      const header = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].startsWith('|')) rows.push(cells(lines[i++]));
      const th = header.map((cell) => `<th>${inline(cell)}</th>`).join('');
      const body = rows.map((row) => `<tr>${header.map((_, index) => `<td>${inline(row[index] ?? '')}</td>`).join('')}</tr>`).join('');
      output.push(`<table><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table>`);
      continue;
    }

    const unordered = line.match(/^\s*-\s+(.+)$/);
    const ordered = line.match(/^\s*\d+\.\s+(.+)$/);
    if (unordered || ordered) {
      const type = unordered ? 'ul' : 'ol';
      const items = [];
      while (i < lines.length) {
        const match = lines[i].match(type === 'ul' ? /^\s*-\s+(.+)$/ : /^\s*\d+\.\s+(.+)$/);
        if (!match) break;
        items.push(`<li>${inline(match[1])}</li>`);
        i++;
      }
      output.push(`<${type}>${items.join('')}</${type}>`);
      continue;
    }

    if (inSources && /^\[\d+\]\s/.test(line)) {
      output.push(`<p class="source">${inline(line.trim())}</p>`);
      i++;
      continue;
    }

    const paragraph = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,3})\s/.test(lines[i]) && !lines[i].startsWith('> ') && !lines[i].startsWith('|') && !/^\s*(?:-|\d+\.)\s/.test(lines[i])) {
      const current = lines[i++];
      paragraph.push(current.endsWith('  ') ? `${current.trimEnd()}<br>` : current.trim());
    }
    if (paragraph.length) {
      const html = paragraph.map((part) => part.endsWith('<br>') ? `${inline(part.slice(0, -4))}<br>` : inline(part)).join(' ');
      output.push(`<p>${html}</p>`);
    } else {
      i++;
    }
  }

  return output.join('\n');
}

const markdown = await readFile(sourcePath, 'utf8');
const body = renderMarkdown(markdown);
const html = `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ITles — от датчика на машине до данных в сервисе</title>
  <style>
    @page { size: A4; margin: 17mm 18mm 19mm; }
    :root { color-scheme: light; }
    * { box-sizing: border-box; }
    html { font-size: 10pt; }
    body {
      margin: 0;
      color: #182433;
      background: #edf1f5;
      font-family: "DejaVu Sans", "Liberation Sans", sans-serif;
      font-size: 9.6pt;
      line-height: 1.42;
    }
    main {
      width: 210mm;
      min-height: 297mm;
      margin: 18px auto;
      padding: 17mm 18mm;
      background: #fff;
      box-shadow: 0 2mm 8mm #1524381c;
    }
    h1, h2, h3, p, ul, ol, blockquote, table { margin-top: 0; }
    h1 {
      margin: 0 0 7mm;
      padding-bottom: 5mm;
      border-bottom: 1.1pt solid #9daaba;
      color: #122d46;
      font-family: "Liberation Serif", "DejaVu Serif", serif;
      font-size: 27pt;
      font-weight: 700;
      line-height: 1.08;
      letter-spacing: -.25pt;
    }
    h1 + p { font-size: 11pt; line-height: 1.45; }
    h2 {
      margin: 8mm 0 3mm;
      padding-bottom: 1.5mm;
      border-bottom: .5pt solid #c7ced7;
      color: #123653;
      font-size: 15pt;
      line-height: 1.2;
      break-after: avoid-page;
    }
    h3 {
      margin: 5mm 0 2mm;
      color: #244763;
      font-size: 11.3pt;
      line-height: 1.25;
      break-after: avoid-page;
    }
    p { margin-bottom: 2.6mm; }
    ul, ol { margin: 1mm 0 3mm; padding-left: 6mm; }
    li { margin: 0 0 1.2mm; padding-left: .5mm; }
    blockquote {
      margin: 4mm 0;
      padding: 3mm 4mm;
      border-left: 2.2pt solid #285b7d;
      background: #f1f5f8;
      color: #183a53;
      font-size: 11.4pt;
      font-weight: 700;
      break-inside: avoid-page;
    }
    table {
      width: 100%;
      margin: 3mm 0 4mm;
      border-collapse: collapse;
      font-size: 7.8pt;
      line-height: 1.3;
      table-layout: fixed;
      break-inside: avoid-page;
    }
    thead { display: table-header-group; }
    tr { break-inside: avoid-page; }
    th, td {
      padding: 1.6mm 1.7mm;
      border: .5pt solid #aeb8c4;
      vertical-align: top;
      overflow-wrap: anywhere;
      word-break: normal;
    }
    th { background: #e9eef3; color: #1b354d; font-weight: 700; text-align: left; }
    code { font-family: "DejaVu Sans Mono", monospace; font-size: .92em; }
    a { color: #1c4f76; overflow-wrap: anywhere; text-decoration: underline; text-decoration-thickness: .35pt; }
    .sources-heading { break-before: page; }
    .source { margin: 0 0 2mm; font-size: 7.5pt; line-height: 1.3; break-inside: avoid-page; }
    @media screen {
      main { border: 1px solid #d8dee6; }
    }
    @media print {
      body { background: #fff; font-size: 9.2pt; }
      main { width: auto; min-height: 0; margin: 0; padding: 0; border: 0; box-shadow: none; }
      h2 { margin-top: 6mm; }
      a { color: #163d5a; }
    }
  </style>
</head>
<body><main>${body}</main></body>
</html>`;

await writeFile(htmlPath, html, 'utf8');
const { chromium } = await import(pathToFileURL(resolve(root, 'platform/node_modules/@playwright/test/index.mjs')).href);
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 1200 } });
  await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  await page.pdf({
    path: pdfPath,
    format: 'A4',
    printBackground: true,
    displayHeaderFooter: true,
    headerTemplate: '<div></div>',
    footerTemplate: '<div style="width:100%;padding:0 18mm;display:flex;justify-content:space-between;font:8px DejaVu Sans,sans-serif;color:#566476"><span>ITles · Инженерная инструкция</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>',
    margin: { top: '17mm', right: '18mm', bottom: '19mm', left: '18mm' },
  });
  console.log(`Wrote ${htmlPath}`);
  console.log(`Wrote ${pdfPath}`);
} finally {
  await browser.close();
}
