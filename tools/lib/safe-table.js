/**
 * tools/lib/safe-table.js
 *
 * WHY THIS EXISTS:
 * AI-written raw Markdown tables (lines full of "|") are a known source of broken Hugo builds —
 * inconsistent column counts, a missing "|---|---|" separator row, or an unescaped "|" inside a
 * cell can all produce a malformed table.
 *
 * FIX: the AI is never trusted to write table syntax directly. Instead, the prompt asks it to
 * output table DATA as one JSON object per line, inside a plain-text block:
 *
 *   [[TABEL_MULAI]]
 *   {"title": "Judul singkat (opsional)", "headers": ["Kolom 1", "Kolom 2", "Kolom 3"]}
 *   {"row": ["nilai A1", "nilai A2", "nilai A3"]}
 *   {"row": ["nilai B1", "nilai B2", "nilai B3"]}
 *   [[TABEL_SELESAI]]
 *
 * This module (deterministic code, not AI) renders that data into a raw HTML
 * `<table class="table">` block — NOT Markdown pipe syntax. This requires Hugo's
 * `[markup.goldmark.renderer] unsafe = true` (set in config.toml / hugo.toml of this repo),
 * otherwise Hugo would drop the raw HTML.
 *
 * Any row whose JSON fails to parse is silently dropped. If the header line itself is
 * unparseable, the WHOLE block is dropped (never leaves raw "[[TABEL_MULAI]]" text or broken
 * syntax in the published article).
 *
 * The `[[TABEL_...]]` markers are deliberately NOT the same bracket style as
 * revise-articles.js's `[[[PLACEHOLDER_N]]]` protection tokens, so the two never collide.
 */

const TABLE_BLOCK_RE = /\[\[TABEL_MULAI\]\]\s*\n([\s\S]*?)\n?\s*\[\[TABEL_SELESAI\]\]/g;

function escapeHtml(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\r?\n/g, ' ')
    .trim();
}

function renderHtmlTable({ title, headers, rows }) {
  if (!Array.isArray(headers) || headers.length === 0) return '';
  const cleanHeaders = headers.map(escapeHtml);
  const colCount = cleanHeaders.length;

  const cleanRows = (rows || [])
    .filter(r => Array.isArray(r) && r.length > 0)
    .map(r => {
      const cells = r.map(escapeHtml);
      while (cells.length < colCount) cells.push('');
      return cells.slice(0, colCount);
    });

  if (!cleanRows.length) return '';

  const captionHtml = title ? `\n  <caption>${escapeHtml(title)}</caption>` : '';
  const theadHtml = `\n  <thead>\n    <tr>${cleanHeaders.map(h => `<th>${h}</th>`).join('')}</tr>\n  </thead>`;
  const tbodyRows = cleanRows.map(r => `    <tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('\n');
  const tbodyHtml = `\n  <tbody>\n${tbodyRows}\n  </tbody>`;

  return `<table class="table">${captionHtml}${theadHtml}${tbodyHtml}\n</table>`;
}

// Backward-compatible alias.
const renderMarkdownTable = renderHtmlTable;

/**
 * Parses the raw text between [[TABEL_MULAI]] and [[TABEL_SELESAI]]. Returns null if the block
 * can't be salvaged at all. Malformed individual rows are skipped, not fatal.
 */
function parseTableBlock(rawBlock) {
  const lines = rawBlock.split('\n').map(l => l.trim()).filter(Boolean);
  if (!lines.length) return null;

  let meta;
  try { meta = JSON.parse(lines[0]); } catch { return null; }
  if (!meta || !Array.isArray(meta.headers) || meta.headers.length === 0) return null;

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    let obj;
    try { obj = JSON.parse(lines[i]); } catch { continue; }
    if (obj && Array.isArray(obj.row) && obj.row.length > 0) rows.push(obj.row);
  }

  return { title: (meta.title || '').toString(), headers: meta.headers, rows };
}

/**
 * Finds every [[TABEL_MULAI]]...[[TABEL_SELESAI]] block in `body` and replaces it with a safe
 * HTML table. Blocks that can't be parsed at all are removed rather than left as broken text.
 */
function renderSafeTables(body) {
  return body.replace(TABLE_BLOCK_RE, (match, inner) => {
    const parsed = parseTableBlock(inner);
    if (!parsed) return '';
    const table = renderHtmlTable(parsed);
    return table ? `\n${table}\n` : '';
  });
}

// Soft diagnostic: true if raw AI output still contains a table marker AFTER renderSafeTables ran.
function hasLeftoverTableMarkers(body) {
  return /\[\[TABEL_(MULAI|SELESAI)\]\]/.test(body);
}

module.exports = {
  renderSafeTables,
  renderMarkdownTable,
  parseTableBlock,
  hasLeftoverTableMarkers,
};
