/**
 * tools/lib/orphan-link.js
 *
 * Pure helper functions for fix-orphans.js's narrow "insert one verified link" task, split out
 * so the validation/parsing logic (the part that matters for safety) can be tested on its own.
 *
 * In short: the AI is asked to quote back ONE existing sentence verbatim plus that same
 * sentence with a link inserted, and the script applies it as an EXACT STRING SUBSTITUTION,
 * never a full rewrite.
 */

function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let count = 0, idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) { count++; idx += needle.length; }
  return count;
}

function parseAIResponse(text) {
  const trimmed = (text || '').trim();
  if (/^TIDAK_ADA_YANG_COCOK$/im.test(trimmed)) return { noMatch: true };

  const origMatch = trimmed.match(/KALIMAT_ASLI:\s*([\s\S]*?)\n\s*KALIMAT_BARU:/i);
  const newMatch  = trimmed.match(/KALIMAT_BARU:\s*([\s\S]*)$/i);
  if (!origMatch || !newMatch) return { parseError: 'format tidak sesuai (KALIMAT_ASLI/KALIMAT_BARU tidak ditemukan)' };

  return { original: origMatch[1].trim(), updated: newMatch[1].trim() };
}

/**
 * Validates a parsed {original, updated} pair BEFORE it's allowed to touch a file. Every check
 * is a hard reject (never "apply anyway"). Returns null when valid, otherwise a reason string.
 */
function validateInsertion(donorBody, orphanUrl, original, updated) {
  if (!original || original.length < 10) return 'kalimat asli kosong/terlalu pendek';
  if (/!\[.*?\]\(.*?\)|\{\{<.*?>\}\}/.test(original)) return 'kalimat asli mengandung gambar/shortcode (dilarang)';

  const occurrences = countOccurrences(donorBody, original);
  if (occurrences === 0) return 'kalimat asli tidak ditemukan persis di file donor (AI tidak menyalin verbatim)';
  if (occurrences > 1) return `kalimat asli muncul ${occurrences}x di file donor (harus unik, tidak aman untuk substitusi otomatis)`;

  const linkMatches = [...updated.matchAll(/\[([^\]]+)\]\(([^)\s]+)\)/g)];
  if (linkMatches.length !== 1) return `kalimat baru mengandung ${linkMatches.length} link (harus persis 1)`;
  const [, anchorText, linkUrl] = linkMatches[0];
  if (linkUrl !== orphanUrl) return `link menunjuk ke "${linkUrl}", seharusnya persis "${orphanUrl}"`;
  if (!anchorText.trim() || anchorText.trim().length < 3) return 'anchor text kosong/terlalu pendek';
  if (/^(klik di sini|baca juga|selengkapnya|di sini)$/i.test(anchorText.trim())) return `anchor text generik ditolak: "${anchorText.trim()}"`;

  // Guard against the AI quietly rewording more than just inserting the link: strip the link
  // back out and compare word-count delta against the original sentence.
  const delinked = updated.replace(/\[([^\]]+)\]\([^)\s]+\)/, '$1');
  const origWords = original.trim().split(/\s+/).length;
  const delinkedWords = delinked.trim().split(/\s+/).length;
  const maxAllowedExtra = Math.max(15, origWords);
  if (delinkedWords - origWords > maxAllowedExtra) {
    return `kalimat baru tampak diubah lebih dari sekadar menyisipkan link (${origWords} kata → ${delinkedWords} kata setelah link dilepas)`;
  }
  if (origWords - delinkedWords > 3) {
    return `kalimat baru tampak kehilangan sebagian isi kalimat asli (${origWords} kata → ${delinkedWords} kata setelah link dilepas)`;
  }

  return null; // valid
}

// Minimal frontmatter split. rawMatter DELIBERATELY includes the leading "\n" (same convention
// as gray-matter's `.matter`) — reconstruction in applyInsertion() is `---${rawMatter}\n---\n${body}`.
function splitFrontMatter(raw) {
  const m = raw.match(/^---(\r?\n[\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return null;
  return { rawMatter: m[1], body: m[2] || '' };
}

// Surgically add/update `lastmod:` in the RAW frontmatter text, never a full YAML re-serialize
// (which would reformat the file). `date:` (original publish date) stays untouched.
function setLastmod(rawMatter, newDate) {
  const line = `lastmod: "${newDate}"`;
  if (/^lastmod:\s*.*$/m.test(rawMatter)) return rawMatter.replace(/^lastmod:\s*.*$/m, line);
  if (/^date:\s*.*$/m.test(rawMatter)) return rawMatter.replace(/^(date:\s*.*)$/m, `$1\n${line}`);
  return `${rawMatter}\n${line}`;
}

// Applies a validated {original, updated} pair to a donor file's raw content, returning the
// full new file text. Caller MUST have already run validateInsertion() and gotten null back.
function applyInsertion(rawMatter, body, original, updated, newDate) {
  const newBody = body.replace(original, () => updated); // function form: "$" in text is never special
  const newRawMatter = setLastmod(rawMatter, newDate);
  return `---${newRawMatter}\n---\n${newBody}`;
}

module.exports = {
  countOccurrences,
  parseAIResponse,
  validateInsertion,
  splitFrontMatter,
  setLastmod,
  applyInsertion,
};
