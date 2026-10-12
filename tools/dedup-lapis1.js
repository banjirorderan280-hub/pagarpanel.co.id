/**
 * dedup-lapis1.js
 *
 * LAYER 1 ONLY — find candidate pairs of similar titles using bigrams (offline, no internet /
 * API / token needed). Results are stored in `candidates.json`, which `revise-articles.js`
 * reads in the next step.
 *
 * Why separate from the AI layer: this runs in about a minute and the result is stored in a
 * file, while the AI step (rate-limit prone) can be run repeatedly without redoing this one.
 *
 * Articles are grouped by SECTION so that only titles within the same folder are compared. For
 * PagarPanel the section is the folder under content/categories/ (pagar / uditch / culvert / blog).
 *
 * USAGE:
 *   node tools/dedup-lapis1.js
 *   node tools/dedup-lapis1.js --candidate-threshold=0.55
 *   node tools/dedup-lapis1.js --dir=content/categories
 *
 * Re-run ANYTIME after new/changed articles — it regenerates candidates.json from content/.
 */

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const matter = require('gray-matter');

const ARGS = process.argv.slice(2);
const CAND_THRESHOLD = parseFloat((ARGS.find(a => a.startsWith('--candidate-threshold=')) || '').replace('--candidate-threshold=', '')) || 0.55;
const DIR_ARG = (ARGS.find(a => a.startsWith('--dir=')) || '--dir=content').replace('--dir=', '');
const CONTENT_DIR = path.join(process.cwd(), DIR_ARG);
const CANDIDATES_FILE = path.join(process.cwd(), 'candidates.json');

// Kept in sync with generate-articles.js (SIMILARITY_ALGO_VERSION 2) and lib/related-articles.js.
const DEDUP_ALGO_VERSION = 2; // bump when filtering logic changes — so computeSignature changes too

const STOPWORDS = new Set([
  'jual', 'jasa', 'harga', 'sewa', 'beli', 'biaya', 'tukang', 'pasang',
  'di', 'ke', 'dari', 'untuk', 'dan', 'yang', 'dengan', 'atau', 'per', 'apa', 'itu', 'ini',
  'terbaik', 'berkualitas', 'gratis', 'ongkir', 'murah', 'terpercaya', 'terdekat', 'bagus',
  'professional', 'profesional', 'area', 'lokasi', 'wilayah', 'daerah', 'kota', 'kabupaten',
  'kecamatan', 'jabodetabek', 'anda', 'kami', 'material', 'konstruksi', 'desain', 'interior',
  'bangunan', 'apakah', 'pengertian', 'alternatif', 'panduan', 'lengkap', 'cara', 'tips',
  'mengenal', 'kenali', 'memilih', 'adalah', 'dalam', 'pada', 'juga', 'akan', 'bisa', 'dapat',
  'kuat', 'awet', 'tahan', 'lama', 'baik', 'jenis', 'macam',
  'model', 'membuat', 'minimalis', 'terbaru', 'contoh', 'proses', 'sederhana',
]);

function fmtDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${s % 60}s`;
}

function walk(dir) {
  let results = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results = results.concat(walk(full));
    else if (entry.name.endsWith('.md') && entry.name !== '_index.md') results.push(full);
  }
  return results;
}
function toUrl(filePath) {
  return '/' + path.relative(CONTENT_DIR, filePath).replace(/\\/g, '/').replace(/\.md$/, '') + '/';
}
// content/categories/pagar/x.md -> "pagar" (otherwise the first folder). Without this every
// article would land in one giant "categories" section and be compared against all others.
function toSection(filePath) {
  const parts = path.relative(CONTENT_DIR, filePath).replace(/\\/g, '/').split('/');
  if (parts[0] === 'categories' && parts.length > 2) return parts[1];
  return parts[0] || '(root)';
}

function bigrams(str) {
  const s = str.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
  const g = [];
  for (let i = 0; i < s.length - 1; i++) g.push(s.substring(i, i + 2));
  return g;
}
function diceCoefficient(a, b) {
  const ga = bigrams(a), gb = bigrams(b);
  if (!ga.length || !gb.length) return 0;
  const mapA = new Map(); ga.forEach(g => mapA.set(g, (mapA.get(g) || 0) + 1));
  const mapB = new Map(); gb.forEach(g => mapB.set(g, (mapB.get(g) || 0) + 1));
  let inter = 0;
  for (const [g, c] of mapA) if (mapB.has(g)) inter += Math.min(c, mapB.get(g));
  return (2 * inter) / (ga.length + gb.length);
}
function significantWords(title) {
  return title.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/)
    .filter(w => w.length > 2 && !STOPWORDS.has(w)); // >2 so short niche words like "cor", "dak" remain
}

function computeSignature(allMeta) {
  const h = crypto.createHash('sha256');
  const sorted = allMeta.map(a => `${a.url}|${a.title}|${a.date || ''}`).sort();
  sorted.forEach(s => h.update(s + '\n'));
  h.update(`cand=${CAND_THRESHOLD}`);
  h.update(`algo=${DEDUP_ALGO_VERSION}`);
  return h.digest('hex');
}

function safeIsoDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function main() {
  const t0 = Date.now();
  console.log(`\n🔍 LAYER 1 — find candidate similar titles (offline, no AI)`);
  console.log(`   Directory   : ${CONTENT_DIR}`);
  console.log(`   Threshold   : ${(CAND_THRESHOLD * 100).toFixed(0)}%`);
  console.log(`${'─'.repeat(60)}\n`);

  const files = walk(CONTENT_DIR);
  const allMeta = [];
  const articles = [];
  for (const f of files) {
    let parsed;
    try { parsed = matter(fs.readFileSync(f, 'utf8')); }
    catch { console.warn(`⚠️  Skipping (parse failed): ${f}`); continue; }
    const title = (parsed.data.title || '').toString().trim();
    if (!title) continue;
    const date = safeIsoDate(parsed.data.date);
    const url = toUrl(f);
    allMeta.push({ url, title, date });
    if (parsed.data.draft === true) continue;
    articles.push({ url, title, date, section: toSection(f), wordCount: (parsed.content || '').trim().split(/\s+/).length });
  }
  console.log(`📁 ${articles.length} non-draft articles (from total ${allMeta.length} files).\n`);
  if (articles.length < 2) { console.log('Not enough articles. Done.'); return; }

  const bySection = new Map();
  articles.forEach((art, i) => {
    if (!bySection.has(art.section)) bySection.set(art.section, []);
    bySection.get(art.section).push(i);
  });
  console.log(`📂 ${bySection.size} sections detected.\n`);

  const candidatePairs = [];
  let processed = 0;
  for (const [, idxs] of bySection) {
    processed++;
    if (idxs.length >= 2) {
      const wordIndex = new Map();
      idxs.forEach(i => {
        articles[i]._words = significantWords(articles[i].title);
        articles[i]._words.forEach(w => { if (!wordIndex.has(w)) wordIndex.set(w, []); wordIndex.get(w).push(i); });
      });
      const seen = new Set();
      idxs.forEach(i => {
        const candidates = new Set();
        articles[i]._words.forEach(w => (wordIndex.get(w) || []).forEach(j => { if (j > i) candidates.add(j); }));
        candidates.forEach(j => {
          const key = `${i}-${j}`;
          if (seen.has(key)) return;
          seen.add(key);
          const score = diceCoefficient(articles[i].title, articles[j].title);
          if (score >= CAND_THRESHOLD) {
            candidatePairs.push({ aUrl: articles[i].url, bUrl: articles[j].url, bigramScore: Math.round(score * 1000) / 1000 });
          }
        });
      });
    }
    process.stdout.write(`\r   ${processed}/${bySection.size} sections processed, ${candidatePairs.length} candidates...   `);
  }
  console.log(`\n\n🔗 Completed in ${fmtDuration(Date.now() - t0)}: ${candidatePairs.length} candidate pairs.\n`);

  // Only save titles that are actually needed (reduces file size and downstream work)
  const neededUrls = new Set(candidatePairs.flatMap(p => [p.aUrl, p.bUrl]));
  const titleMap = {};
  articles.forEach(a => { if (neededUrls.has(a.url)) titleMap[a.url] = { title: a.title, date: a.date, wordCount: a.wordCount }; });

  const out = {
    generatedAt: new Date().toISOString(),
    signature: computeSignature(allMeta),
    candidateThreshold: CAND_THRESHOLD,
    titles: titleMap,
    candidatePairs,
  };
  fs.writeFileSync(CANDIDATES_FILE, JSON.stringify(out));

  console.log(`💾 Saved to ${CANDIDATES_FILE}`);
  console.log(`   Unique articles flagged as templated/similar : ${neededUrls.size}`);
  console.log(`\n➡️  Next: node tools/revise-articles.js --apply --limit=20`);
}

main();
