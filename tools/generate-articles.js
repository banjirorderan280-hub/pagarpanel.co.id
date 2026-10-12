/**
 * generate-articles.js
 *
 * Keyword source priority: GSC → Serper.dev research → keywords.txt (last resort).
 *
 * Mode:
 *   node generate-articles.js            → production (requires GSC_CREDENTIALS + CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN)
 *   node generate-articles.js --dry-run  → local test (use dummy keywords, skip API calls)
 *   node generate-articles.js --dry-run --keyword="harga pagar panel beton per meter"
 *   node generate-articles.js --verify-cf
 *       → Tests EACH CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN pair independently with a
 *         minimal real call, reporting ✅/❌ per pair. Does NOT touch GSC or generate any
 *         articles. Use this whenever Cloudflare calls start failing with "unescaped
 *         characters" or "Authentication error" — pinpoints exactly which pair (if any) is
 *         misconfigured instead of guessing from a retry log.
 *   node generate-articles.js --research-only
 *       → Only runs Serper.dev keyword research (Related Searches + People Also Ask, and
 *         optionally Autocomplete), seeded from top GSC keywords — or seed-keywords.txt if
 *         GSC has no data at all — then appends new ideas to keywords.txt. Does NOT generate
 *         any articles. Requires SERPER_API_KEY. Use this to test seeds and check credit
 *         usage before trusting the automatic fallback tier (see "Serper.dev keyword research"
 *         section below).
 */

const fs     = require('fs');
const path   = require('path');
const https  = require('https');
const crypto = require('crypto');

// All AI prompt text (system/user templates, style-variation banks) lives in
// prompts/generate-articles.json — kept separate from this file so prompt wording can be
// edited without touching code. Variables are injected via {{placeholder}} tokens, filled
// in by renderTemplate() below.
const PROMPTS = require('./prompts/generate-articles.json');

// NON-AI internal-link candidate selection (buildArticleIndex/findRelatedCandidates) and the
// post-generation internal-link safety net (enforceInternalLinks) — see file header comments
// in lib/related-articles.js for the full design.
const {
  buildArticleIndex,
  guessCategoryHint,
  findRelatedCandidates,
  formatCandidatesForPrompt,
  enforceInternalLinks,
} = require('./lib/related-articles.js');

// Deterministic, crash-proof Markdown table rendering from AI-provided structured data — see
// file header comments in lib/safe-table.js for why raw AI-written Markdown tables are never
// trusted directly.
const { renderSafeTables, hasLeftoverTableMarkers } = require('./lib/safe-table.js');

function renderTemplate(str, vars) {
  return str.replace(/\{\{(\w+)\}\}/g, (_, key) => (key in vars ? vars[key] : `{{${key}}}`));
}

// `sharp` is only required lazily inside resizeAndWatermark() — see getSharp() below.
// It used to be require()'d here at the top, which meant a missing/not-yet-installed
// `sharp` package crashed the ENTIRE script before anything ran — including keyword
// fetching and article generation, which don't need image processing at all. Now a
// missing `sharp` only disables the AI-image step (which already has its own
// try/catch fallback to the generic image); everything else keeps working normally.
function getSharp() {
  try {
    return require('sharp');
  } catch (err) {
    throw new Error(`'sharp' package not installed — run "npm install sharp" and commit the updated package.json/package-lock.json. (${err.message})`);
  }
}

// ─── Mode ────────────────────────────────────────────────────────────
const IS_DRY_RUN     = process.argv.includes('--dry-run');
const CUSTOM_KW      = (process.argv.find(a => a.startsWith('--keyword=')) || '').replace('--keyword=', '');
const RESEARCH_ONLY  = process.argv.includes('--research-only');
const VERIFY_CF      = process.argv.includes('--verify-cf');

// ─── Configuration ───────────────────────────────────────────────────
const CONFIG = {
  GSC_CREDENTIALS : (() => {
    try { return JSON.parse(process.env.GSC_CREDENTIALS || '{}'); } catch { return {}; }
  })(),
  GSC_SITE_URL    : process.env.GSC_SITE_URL || 'https://pagarpanel.co.id/',
  // GitHub Models was fully retired on 2026-07-30 — replaced with Cloudflare Workers AI
  // (OpenAI-compatible endpoint). Requires CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN.
  //
  // Both CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN can hold MULTIPLE values — one per
  // line, or comma-separated — to pool quota across several Cloudflare accounts:
  //   - N account IDs + N tokens (same count): PAIRED 1:1 BY LINE ORDER — line 1 of one
  //     goes with line 1 of the other (same account), line 2 with line 2, etc. Get this
  //     order wrong and you'll pair an account ID with the wrong account's token, which
  //     fails auth. See validation warning below if the counts don't match.
  //   - 1 account ID + N tokens: all N tokens rotate against that SAME single account
  //     (original behavior — multiple tokens for one account).
  // On rate-limit/failure, rotateCfToken() advances to the next pair automatically.
  //
  // CLOUDFLARE_ACCOUNT_ID is embedded directly into the URL PATH (not a header) by
  // buildModelsApiPath()/buildImageApiPath() below — a stray trailing newline/space on a
  // single-line value used to get baked raw into the URL path (an easy copy-paste mistake),
  // and Node's https module rejects that with the cryptic, hard-to-diagnose "Request path
  // contains unescaped characters" (ERR_UNESCAPED_CHARACTERS) — identically across ALL
  // THREE Cloudflare call sites (article text, image prompt, image generation), since they
  // all build their path from this same value. Splitting + trimming each line here (same
  // pattern as CF_API_TOKENS) fixes that at the source, whether it's stray whitespace on a
  // single ID or multiple IDs pasted across several lines.
  CF_ACCOUNT_IDS  : (process.env.CLOUDFLARE_ACCOUNT_ID || '').split(/[\n,]+/).map(s => s.trim()).filter(Boolean),
  CF_API_TOKENS   : (process.env.CLOUDFLARE_API_TOKEN || '').split(/[\n,]+/).map(s => s.trim()).filter(Boolean),
  MODELS_API_HOST : 'api.cloudflare.com',
  MODELS_API_PATH : '', // built at runtime from CF_ACCOUNT_IDS, see buildModelsApiPath()
  AI_MODEL        : '@cf/aisingapore/gemma-sea-lion-v4-27b-it',

  // ── Serper.dev keyword research (2nd-tier: after GSC, before keywords.txt) ───────────
  // Discovers NEW keyword ideas via Google Related Searches + People Also Ask (and
  // optionally Autocomplete). Seed priority: top-impression GSC keywords first; only falls
  // back to seed-keywords.txt (manual list) when GSC has no data at all this run.
  //
  // Switched from SerpApi to Serper.dev: SerpApi's free plan turned out to require a
  // credit card at signup AND is restricted to non-commercial use — neither works for a
  // production/business site. Serper.dev needs no card and is fine for commercial use.
  //
  // COST NOTE (serper.dev, checked 2026): new accounts get 2,500 free queries, ONE-TIME
  // (not a monthly reset) — they never expire, but once spent you top up (from $50/50,000,
  // pay-as-you-go, no subscription). At ~5 keywords/day this comfortably lasts well over a
  // year before needing a single dollar.
  //   - Related Searches + People Also Ask come bundled in ONE `/search` call → 1 credit
  //     per seed keyword.
  //   - Autocomplete is a SEPARATE call → +1 credit per seed if SERPER_USE_AUTOCOMPLETE is
  //     enabled. NOTE: its exact response shape isn't clearly documented publicly — this is
  //     best-effort parsing, see fetchKeywordIdeasFromSerper() below. Test with
  //     --research-only before relying on it.
  // Default SERPER_DAILY_BUDGET=8 credits/run is just a safety guard against a runaway
  // seed list burning through your one-time free balance in a single run — raise it freely,
  // there's no monthly reset to protect here like there was with SerpApi.
  SERPER_API_KEY           : process.env.SERPER_API_KEY || '',
  SERPER_HOST              : 'google.serper.dev',
  SERPER_COUNTRY           : 'id', // `gl` param
  SERPER_LANG              : 'id', // `hl` param
  SERPER_USE_AUTOCOMPLETE  : (process.env.SERPER_USE_AUTOCOMPLETE || 'false') === 'true',
  SERPER_DAILY_BUDGET      : parseInt(process.env.SERPER_DAILY_BUDGET || '8', 10), // credits per run
  SERPER_MANUAL_SEEDS_FILE : path.join(__dirname, '..', 'seed-keywords.txt'), // fallback seeds, used only if GSC has none
  SERPER_AUTO_SEED_COUNT   : 3, // how many top-impression GSC keywords to use as seeds (primary source)


  // PagarPanel keeps its articles under content/categories/<folder>/. The hand-made location
  // pages live in pagar / uditch / culvert; everything this script generates goes to ONE folder,
  // ARTICLE_FOLDER (= content/categories/blog/, linked as "Blog" in the main menu).
  // CONTENT_DIR is the parent of all those folders and is used for slug-duplicate / similarity
  // checks across every category.
  CONTENT_DIR     : path.join(__dirname, '..', 'content', 'categories'),
  // Full content/ root, used ONLY for building the internal-link candidate index below.
  CONTENT_ROOT_DIR: path.join(__dirname, '..', 'content'),
  IMAGES_DIR      : path.join(__dirname, '..', 'static', 'images'),
  // AI-generated images go here (kept separate from the hand-made images/pagar|uditch|boxculvert).
  BLOG_IMAGES_DIR : path.join(__dirname, '..', 'static', 'images', 'artikel'),
  BLOG_IMAGES_URL : '/images/artikel',
  GENERIC_IMAGE   : '/images/pagar/pagar-panel-1.jpg', // fallback when no matching/AI image is available

  // Image generation now via Cloudflare Workers AI (FLUX.2 [klein] 9B) — replaced Gemini
  // (Gemini kept hitting rate limits / quota issues). Uses CF_ACCOUNT_ID + CF_API_TOKEN,
  // same credentials already used for the text model.
  CF_IMAGE_MODEL     : '@cf/black-forest-labs/flux-2-klein-9b',
  AI_IMAGE_GEN_WIDTH : 1024,
  AI_IMAGE_GEN_HEIGHT: 683, // ~3:2, matches final crop aspect ratio below

  // REQUIRED size for AI-generated images + watermark
  AI_IMAGE_WIDTH   : 600,
  AI_IMAGE_HEIGHT  : 400,
  // Optional: drop a transparent PNG logo at static/images/watermark-pp.png to have it
  // stamped on AI images. If the file doesn't exist, images are saved without watermark.
  WATERMARK_PATH   : path.join(__dirname, '..', 'static', 'images', 'watermark-pp.png'),
  WATERMARK_OPACITY: 0.4,
  WATERMARK_WIDTH_RATIO: 0.22,

  // GSC filters
  MIN_IMPRESSIONS : 5,
  MAX_POSITION    : 20,
  MAX_ARTICLES    : 3,
  DATE_RANGE_DAYS : 90,
  GSC_PAGE_SIZE   : 5000,  // rows per GSC API call (API max is 25,000)
  GSC_MAX_PAGES   : 5,     // safety cap → up to 25,000 queries total

  // Site info — matching config.toml
  SITE_NAME       : 'PagarPanel.co.id',
  SITE_URL        : 'https://pagarpanel.co.id/',
  SITE_TITLE      : 'PAGARPANEL.CO.ID | Tempat terbaik untuk mendapatkan solusi pagar panel beton berkualitas tinggi',

  // Folder (under content/categories/) that receives every generated article.
  ARTICLE_FOLDER  : 'blog',

  // Dummy keywords for dry-run
  DRY_RUN_KEYWORDS: [
    { keyword: 'harga pagar panel beton per meter', impressions: 68, clicks: 2, ctr: 0.029, position: 8.3  },
    { keyword: 'ukuran u ditch beton',              impressions: 45, clicks: 1, ctr: 0.022, position: 11.5 },
    { keyword: 'cara memasang box culvert',         impressions: 32, clicks: 0, ctr: 0.0,   position: 6.1  },
  ],
};

// Cloudflare account IDs are 32-char lowercase hex. Splitting+trimming above fixes plain
// whitespace issues, but this catches anything else malformed (wrong value pasted, stray
// quotes, etc.) per entry and fails LOUD with a clear message at startup — instead of the
// opaque "Request path contains unescaped characters" that would otherwise only surface
// deep inside a retry loop, identically on every single Cloudflare call, which is exactly
// what happened on 2026-08-18 and took real effort to trace back to this value.
CONFIG.CF_ACCOUNT_IDS.forEach((id, i) => {
  if (!/^[a-f0-9]{32}$/i.test(id)) {
    console.warn(`⚠️  CLOUDFLARE_ACCOUNT_ID line ${i + 1} doesn't look like a valid Cloudflare account ID ` +
      `(expected 32 hex characters, got ${id.length} chars: "${id}"). ` +
      `If Cloudflare calls fail with "unescaped characters" or similar, re-check this secret for stray whitespace/quotes.`);
  }
});

// Multi-account pairing sanity check: with >1 account ID, each line is expected to pair
// 1:1 with the SAME line number in CLOUDFLARE_API_TOKEN (that account's own token). A count
// mismatch usually means lines got added/removed from one secret but not the other, which
// silently pairs an account ID with a different account's token and fails auth — not a
// crash, just quietly-wrong requests, so this is worth flagging loudly even though the
// script still runs (falling back to index 0 for any account ID beyond the token count).
if (CONFIG.CF_ACCOUNT_IDS.length > 1 && CONFIG.CF_ACCOUNT_IDS.length !== CONFIG.CF_API_TOKENS.length) {
  console.warn(`⚠️  CLOUDFLARE_ACCOUNT_ID has ${CONFIG.CF_ACCOUNT_IDS.length} line(s) but CLOUDFLARE_API_TOKEN has ` +
    `${CONFIG.CF_API_TOKENS.length} line(s). For multi-account rotation these must match 1:1, same order ` +
    `(line N of one = line N of the other, same account) — otherwise an account ID may get paired with ` +
    `the wrong account's token and fail auth. Fix: make both secrets have the same number of lines.`);
}

let cfTokenIdx = 0;
function currentCfToken() { return CONFIG.CF_API_TOKENS[cfTokenIdx] || ''; }
// Paired with currentCfToken() via the SAME index, so rotateCfToken() advances both
// together. With only 1 account ID (the "multiple tokens, one account" case), every index
// falls back to that single account — see comment on CF_ACCOUNT_IDS above.
function currentCfAccountId() { return CONFIG.CF_ACCOUNT_IDS[cfTokenIdx] || CONFIG.CF_ACCOUNT_IDS[0] || ''; }
function rotateCfToken() { cfTokenIdx = (cfTokenIdx + 1) % CONFIG.CF_API_TOKENS.length; }

// Cloudflare Workers AI OpenAI-compatible chat completions path (account-scoped).
function buildModelsApiPath() {
  if (!currentCfAccountId()) throw new Error('CLOUDFLARE_ACCOUNT_ID not found.');
  return `/client/v4/accounts/${currentCfAccountId()}/ai/v1/chat/completions`;
}

// Cloudflare Workers AI native "run" path for the image model (multipart, not OpenAI-compatible).
function buildImageApiPath() {
  if (!currentCfAccountId()) throw new Error('CLOUDFLARE_ACCOUNT_ID not found.');
  return `/client/v4/accounts/${currentCfAccountId()}/ai/run/${CONFIG.CF_IMAGE_MODEL}`;
}

// FLUX.2 [klein] 9B on Workers AI requires multipart/form-data even for text-only fields.
// Builds a minimal multipart body from a flat { field: value } object.
function buildMultipartFormData(fields) {
  const boundary = `----ppFormBoundary${crypto.randomBytes(16).toString('hex')}`;
  const parts = [];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    parts.push(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${key}"\r\n\r\n` +
      `${value}\r\n`
    );
  }
  parts.push(`--${boundary}--\r\n`);
  return { body: Buffer.from(parts.join(''), 'utf8'), contentType: `multipart/form-data; boundary=${boundary}` };
}

function httpRequest(hostname, path, options, body = null, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const opts = { hostname, path, ...options };
    const req  = https.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data)); } catch { resolve(data); }
        } else if (res.statusCode === 429) {
          const err = new Error(`Rate limited (429) ${hostname}${path}: ${data.slice(0, 200)}`);
          err.isRateLimit = true;
          err.statusCode = 429;
          err.retryAfterSec = res.headers['retry-after'] ? parseInt(res.headers['retry-after'], 10) : null;
          reject(err);
        } else {
          const err = new Error(`HTTP ${res.statusCode} ${hostname}${path}: ${data.slice(0, 200)}`);
          err.statusCode = res.statusCode;
          // 401/403 almost always means THIS SPECIFIC key/account pair is bad (wrong
          // token, expired, wrong permissions, or paired with the wrong account) — not that
          // the whole Cloudflare account is rate-limited or down. Tagging it lets retry
          // loops rotate to the NEXT pair immediately instead of burning the full retry
          // budget hammering the same broken pair 3x, which is what happened on
          // 2026-08-19: a bad pair 1 was retried 3 times per article while pair 2 (which
          // may well have been fine) was never even tried.
          err.isAuthError = (res.statusCode === 401 || res.statusCode === 403);
          reject(err);
        }
      });
    });

    req.setTimeout(timeoutMs, () => req.destroy(new Error(`Timeout after ${timeoutMs/1000}s without response from ${hostname}`)));
    req.on('error', reject);
    if (body) req.write(Buffer.isBuffer(body) ? body : (typeof body === 'string' ? body : JSON.stringify(body)));
    req.end();
  });
}

async function getGSCAccessToken() {
  const creds = CONFIG.GSC_CREDENTIALS;
  if (!creds.client_email || !creds.private_key) {
    throw new Error('Invalid GSC_CREDENTIALS.');
  }
  const now     = Math.floor(Date.now() / 1000);
  const header  = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss  : creds.client_email,
    scope: 'https://www.googleapis.com/auth/webmasters.readonly',
    aud  : 'https://oauth2.googleapis.com/token',
    iat  : now, exp: now + 3600,
  })).toString('base64url');

  const sign = crypto.createSign('RSA-SHA256');
  sign.update(`${header}.${payload}`);
  const jwt = `${header}.${payload}.${sign.sign(creds.private_key, 'base64url')}`;

  const body = `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`;
  const res  = await httpRequest('oauth2.googleapis.com', '/token', {
    method : 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
  }, body);
  return res.access_token;
}

async function fetchAllGSCRows(token, startDate, endDate) {
  const siteEnc = encodeURIComponent(CONFIG.GSC_SITE_URL);
  const rows = [];
  let startRow = 0;
  for (let page = 0; page < CONFIG.GSC_MAX_PAGES; page++) {
    const body = JSON.stringify({
      startDate, endDate,
      dimensions: ['query'],
      rowLimit  : CONFIG.GSC_PAGE_SIZE,
      startRow,
    });
    const result = await httpRequest(
      'searchconsole.googleapis.com',
      `/webmasters/v3/sites/${siteEnc}/searchAnalytics/query`,
      {
        method : 'POST',
        headers: {
          'Authorization' : `Bearer ${token}`,
          'Content-Type'  : 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      body
    );
    const pageRows = result.rows || [];
    rows.push(...pageRows);
    if (pageRows.length < CONFIG.GSC_PAGE_SIZE) break; // last page reached
    startRow += CONFIG.GSC_PAGE_SIZE;
  }
  return rows;
}

// Tracks the date each GSC keyword was first observed by this script (GSC's API itself
// has no "first seen" field — it only reports aggregate performance over a date range).
// Persisted to disk so "oldest keyword first" ordering is stable across daily runs.
const KEYWORD_FIRST_SEEN_FILE = path.join(__dirname, '..', '.gsc-keyword-first-seen.json');

function loadFirstSeenMap() {
  try { return JSON.parse(fs.readFileSync(KEYWORD_FIRST_SEEN_FILE, 'utf8')); } catch { return {}; }
}

function updateFirstSeenMap(keywordItems) {
  const map = loadFirstSeenMap();
  const today = new Date().toISOString().split('T')[0];
  let changed = false;
  for (const item of keywordItems) {
    const key = item.keyword.toLowerCase().trim();
    if (!map[key]) { map[key] = today; changed = true; }
  }
  if (changed) fs.writeFileSync(KEYWORD_FIRST_SEEN_FILE, JSON.stringify(map, null, 2));
  return map;
}

async function fetchKeywordsFromGSC() {
  if (IS_DRY_RUN) {
    if (CUSTOM_KW && !hasMinKeywordWords(CUSTOM_KW, 3)) {
      console.log(`   ⚠️  --keyword="${CUSTOM_KW}" has < 3 significant words — normally skipped, proceeding anyway since this is an explicit manual --dry-run override.`);
    }
    const kws = CUSTOM_KW
      ? [{ keyword: CUSTOM_KW, impressions: 50, clicks: 1, ctr: 0.02, position: 9 }]
      : CONFIG.DRY_RUN_KEYWORDS;
    console.log(`🧪 DRY-RUN: Using ${kws.length} dummy keywords.`);
    return kws;
  }

  console.log('📊 Fetching keywords from Google Search Console...');
  const token   = await getGSCAccessToken();
  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - CONFIG.DATE_RANGE_DAYS);
  const fmt = d => d.toISOString().split('T')[0];

  const rows = await fetchAllGSCRows(token, fmt(startDate), fmt(endDate));

  if (!rows.length) { console.log('⚠️  No keyword data.'); return []; }

  const droppedShort = [];
  const filtered = rows
    .filter(r => r.impressions >= CONFIG.MIN_IMPRESSIONS && r.position <= CONFIG.MAX_POSITION)
    // At least 3 SIGNIFICANT words (conjunctions/prepositions like "dan", "dengan", "pada",
    // "itu" don't count — see CONJUNCTION_STOPWORDS above) — very short/generic keywords are
    // too broad and prone to overlapping with other articles.
    .filter(r => {
      const ok = hasMinKeywordWords(r.keys[0], 3);
      if (!ok) droppedShort.push(r.keys[0]);
      return ok;
    })
    .map(r => ({ keyword: r.keys[0], impressions: r.impressions, clicks: r.clicks, ctr: r.ctr, position: r.position }));

  if (droppedShort.length) {
    console.log(`   ⏭️  ${droppedShort.length} GSC keyword(s) skipped (< 3 significant words): ${droppedShort.slice(0, 5).join(', ')}${droppedShort.length > 5 ? ', ...' : ''}`);
  }

  // Record first-seen dates for anything new, so "oldest keyword first" ordering below
  // (in main()) has data to work with even for keywords discovered just now.
  updateFirstSeenMap(filtered);

  console.log(`✅ ${filtered.length} potential keywords from ${rows.length} total.`);
  return filtered;
}

function toSlug(kw) {
  return kw.toLowerCase().replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-').replace(/-+/g, '-');
}

function getExistingSlugs() {
  if (!fs.existsSync(CONFIG.CONTENT_DIR)) {
    fs.mkdirSync(CONFIG.CONTENT_DIR, { recursive: true });
    return new Set();
  }
  const slugs = new Set();
  function scan(dir) {
    fs.readdirSync(dir, { withFileTypes: true }).forEach(e => {
      if (e.isDirectory()) scan(path.join(dir, e.name));
      else if (e.name.endsWith('.md')) slugs.add(path.basename(e.name, '.md'));
    });
  }
  scan(CONFIG.CONTENT_DIR);
  return slugs;
}

const EXCLUDED_KEYWORDS_FILE = path.join(__dirname, '..', '.excluded-keywords.json');

// ─── Minimum keyword length (≥3 SIGNIFICANT words) ─────────────────────────────
// General Indonesian conjunctions/prepositions/particles/copulas — words that carry no
// topical meaning on their own and therefore must NOT count toward the "at least 3 words"
// keyword-length requirement below. e.g. "cor jalan dan" is 3 raw words but only 2
// significant ones ("cor", "jalan") — "dan" doesn't count, so this keyword is (correctly)
// treated as too short and skipped.
//
// Deliberately separate from SIMILARITY_STOPWORDS further below: that list ALSO strips
// meaningful business/marketing words (e.g. "jasa", "harga") for a different purpose
// (duplicate-similarity detection) — those words DO carry real SEO intent and must still
// count as significant words here.
const CONJUNCTION_STOPWORDS = new Set([
  'dan', 'atau', 'serta', 'maupun', 'namun', 'tetapi', 'tapi', 'melainkan',
  'adalah', 'yaitu', 'ialah', 'yakni', 'merupakan',
  'ini', 'itu', 'tersebut', 'begini', 'begitu',
  'dengan', 'pada', 'di', 'ke', 'dari', 'untuk', 'oleh', 'akan', 'karena', 'sebab',
  'agar', 'supaya', 'jika', 'kalau', 'apabila', 'meski', 'meskipun', 'walau', 'walaupun',
  'hingga', 'sampai', 'sejak', 'tanpa', 'bagi', 'terhadap', 'antara', 'sebagai', 'seperti',
  'yang', 'para', 'si', 'sang', 'per', 'apa', 'apakah', 'dalam', 'juga', 'bisa', 'dapat', 'pun',
]);

function countSignificantWords(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .filter(w => !CONJUNCTION_STOPWORDS.has(w))
    .length;
}

function hasMinKeywordWords(text, min = 3) {
  return countSignificantWords(text) >= min;
}
// ─────────────────────────────────────────────────────────────────────────────

const SIMILARITY_ALGO_VERSION = 2;

const SIMILARITY_STOPWORDS = new Set([
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

function significantWordsForSimilarity(text) {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/)
    .filter(w => w.length > 2 && !SIMILARITY_STOPWORDS.has(w)); // length > 2 so short but important niche words like "cor" remain
}

function overlapSimilarity(a, b) {
  const wa = new Set(significantWordsForSimilarity(a));
  const wb = new Set(significantWordsForSimilarity(b));
  if (!wa.size || !wb.size) return { sharedCount: 0, jaccard: 0, minWords: 0 };
  const shared = [...wa].filter(w => wb.has(w));
  const union  = wa.size + wb.size - shared.length;
  return { sharedCount: shared.length, jaccard: shared.length / union, minWords: Math.min(wa.size, wb.size) };
}

function isSimilarPair(sharedCount, jaccard, minWords) {
  if (minWords === 0) return false;
  if (minWords <= 2) return sharedCount >= minWords && jaccard >= 0.55;
  return sharedCount >= 3 && jaccard >= 0.42;
}

const INTENT_PATTERNS = [
  ['harga',       /\b(harga|biaya|ongkos|tarif|upah|borongan)\b/i],
  ['definisi',    /\b(apa\s*itu|apakah|pengertian|maksud\s+dari|arti\s+dari)\b/i],
  ['hitung',      /\b(menghitung|hitungan|cara\s+hitung|rumus|kalkulasi)\b/i],
  ['carabuat',    /\b(cara\s+(membuat|memasang|mengatasi|memperbaiki|merawat|menyambung)|pemasangan|pembuatan)\b/i],
  ['jenis',       /\b(jenis|macam|tipe|ragam|perbedaan|dibanding(kan)?|vs)\b/i],
  ['ukuran',      /\b(ukuran|dimensi|kapasitas)\b/i],
  ['masalah',     /\b(penyebab|bocor|retak|rusak|solusi)\b/i],
  ['rekomendasi', /\b(terbaik|rekomendasi|pilihan|cara\s+memilih)\b/i],
];

function detectIntent(text) {
  const tl = text.toLowerCase();
  for (const [name, pattern] of INTENT_PATTERNS) {
    if (pattern.test(tl)) return name;
  }
  return null;
}

function getExistingArticleTexts() {
  const items = [];
  if (!fs.existsSync(CONFIG.CONTENT_DIR)) return items;
  function scan(dir) {
    fs.readdirSync(dir, { withFileTypes: true }).forEach(e => {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { scan(full); return; }
      if (!e.name.endsWith('.md')) return;
      try {
        const raw = fs.readFileSync(full, 'utf8');
        const titleMatch = raw.match(/^title:\s*"((?:[^"\\]|\\.)*)"/m);
        // PagarPanel articles store their keyword as `focus_keyphrase:` (a legacy `keywords:` field is also read).
        const kwMatch     = raw.match(/^focus_keyphrase:\s*"((?:[^"\\]|\\.)*)"/m) || raw.match(/^keywords:\s*"((?:[^"\\]|\\.)*)"/m);
        if (titleMatch) items.push({ file: full, title: titleMatch[1], keyword: kwMatch ? kwMatch[1] : '' });
      } catch {}
    });
  }
  scan(CONFIG.CONTENT_DIR);
  return items;
}

function loadExcludedKeywords() {
  if (!fs.existsSync(EXCLUDED_KEYWORDS_FILE)) return {};
  let raw;
  try { raw = JSON.parse(fs.readFileSync(EXCLUDED_KEYWORDS_FILE, 'utf8')); } catch { return {}; }

  const active = {};
  let released = 0;
  for (const [key, entry] of Object.entries(raw)) {
    if (entry && entry.algoVersion === SIMILARITY_ALGO_VERSION) active[key] = entry;
    else released++;
  }
  if (released > 0) {
    console.log(`   ♻️  ${released} old keywords released from the exclude cache (similarity algorithm updated to v${SIMILARITY_ALGO_VERSION}) — they will be re-evaluated.`);
  }
  return active;
}
function saveExcludedKeywords(obj) {
  fs.writeFileSync(EXCLUDED_KEYWORDS_FILE, JSON.stringify(obj, null, 2));
}

const KEYWORDS_FILE = path.join(__dirname, '..', 'keywords.txt');

function getKeywordsFromFile() {
  if (!fs.existsSync(KEYWORDS_FILE)) return [];
  const allLines = fs.readFileSync(KEYWORDS_FILE, 'utf8').split('\n').map(l => l.trim()).filter(Boolean);

  // Same ≥3-significant-words rule as GSC/Serper (see CONJUNCTION_STOPWORDS above) — this
  // file previously had NO length check at all, so a manually-added short keyword slipped
  // straight through to article generation. Short entries are left in the file (not
  // removed) so a human can see and fix them; they're just skipped for now.
  const tooShort = allLines.filter(kw => !hasMinKeywordWords(kw, 3));
  if (tooShort.length) {
    console.log(`   ⏭️  ${tooShort.length} keyword(s) in keywords.txt skipped (< 3 significant words, left in file for review): ${tooShort.slice(0, 5).join(', ')}${tooShort.length > 5 ? ', ...' : ''}`);
  }

  return allLines
    .filter(kw => hasMinKeywordWords(kw, 3))
    .map(kw => ({ keyword: kw, impressions: 0, clicks: 0, ctr: 0, position: 0 }));
}

function removeProcessedKeywordsFromFile(processedKeywords) {
  if (!fs.existsSync(KEYWORDS_FILE) || !processedKeywords.length) return;
  const usedSet = new Set(processedKeywords.map(k => k.toLowerCase().trim()));
  const remaining = fs.readFileSync(KEYWORDS_FILE, 'utf8').split('\n')
    .map(l => l.trim())
    .filter(l => l && !usedSet.has(l.toLowerCase()));
  fs.writeFileSync(KEYWORDS_FILE, remaining.join('\n') + (remaining.length ? '\n' : ''));
}

// ─── Serper.dev keyword research ───────────────────────────────────────────────
// 2nd-tier keyword source: used only when GSC has nothing new left to process this run.
// See CONFIG.SERPER_* above for cost/budget notes.

function serperSearch(endpoint, body) {
  if (!CONFIG.SERPER_API_KEY) throw new Error('SERPER_API_KEY not found.');
  const payload = JSON.stringify(body);
  return httpRequest(CONFIG.SERPER_HOST, `/${endpoint}`, {
    method: 'POST',
    headers: {
      'X-API-KEY': CONFIG.SERPER_API_KEY.trim(),
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    },
  }, payload).then(r => {
    if (typeof r === 'string') { try { return JSON.parse(r); } catch { return { _raw: r }; } }
    return r || {};
  });
}

function getManualSeedKeywords() {
  const file = CONFIG.SERPER_MANUAL_SEEDS_FILE;
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').map(l => l.trim()).filter(Boolean);
}

// Picks the highest-impression keywords from THIS RUN's GSC results as seeds, so
// Autocomplete/Related Searches/PAA expand around queries already proven to attract real
// searches, instead of guessing blindly. Falls back to [] (manual seeds only) if GSC has
// nothing to offer this run.
function getAutoSeedKeywords(gscKeywordsThisRun, n) {
  if (!gscKeywordsThisRun || !gscKeywordsThisRun.length) return [];
  return [...gscKeywordsThisRun]
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, n)
    .map(k => k.keyword);
}

async function fetchKeywordIdeasFromSerper(seedKeywords) {
  if (IS_DRY_RUN) {
    console.log('   🧪 DRY-RUN: skipping real Serper.dev calls (no credits used).');
    return [];
  }
  if (!CONFIG.SERPER_API_KEY) {
    console.log('   ⚠️  SERPER_API_KEY not set — skipping Serper.dev keyword research.');
    return [];
  }
  if (!seedKeywords.length) {
    console.log('   ⚠️  No seed keywords available (fill seed-keywords.txt, or wait for GSC data).');
    return [];
  }

  console.log(`\n🔬 Researching keyword ideas from Serper.dev for ${seedKeywords.length} seed(s) (budget: ${CONFIG.SERPER_DAILY_BUDGET} credits)...`);

  const ideas = new Set();
  let creditsUsed = 0;

  for (const seed of seedKeywords) {
    if (creditsUsed >= CONFIG.SERPER_DAILY_BUDGET) {
      console.log(`   🛑 Serper.dev budget reached (${CONFIG.SERPER_DAILY_BUDGET} credits) — stopping early this run.`);
      break;
    }
    try {
      // 1 credit: a regular /search call already includes BOTH `relatedSearches` and
      // `peopleAlsoAsk` in the same response (confirmed from serper.dev's own docs/examples).
      const serp = await serperSearch('search', { q: seed, gl: CONFIG.SERPER_COUNTRY, hl: CONFIG.SERPER_LANG });
      creditsUsed++;

      const beforeSearch = ideas.size;
      (serp.relatedSearches || []).forEach(r => r && r.query    && ideas.add(String(r.query).trim()));
      (serp.peopleAlsoAsk   || []).forEach(r => r && r.question && ideas.add(String(r.question).trim()));
      let gotNothing = ideas.size === beforeSearch;
      if (gotNothing) {
        // Diagnose instead of silently burning credits: show what Serper actually returned.
        console.log(`   ⚠️  /search for "${seed}" gave 0 related/PAA ideas. Response keys: [${Object.keys(serp).join(', ')}] — ${JSON.stringify(serp).slice(0, 250)}`);
      }

      // Autocomplete runs when enabled, and ALSO as an automatic fallback when /search returned
      // no related/PAA ideas for this seed (so a quiet SERP doesn't waste the whole run).
      if ((CONFIG.SERPER_USE_AUTOCOMPLETE || gotNothing) && creditsUsed < CONFIG.SERPER_DAILY_BUDGET) {
        // BEST-EFFORT: Serper.dev lists "Autocomplete" as a supported search type, but its
        // exact response field names aren't clearly published. We try a few plausible
        // shapes; if none match, we log the raw response so it can be fixed once instead of
        // silently returning nothing.
        const ac = await serperSearch('autocomplete', { q: seed, gl: CONFIG.SERPER_COUNTRY, hl: CONFIG.SERPER_LANG });
        creditsUsed++;
        const before = ideas.size;
        (ac.suggestions || ac.autocomplete || []).forEach(s => {
          const val = typeof s === 'string' ? s : (s.value || s.query || s.suggestion);
          if (val) ideas.add(val.trim());
        });
        if (ideas.size === before) {
          console.log(`   ⚠️  Autocomplete for "${seed}" returned 0 parsed suggestions — raw response: ${JSON.stringify(ac).slice(0, 300)}`);
        }
      }

      console.log(`   ✓ "${seed}" → ${ideas.size} unique idea(s) so far (${creditsUsed} credit(s) used)`);
    } catch (err) {
      console.error(`   ❌ Serper.dev failed for "${seed}": ${err.message}`);
    }
  }

  const results = [...ideas]
    .filter(kw => hasMinKeywordWords(kw, 3)) // same rule as GSC: ≥3 significant words, conjunctions excluded
    .map(kw => ({ keyword: kw, impressions: 0, clicks: 0, ctr: 0, position: 0 }));

  console.log(`✅ ${results.length} new keyword idea(s) from Serper.dev (${creditsUsed} credit(s) used this run).`);
  return results;
}

// Picks seed keywords with GSC as the primary source and seed-keywords.txt as the
// alternative — NOT merged together. GSC seeds are proven to attract real searches, so
// they're always preferred; seed-keywords.txt only kicks in when GSC has no data this run
// (e.g. a brand-new site, or a GSC fetch returning nothing).
function getSeedKeywords(gscKeywordsThisRun) {
  const autoSeeds = getAutoSeedKeywords(gscKeywordsThisRun, CONFIG.SERPER_AUTO_SEED_COUNT);
  if (autoSeeds.length) {
    console.log(`   🌱 Seeds from GSC (top ${autoSeeds.length} by impressions): ${autoSeeds.join(', ')}`);
    return autoSeeds;
  }
  const manualSeeds = getManualSeedKeywords();
  if (manualSeeds.length) {
    console.log(`   🌱 GSC has no data this run — using seed-keywords.txt instead (${manualSeeds.length} seed(s)).`);
    return manualSeeds;
  }
  return [];
}

// Gathers seeds (GSC-primary, seed-keywords.txt-alternative) and runs the research. Shared
// by --research-only mode and the automatic 2nd-tier fallback in main().
async function runSerperResearch(gscKeywordsThisRun) {
  const seeds = getSeedKeywords(gscKeywordsThisRun);
  return fetchKeywordIdeasFromSerper(seeds);
}

// Appends new keywords to keywords.txt, skipping ones already present (case-insensitive).
// Used to persist Serper.dev ideas that weren't processed this run so they aren't lost.
function appendKeywordsToFile(newKeywords) {
  if (!newKeywords.length) return;
  const existing = new Set(getKeywordsFromFile().map(k => k.keyword.toLowerCase()));
  const toAdd = newKeywords.filter(kw => !existing.has(kw.toLowerCase()));
  if (!toAdd.length) return;
  fs.appendFileSync(KEYWORDS_FILE, toAdd.join('\n') + '\n');
}
// ─────────────────────────────────────────────────────────────────────────────

function findSimilarExisting(keyword, existingItems) {
  const kwIntent = detectIntent(keyword);
  for (const item of existingItems) {
    const itemIntent = detectIntent(item.keyword || '') || detectIntent(item.title || '');
    const candidates = [item.keyword, item.title].filter(Boolean);
    for (const candidate of candidates) {
      const { sharedCount, jaccard, minWords } = overlapSimilarity(keyword, candidate);
      if (!isSimilarPair(sharedCount, jaccard, minWords)) continue;

      if (kwIntent && itemIntent && kwIntent !== itemIntent) continue;

      return item;
    }
  }
  return null;
}

function filterOutSimilarKeywords(keywords) {
  const excluded = loadExcludedKeywords();
  const existingItems = getExistingArticleTexts();
  const kept = [];
  let newlyExcluded = 0;

  for (const item of keywords) {
    const key = item.keyword.toLowerCase().trim();
    if (excluded[key]) continue;

    const similar = findSimilarExisting(item.keyword, existingItems);
    if (similar) {
      excluded[key] = {
        reason: 'similar to existing article',
        matchedFile: path.basename(similar.file),
        matchedTitle: similar.title,
        taggedAt: new Date().toISOString(),
        algoVersion: SIMILARITY_ALGO_VERSION,
      };
      newlyExcluded++;
      console.log(`   ⏭️  Skipping "${item.keyword}" — similar to existing article: "${similar.title}"`);
      continue;
    }
    kept.push(item);
  }

  if (newlyExcluded > 0) saveExcludedKeywords(excluded);
  console.log(`   🔎 ${newlyExcluded} new keywords marked excluded (similar to existing articles), ${Object.keys(excluded).length} total excluded so far.`);
  return kept;
}

// Images already attached to articles generated by this script (generated-articles.log, column 4)
// plus those chosen earlier in THIS run. A reused photo makes sibling articles look duplicated
// (seen 2026-10-08: three "cor lantai 2" articles all got the same AI picture).
const USED_IMAGES_THIS_RUN = new Set();
function getUsedGeneratedImages() {
  const used = new Set(USED_IMAGES_THIS_RUN);
  try {
    const logFile = path.join(__dirname, '..', 'generated-articles.log');
    if (fs.existsSync(logFile)) {
      fs.readFileSync(logFile, 'utf8').split('\n').forEach(l => {
        const img = (l.split('|')[3] || '').trim();
        if (img) used.add(img);
      });
    }
  } catch {}
  return used;
}

async function pickImage(keyword, slug) {
  const imgDir = CONFIG.IMAGES_DIR;
  if (!fs.existsSync(imgDir)) return useGenericOrAIImage(keyword, slug);

  function getImages(dir) {
    let res = [];
    try {
      fs.readdirSync(dir, { withFileTypes: true }).forEach(e => {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) res = res.concat(getImages(full));
        else if (/\.(jpg|jpeg|png|webp)$/i.test(e.name)) res.push(full);
      });
    } catch {}
    return res;
  }

  const allImages = getImages(imgDir);
  if (!allImages.length) return useGenericOrAIImage(keyword, slug);

  // Reuses the same comprehensive stopword filter as duplicate-title detection above
  // (significantWordsForSimilarity/SIMILARITY_STOPWORDS) so "2 words match" means 2 core/
  // content words — conjunctions and particles like "itu", "yang", "apa", "dan", "dari" never
  // count toward the match.
  const words = significantWordsForSimilarity(keyword);

  const usedImages = getUsedGeneratedImages();
  const toUrl = img => img.replace(path.join(__dirname, '..', 'static'), '').replace(/\\/g, '/');
  // Stricter than before: the image name must cover most of the keyword (>= 2 AND >= 70% of
  // its significant words), and an image already used by a generated article is never reused.
  const needed = Math.max(2, Math.ceil(words.length * 0.7));

  const scored = allImages
    .filter(img => !usedImages.has(toUrl(img)))
    .map(img => {
      const name = path.basename(img).toLowerCase().replace(/[-_]/g, ' ');
      const matchCount = words.filter(w => name.includes(w)).length;
      return { img, matchCount };
    });

  const good = scored.filter(s => s.matchCount >= needed);

  if (good.length > 0) {

    const maxMatch = Math.max(...good.map(s => s.matchCount));
    const best = good.filter(s => s.matchCount === maxMatch);
    const chosen = best[Math.floor(Math.random() * best.length)].img;
    console.log(`   🖼️  Matching unused image (${maxMatch}/${words.length} words): ${path.basename(chosen)}`);
    USED_IMAGES_THIS_RUN.add(toUrl(chosen));
    return toUrl(chosen);
  }

  console.log(`   🖼️  No unused image matching ≥70% of the words in "${keyword}" → attempting AI image generation...`);
  return useGenericOrAIImage(keyword, slug);
}

async function useGenericOrAIImage(keyword, slug) {
  const GENERIC = CONFIG.GENERIC_IMAGE;
  if (CONFIG.CF_API_TOKENS.length === 0 || CONFIG.CF_ACCOUNT_IDS.length === 0) {
    console.log(`   🖼️  CLOUDFLARE_API_TOKEN/CLOUDFLARE_ACCOUNT_ID not set → using generic image.`);
    return GENERIC;
  }
  try {
    const aiPath = await generateAIImage(keyword, slug);
    if (aiPath) {
      console.log(`   🖼️  AI image generated & saved: ${aiPath}`);
      return aiPath;
    }
  } catch (err) {
    console.log(`   ⚠️  Failed to generate AI image (${err.message}) → using generic image.`);
  }
  return GENERIC;
}

// Asks the text model to translate a raw Indonesian keyword into an accurate, specific
// English photo-prompt. Deliberately NOT hardcoded to specific categories/rules — PagarPanel covers
// several niches (precast concrete fence panels, U-ditch drainage, box culvert, installation
// pouring, etc.), and new niches or brands would silently fall
// through hardcoded if/else rules. Instead we give the model context about PagarPanel's business and
// let it use its own knowledge of the actual keyword to decide what the image should show.
async function generateImagePromptViaAI(keyword) {
  const systemPrompt = renderTemplate(PROMPTS.imagePrompt.system, { siteName: CONFIG.SITE_NAME });

  const body = JSON.stringify({
    model      : CONFIG.AI_MODEL,
    messages   : [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: renderTemplate(PROMPTS.imagePrompt.userTemplate, { keyword }) },
    ],
    temperature: 0.4,
    max_tokens : 200,
  });

  const maxAttempts = Math.max(1, CONFIG.CF_API_TOKENS.length);
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await httpRequest(
        CONFIG.MODELS_API_HOST,
        buildModelsApiPath(),
        {
          method : 'POST',
          headers: {
            'Authorization'  : `Bearer ${currentCfToken()}`,
            'Content-Type'   : 'application/json',
            'Content-Length' : Buffer.byteLength(body),
          },
        },
        body,
        30000
      );
      const text = result?.choices?.[0]?.message?.content?.trim();
      if (!text) throw new Error('Empty image-prompt response from AI');
      return text;
    } catch (err) {
      lastErr = err;
      if ((err.isRateLimit || err.isAuthError) && attempt < maxAttempts) {
        const reason = err.isRateLimit ? 'rate-limited' : 'auth error';
        console.log(`   🔁 Key #${cfTokenIdx + 1} ${reason} (image prompt) — rotating to next key...`);
        rotateCfToken();
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

// Rule-based fallback used ONLY if the AI prompt-generation call itself fails (network/API
// error) — a last-resort safety net, not the primary logic. Covers PagarPanel's main
// niches so the fallback doesn't collapse everything into one generic bucket.
// Only the MATCHING LOGIC (which scene-hint key applies to this keyword) lives here — the
// actual scene-hint text and template wording live in prompts/generate-articles.json.
function pickSceneHintKey(keyword) {
  const kl = keyword.toLowerCase();
  if (/culvert|gorong|box\s?culvert|saluran\s?air\s?tertutup/.test(kl)) return 'culvert';
  if (/u\s?-?ditch|ditch|drainase|selokan|got\b|saluran/.test(kl)) return 'uditch';
  if (/pagar|panel|tembok|dinding|pembatas|kawat|bronjong/.test(kl)) return 'fence';
  if (/pasang|pemasangan|instalasi|crane|truk|kirim|pengiriman/.test(kl)) return 'install';
  if (/precast|beton|k-?\d{3}|besi|wiremesh/.test(kl)) return 'concrete';
  return 'default';
}
function buildFallbackImagePrompt(keyword) {
  const sceneHint = PROMPTS.fallbackImagePrompt.sceneHints[pickSceneHintKey(keyword)];
  return renderTemplate(PROMPTS.fallbackImagePrompt.template, { sceneHint, keyword, siteName: CONFIG.SITE_NAME });
}

async function buildImagePrompt(keyword) {
  try {
    const aiPrompt = await generateImagePromptViaAI(keyword);
    return aiPrompt + PROMPTS.imagePrompt.styleSuffix;
  } catch (err) {
    console.log(`   ⚠️  AI image-prompt generation failed (${err.message}) → using fallback template.`);
    return buildFallbackImagePrompt(keyword);
  }
}

async function callCloudflareImageAPI(prompt) {
  const { body, contentType } = buildMultipartFormData({
    prompt,
    width : CONFIG.AI_IMAGE_GEN_WIDTH,
    height: CONFIG.AI_IMAGE_GEN_HEIGHT,
  });

  let result;
  const maxRetries = Math.max(2, CONFIG.CF_API_TOKENS.length);
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      result = await httpRequest(
        CONFIG.MODELS_API_HOST,
        buildImageApiPath(),
        {
          method : 'POST',
          headers: {
            'Authorization' : `Bearer ${currentCfToken()}`,
            'Content-Type'  : contentType,
            'Content-Length': body.length,
          },
        },
        body,
        90000 // image generation timeout
      );
      break;
    } catch (err) {
      if ((err.isRateLimit || err.isAuthError) && CONFIG.CF_API_TOKENS.length > 1 && attempt < maxRetries) {
        const reason = err.isRateLimit ? 'rate-limited' : 'auth error';
        console.log(`   🔁 Key #${cfTokenIdx + 1} ${reason} (image gen) — rotating to next key...`);
        rotateCfToken();
        continue;
      }
      if (attempt === maxRetries) throw err;
      const waitMs = attempt * 3000;
      console.log(`   ⚠️  Cloudflare image API failed (attempt ${attempt}/${maxRetries}): ${err.message}. Retrying in ${waitMs/1000}s...`);
      await new Promise(r => setTimeout(r, waitMs));
    }
  }

  const imageB64 = result?.result?.image;
  if (!imageB64) {
    throw new Error(`Cloudflare image response did not contain an image: ${JSON.stringify(result).slice(0, 300)}`);
  }
  return { data: imageB64, mimeType: 'image/jpeg' };
}

async function resizeAndWatermark(imageBuffer) {
  const sharp = getSharp();

  const resized = await sharp(imageBuffer)
    .resize(CONFIG.AI_IMAGE_WIDTH, CONFIG.AI_IMAGE_HEIGHT, { fit: 'cover', position: 'centre' })
    .toBuffer();

  if (!fs.existsSync(CONFIG.WATERMARK_PATH)) {
    console.log(`   ⚠️  Watermark not found at ${CONFIG.WATERMARK_PATH} → saving image without watermark.`);
    return sharp(resized).jpeg({ quality: 85 }).toBuffer();
  }

  const watermarkWidth = Math.round(CONFIG.AI_IMAGE_WIDTH * CONFIG.WATERMARK_WIDTH_RATIO);
  const watermarkResized = await sharp(CONFIG.WATERMARK_PATH)
    .resize({ width: watermarkWidth })
    .ensureAlpha()
    .toBuffer();

  const alphaMultiplier = Math.round(255 * CONFIG.WATERMARK_OPACITY);
  const watermarkTransparent = await sharp(watermarkResized)
    .composite([{
      input: Buffer.from([255, 255, 255, alphaMultiplier]),
      raw  : { width: 1, height: 1, channels: 4 },
      tile : true,
      blend: 'dest-in',
    }])
    .png()
    .toBuffer();

  return sharp(resized)
    .composite([{ input: watermarkTransparent, gravity: 'centre' }])
    .jpeg({ quality: 85 })
    .toBuffer();
}

async function generateAIImage(keyword, slug) {
  console.log(`   🤖 Generating AI image (Cloudflare FLUX.2) for "${keyword}"...`);
  const prompt = await buildImagePrompt(keyword);
  console.log(`   📝 Image prompt: ${prompt.slice(0, 160)}${prompt.length > 160 ? '…' : ''}`);
  const { data } = await callCloudflareImageAPI(prompt);
  const rawBuffer = Buffer.from(data, 'base64');
  const finalBuffer = await resizeAndWatermark(rawBuffer);

  if (!fs.existsSync(CONFIG.BLOG_IMAGES_DIR)) fs.mkdirSync(CONFIG.BLOG_IMAGES_DIR, { recursive: true });
  const fileName = `${slug}.jpg`;
  fs.writeFileSync(path.join(CONFIG.BLOG_IMAGES_DIR, fileName), finalBuffer);

  return `${CONFIG.BLOG_IMAGES_URL}/${fileName}`;
}

// Every generated article goes to the same folder (CONFIG.ARTICLE_FOLDER = "blog"). Kept as a
// function so the folder/`categories:` value stays defined in exactly one place.
function detectArticleCategory() {
  return CONFIG.ARTICLE_FOLDER;
}

// Style-variation banks — text lives in prompts/generate-articles.json, see PROMPTS above.
const OPENING_STYLES  = PROMPTS.openingStyles;
const CLOSING_STYLES  = PROMPTS.closingStyles;
const ADDRESS_STYLES  = PROMPTS.addressStyles;

function pickRandom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
// ─────────────────────────────────────────────────────────────────

async function generateArticle(keyword, relatedCandidates = [], extraNote = '') {
  const openingStyle = pickRandom(OPENING_STYLES);
  const addressStyle  = pickRandom(ADDRESS_STYLES);
  const closingStyle = renderTemplate(pickRandom(CLOSING_STYLES), { addr: addressStyle.name });
  const currentYear   = new Date().getFullYear();

  const prompt = renderTemplate(PROMPTS.article.userTemplate, {
    siteName: CONFIG.SITE_NAME,
    addressInstruction: addressStyle.instruction,
    openingStyle,
    closingStyle,
    keyword,
    currentYear,
    relatedArticles: formatCandidatesForPrompt(relatedCandidates),
  }) + (extraNote ? `\n\nCATATAN TAMBAHAN WAJIB: ${extraNote}` : '');

  if (IS_DRY_RUN) {
    console.log(`   🧪 DRY-RUN: Simulating article generation for "${keyword}"...`);
    const kwTitle = keyword.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    const raw = `JUDUL: ${kwTitle} - Panduan Lengkap dari ${CONFIG.SITE_NAME}
DESCRIPTION: ${keyword.charAt(0).toUpperCase() + keyword.slice(1)} terbaik untuk properti dan proyek konstruksi Anda. Temukan tips, harga, dan solusi dari ${CONFIG.SITE_NAME}.
TAGS: ${keyword.split(' ').slice(0, 3).join(', ')}, pagar panel beton, PagarPanel.co.id
ARTIKEL_MULAI
**${kwTitle}** – salah satu pertanyaan yang sering Kami terima adalah seputar ${keyword}. Artikel ini membahasnya secara ringkas dan praktis.

![${kwTitle}](IMAGE_PLACEHOLDER)

## Memahami ${kwTitle}

${keyword.charAt(0).toUpperCase() + keyword.slice(1)} merupakan salah satu kebutuhan utama dalam pembangunan pagar dan drainase. Di ${CONFIG.SITE_NAME}, Kami melayani penjualan dan pemasangan pagar panel beton, U-ditch, dan box culvert untuk berbagai skala proyek.

## Keunggulan Layanan Kami

- **Mutu beton terjamin** — setiap produk precast sesuai mutu K yang dipesan
- **Harga transparan** — estimasi biaya dijelaskan sejak awal
- **Pengiriman dan pemasangan tepat waktu** — jadwal disesuaikan dengan kesiapan proyek Anda

## Penutup

Demikian pembahasan Kami seputar ${keyword}. Apabila Anda membutuhkan konsultasi lebih lanjut, silakan hubungi Kami melalui tombol **Telepon** atau **WhatsApp** yang tersedia di bawah halaman ini.
`;
    return { raw };
  }

  const body = JSON.stringify({
    model      : CONFIG.AI_MODEL,
    messages   : [
      { role: 'system', content: PROMPTS.article.systemMessage },
      { role: 'user',   content: prompt },
    ],
    temperature: 0.72,
    max_tokens : 4500,
  });

  let result;
  const maxRetries = Math.max(3, CONFIG.CF_API_TOKENS.length);
  let keysTriedThisCall = 0;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      result = await httpRequest(
        CONFIG.MODELS_API_HOST,
        buildModelsApiPath(),
        {
          method : 'POST',
          headers: {
            'Authorization'  : `Bearer ${currentCfToken()}`,
            'Content-Type'   : 'application/json',
            'Content-Length' : Buffer.byteLength(body),
          },
        },
        body
      );
      break;
    } catch (err) {
      if (err.isRateLimit || err.isAuthError) {
        if (CONFIG.CF_API_TOKENS.length > 1 && keysTriedThisCall < CONFIG.CF_API_TOKENS.length - 1) {
          keysTriedThisCall++;
          const reason = err.isRateLimit ? 'rate-limited' : 'auth error';
          console.log(`   🔁 Key #${cfTokenIdx + 1} ${reason} — rotating to next key...`);
          rotateCfToken();
          attempt--; // don't burn a retry budget on a key rotation
          continue;
        }
        if (err.isRateLimit && err.retryAfterSec && err.retryAfterSec <= 90 && attempt < maxRetries) {
          console.log(`   ⏳ Rate limit, waiting ${err.retryAfterSec}s...`);
          await new Promise(r => setTimeout(r, err.retryAfterSec * 1000 + 500));
          continue;
        }
        throw err;
      }
      if (attempt === maxRetries) throw err;
      const waitMs = attempt * 3000;
      console.log(`   ⚠️  Failed (attempt ${attempt}/${maxRetries}): ${err.message}. Retrying in ${waitMs/1000}s...`);
      await new Promise(r => setTimeout(r, waitMs));
    }
  }

  const choice = result.choices?.[0];
  const content = choice?.message?.content;
  if (!content) {
    throw new Error(`AI returned empty content. Raw response: ${JSON.stringify(result).slice(0, 300)}`);
  }
  if (choice.finish_reason === 'length') {
    throw new Error('AI output truncated (finish_reason=length) — increase max_tokens.');
  }
  return { raw: content };
}

function yamlEscape(str) {
  return String(str).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function stripTrailingMarkers(text) {
  const markerPatterns = [
    /^ARTIKEL[_\s]?SELESAI$/i,
    /^SELESAI$/i,
    /^\[?END\]?$/i,
    /^TAMAT$/i,
    /^---+$/,
    /^===+$/,
  ];
  const lines = text.split('\n');
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  while (lines.length && markerPatterns.some(p => p.test(lines[lines.length - 1].trim()))) {
    lines.pop();
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  }
  return lines.join('\n');
}

// PagarPanel article convention: the first line is the bold title followed by an en dash,
// e.g. "**Judul Artikel** – Paragraf pembuka...". If the AI omitted it, this restores it
// without touching the rest of the paragraph.
function ensurePpOpening(body, title) {
  const trimmed = body.replace(/^\s+/, '');
  if (/^\*\*[^*]+\*\*\s*[-–—]/.test(trimmed)) {
    return trimmed.replace(/^(\*\*[^*]+\*\*)\s*[-–—]\s*/, '$1 – ');
  }
  const boldStart = trimmed.match(/^\*\*[^*]+\*\*/);
  if (boldStart) {
    return `${boldStart[0]} – ${trimmed.slice(boldStart[0].length).replace(/^\s+/, '')}`;
  }
  return `**${title}** – ${trimmed}`;
}

function parseAndSave(raw, keyword, slug, imagePath, relatedCandidates = []) {
  const lines  = raw.split('\n');
  let title    = keyword.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  let desc     = '';
  let tags     = [keyword];
  let body     = '';
  let inBody   = false;

  for (const line of lines) {
    const t = line.trim();
    // Strip stray markdown (**bold**, leading #) — the AI sometimes carries the body's
    // "**Judul** - ..." bold-lead-in habit into this JUDUL: line too, which would otherwise
    // land literal asterisks in the YAML title (breaks <title>, meta tags, breadcrumbs).
    if (t.startsWith('JUDUL:'))        { title = t.replace('JUDUL:', '').replace(/\*\*/g, '').replace(/^#+\s*/, '').trim(); continue; }
    if (t.startsWith('DESCRIPTION:'))  { desc  = t.replace('DESCRIPTION:', '').trim(); continue; }
    if (t.startsWith('CATEGORIES:'))   { /* ignored — folder is always CONFIG.ARTICLE_FOLDER */ continue; }
    if (t.startsWith('TAGS:'))         { tags  = t.replace('TAGS:', '').trim().split(',').map(t => t.trim()); continue; }
    if (t === 'ARTIKEL_MULAI')         { inBody = true; continue; }
    if (inBody) body += line + '\n';
  }

  if (!body.trim()) body = raw;
  body = stripTrailingMarkers(body);
  body = ensurePpOpening(body, title);

  body = body.replace(/IMAGE_PLACEHOLDER/g, imagePath);

  if (!body.includes('![')) {
    const paraEnd = body.indexOf('\n\n');
    if (paraEnd !== -1) {
      const imgMarkdown = `\n\n![${title}](${imagePath})\n`;
      body = body.slice(0, paraEnd) + imgMarkdown + body.slice(paraEnd);
    }
  }

  // Turn any [[TABEL_MULAI]]...[[TABEL_SELESAI]] block the AI wrote into a guaranteed-valid
  // Markdown table (see lib/safe-table.js) — never trust raw AI-written "|" table syntax.
  body = renderSafeTables(body);
  if (hasLeftoverTableMarkers(body)) {
    console.log('   ⚠️  Leftover [[TABEL_...]] marker found after table rendering — check article manually.');
  }

  // Safety net: only keep internal links that point to one of the offered candidate URLs,
  // and never more than 2 total — regardless of what the AI actually did.
  body = enforceInternalLinks(body, relatedCandidates.map(c => c.url), 2);

  const today    = new Date().toISOString().split('T')[0];
  const category = detectArticleCategory();
  const safeTitle = yamlEscape(title);
  const safeDesc  = yamlEscape(desc);
  const safeKw    = yamlEscape(keyword);
  const metaTitle = yamlEscape(title.toLowerCase().includes(CONFIG.SITE_NAME.toLowerCase()) ? title : `${title} - ${CONFIG.SITE_NAME}`);
  const tagToml   = tags.filter(Boolean).map(t => `"${yamlEscape(t)}"`).join(', ');

  // Front-matter shape follows the existing PagarPanel articles (title/date/categories/
  // focus_keyphrase/meta_*), plus `description` (read by the theme's <meta name="description">
  // and list pages) and `toc` (theme renders a table of contents when true and the article
  // is longer than params.tocMinWordCount). `categories` keeps the site's existing
  // YAML-list convention (pagarpanel uses `categories: [folder]`, same as its hand-made pages).
  const frontMatter = `---
title: "${safeTitle}"
date: "${today}"
categories: [${category}]
focus_keyphrase: "${safeKw}"
meta_title: "${metaTitle}"
meta_description: "${safeDesc}"
description: "${safeDesc}"
featured_image: "${imagePath}"
tags: [${tagToml}]
toc: true
draft: false
---

`;

  const categoryDir = path.join(CONFIG.CONTENT_DIR, category);
  if (!fs.existsSync(categoryDir)) fs.mkdirSync(categoryDir, { recursive: true });
  const filePath = path.join(categoryDir, `${slug}.md`);

  if (IS_DRY_RUN) {
    const previewPath = path.join(__dirname, `DRY-RUN-${slug}.md`);
    fs.writeFileSync(previewPath, frontMatter + body.trim() + '\n');
    console.log(`   📄 DRY-RUN: Preview → ${previewPath}`);
    return previewPath;
  }

  fs.writeFileSync(filePath, frontMatter + body.trim() + '\n');
  console.log(`   💾 Article saved: ${filePath}`);
  return filePath;
}

const RECENT_OPENINGS_FILE = path.join(__dirname, '..', '.recent-openings.json');
const OPENING_SIMILARITY_WARN = 0.6;

function loadRecentOpenings() {
  if (!fs.existsSync(RECENT_OPENINGS_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(RECENT_OPENINGS_FILE, 'utf8')); } catch { return []; }
}
function saveRecentOpenings(list) {
  fs.writeFileSync(RECENT_OPENINGS_FILE, JSON.stringify(list.slice(-10))); // save last 10 only
}
function getOpeningWords(body, n = 15) {
  return body.trim().split(/\s+/).slice(0, n).join(' ');
}

function openingBigramSimilarity(a, b) {
  function bigrams(str) {
    const s = str.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
    const g = [];
    for (let i = 0; i < s.length - 1; i++) g.push(s.substring(i, i + 2));
    return g;
  }
  const ga = bigrams(a), gb = bigrams(b);
  if (!ga.length || !gb.length) return 0;
  const mapA = new Map(); ga.forEach(g => mapA.set(g, (mapA.get(g) || 0) + 1));
  const mapB = new Map(); gb.forEach(g => mapB.set(g, (mapB.get(g) || 0) + 1));
  let inter = 0;
  for (const [g, c] of mapA) if (mapB.has(g)) inter += Math.min(c, mapB.get(g));
  return (2 * inter) / (ga.length + gb.length);
}

// Non-mutating twin of checkOpeningVariety(): used BEFORE saving, to decide whether to ask the
// model for another attempt. Returns the highest similarity (0..1) against recent openings.
function maxOpeningSimilarity(body) {
  const opening = getOpeningWords(body);
  return loadRecentOpenings().reduce((m, prev) => Math.max(m, openingBigramSimilarity(opening, prev)), 0);
}

function rawArticleBody(raw) {
  const i = raw.indexOf('ARTIKEL_MULAI');
  return (i >= 0 ? raw.slice(i + 'ARTIKEL_MULAI'.length) : raw).trim();
}

const MIN_WORDS_BEFORE_RETRY = 800; // target is 900-1100; below this we ask for another attempt
const MAX_ARTICLE_ATTEMPTS   = 3;

// Generates, then re-generates (max MAX_ARTICLE_ATTEMPTS) when the draft is too short or its
// opening is too close to a recent article. Keeps the best attempt if none is perfect.
async function generateArticleWithRetries(keyword, relatedCandidates) {
  let best = null;
  let note = '';
  for (let attempt = 1; attempt <= MAX_ARTICLE_ATTEMPTS; attempt++) {
    const { raw } = await generateArticle(keyword, relatedCandidates, note);
    if (IS_DRY_RUN) return { raw };
    const body  = rawArticleBody(raw);
    const words = body.split(/\s+/).filter(Boolean).length;
    const sim   = maxOpeningSimilarity(body);
    const tooShort = words < MIN_WORDS_BEFORE_RETRY;
    const tooSimilar = sim >= OPENING_SIMILARITY_WARN;
    const score = Math.min(words, 1000) - (tooSimilar ? 400 : 0);
    if (!best || score > best.score) best = { raw, score };
    if (!tooShort && !tooSimilar) return { raw };
    console.log(`   🔁 Attempt ${attempt}/${MAX_ARTICLE_ATTEMPTS}: ${words} kata, opening similarity ${(sim*100).toFixed(0)}% → ${attempt < MAX_ARTICLE_ATTEMPTS ? 'regenerating' : 'keeping best attempt'}.`);
    const notes = [];
    if (tooShort)   notes.push(`Draft sebelumnya hanya ${words} kata. Artikel WAJIB 950-1100 kata: kembangkan tiap H2 menjadi 2-3 paragraf utuh dengan contoh konkret, angka, dan penjelasan — jangan meringkas.`);
    if (tooSimilar) notes.push('Paragraf pembuka draft sebelumnya terlalu mirip dengan artikel lain. Buka dengan sudut pandang, kalimat, dan pilihan kata yang BERBEDA total (mulai dari fakta, masalah, atau pertanyaan yang lain).');
    note = notes.join(' ');
  }
  return { raw: best.raw };
}

function checkOpeningVariety(body) {
  const opening = getOpeningWords(body);
  const recent = loadRecentOpenings();
  const issues = [];
  for (const prev of recent) {
    const score = openingBigramSimilarity(opening, prev);
    if (score >= OPENING_SIMILARITY_WARN) {
      issues.push(`⚠️  Opening is similar (${(score*100).toFixed(0)}%) to a previous article: "${prev.slice(0, 60)}..."`);
    }
  }
  recent.push(opening);
  saveRecentOpenings(recent);
  return issues;
}
// ─────────────────────────────────────────────────────────────────────────────

function validateArticle(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const issues  = [];

  if (!content.includes('title:'))          issues.push('❌ title tidak ada');
  if (!content.includes('date:'))           issues.push('❌ date tidak ada');
  if (!content.includes('description:'))    issues.push('❌ description tidak ada');
  if (!content.includes('featured_image:')) issues.push('❌ featured_image tidak ada');
  if (!content.includes('categories:'))     issues.push('❌ categories tidak ada');
  if (!content.includes('focus_keyphrase:')) issues.push('❌ focus_keyphrase tidak ada');
  if (!content.includes('toc: true'))       issues.push('⚠️  toc tidak aktif');

  const bodyOnly = content.replace(/---[\s\S]*?---/, '').trim();
  const wordCount = bodyOnly.split(/\s+/).length;
  if (wordCount < 300) issues.push(`⚠️  Konten terlalu pendek: ${wordCount} kata`);

  const openingIssues = checkOpeningVariety(bodyOnly);
  issues.push(...openingIssues);

  // Internal links are already hard-capped at 2 by enforceInternalLinks() before this file
  // was written — this is just a visibility check in case that logic is ever bypassed.
  const internalLinkCount = (bodyOnly.match(/(?<!!)\[[^\]]+\]\(\/[^)\s]+\/\)/g) || []).length;
  if (internalLinkCount > 2) issues.push(`❌ ${internalLinkCount} internal link ditemukan (maksimal 2) — periksa enforceInternalLinks()`);

  const INFORMAL_WORDS = ['nggak', 'ngga', 'gimana', 'yuk', 'nah', 'lho', 'nih', 'banget', 'kayak', 'gitu', 'aja'];
  const foundInformal = INFORMAL_WORDS.filter(w => new RegExp(`\\b${w}\\b`, 'i').test(bodyOnly));
  if (foundInformal.length) issues.push(`⚠️  Kata tidak baku terdeteksi: ${foundInformal.join(', ')}`);

  // Price-disclaimer policy check (soft warning, not a hard reject — human review can confirm).
  const mentionsPrice = /Rp\s?\d[\d.,]*/.test(bodyOnly);
  const hasDisclaimer = /(estimasi|dapat berubah|bisa berubah|sewaktu-waktu)/i.test(bodyOnly);
  if (mentionsPrice && !hasDisclaimer) {
    issues.push('⚠️  Artikel menyebut harga (Rp) tapi tidak ada kalimat disclaimer estimasi — cek manual.');
  }

  // Stale-year check (soft warning): catches years the AI wrote that are already outdated
  // relative to actual publish time (e.g. leftover "harga 2018/2019/2020" style examples).
  const currentYear = new Date().getFullYear();
  const staleYears = [...new Set((bodyOnly.match(/\b(19|20)\d{2}\b/g) || [])
    .map(Number)
    .filter(y => y >= 2000 && y < currentYear))];
  if (staleYears.length) {
    issues.push(`⚠️  Tahun usang terdeteksi di isi artikel: ${staleYears.join(', ')} — cek manual (lihat ATURAN TAHUN di prompt).`);
  }

  if (issues.length === 0) {
    console.log(`   ✅ Validasi OK — ${wordCount} kata`);
  } else {
    console.log(`   ⚠️  Validasi ditemukan ${issues.length} masalah:`);
    issues.forEach(i => console.log(`      ${i}`));
  }
  return issues;
}
// ─────────────────────────────────────────────────────────────────────────────

// ─── Diagnostic: verify each CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN pair ────────────
// Makes one minimal (max_tokens=1) real call per pair against the EXACT SAME endpoint used
// in production, so a ✅/❌ here means exactly what it says — no guessing via some other
// Cloudflare verification endpoint that might behave differently. Run with --verify-cf.
async function verifyCfPairs() {
  console.log(`\n🔍 Verifying CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN pair(s)`);
  console.log(`${'─'.repeat(55)}\n`);

  if (CONFIG.CF_API_TOKENS.length === 0) { console.log('❌ CLOUDFLARE_API_TOKEN not found.'); return; }
  if (CONFIG.CF_ACCOUNT_IDS.length === 0) { console.log('❌ CLOUDFLARE_ACCOUNT_ID not found.'); return; }

  let anyFailed = false;
  for (let i = 0; i < CONFIG.CF_API_TOKENS.length; i++) {
    const token = CONFIG.CF_API_TOKENS[i];
    const accountId = CONFIG.CF_ACCOUNT_IDS[i] || CONFIG.CF_ACCOUNT_IDS[0];
    const label = `Pair ${i + 1} (account ...${accountId.slice(-6)})`;
    try {
      const body = JSON.stringify({
        model: CONFIG.AI_MODEL,
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 1,
      });
      await httpRequest(
        CONFIG.MODELS_API_HOST,
        `/client/v4/accounts/${accountId}/ai/v1/chat/completions`,
        {
          method: 'POST',
          headers: {
            'Authorization'  : `Bearer ${token}`,
            'Content-Type'   : 'application/json',
            'Content-Length' : Buffer.byteLength(body),
          },
        },
        body,
        20000
      );
      console.log(`   ✅ ${label}: OK`);
    } catch (err) {
      anyFailed = true;
      console.log(`   ❌ ${label}: ${err.message}`);
    }
  }

  console.log(anyFailed
    ? '\n⚠️  One or more pairs failed — check the ❌ ones above: verify the token is valid, has ' +
      'Workers AI permission, and is PAIRED with the correct account (same line number in both secrets).'
    : '\n✅ All pairs authenticated successfully.');
}
// ─────────────────────────────────────────────────────────────────────────────

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  if (VERIFY_CF) {
    await verifyCfPairs();
    return;
  }

  if (RESEARCH_ONLY) {
    console.log(`\n🔬 Serper.dev Keyword Research ${IS_DRY_RUN ? '[DRY-RUN MODE]' : ''}`);
    console.log(`${'─'.repeat(55)}\n`);
    const gscKeywords = await fetchKeywordsFromGSC();
    const ideas = await runSerperResearch(gscKeywords);
    if (!ideas.length) {
      console.log('\nNo new keyword ideas found.');
      return;
    }
    appendKeywordsToFile(ideas.map(k => k.keyword));
    console.log(`\n✅ ${ideas.length} new idea(s) appended to keywords.txt:`);
    ideas.forEach(k => console.log(`   • ${k.keyword}`));
    return;
  }

  console.log(`\n🚀 Generate Articles ${IS_DRY_RUN ? '[DRY-RUN MODE]' : '[PRODUCTION]'}`);
  console.log(`${'─'.repeat(55)}\n`);

  if (!IS_DRY_RUN) {
    if (CONFIG.CF_API_TOKENS.length === 0) throw new Error('CLOUDFLARE_API_TOKEN not found.');
    if (CONFIG.CF_ACCOUNT_IDS.length === 0) throw new Error('CLOUDFLARE_ACCOUNT_ID not found.');
    if (!CONFIG.GSC_CREDENTIALS.client_email) throw new Error('Invalid GSC_CREDENTIALS.');
    if (CONFIG.CF_API_TOKENS.length > 1) {
      const rotationKind = CONFIG.CF_ACCOUNT_IDS.length > 1
        ? `${CONFIG.CF_API_TOKENS.length} account+token pairs`
        : `${CONFIG.CF_API_TOKENS.length} tokens on 1 account`;
      console.log(`🔑 Rolling across ${rotationKind} (rolling on rate limit)\n`);
    }
  }

  const keywords = await fetchKeywordsFromGSC();

  const existingSlugs = getExistingSlugs();
  console.log(`\n📁 ${existingSlugs.size} articles already exist in content/categories/`);

  function selectFromSource(rawKeywords, label) {
    if (!rawKeywords.length) return [];
    const newKws = rawKeywords.filter(k => !existingSlugs.has(toSlug(k.keyword)));
    if (!newKws.length) {
      console.log(`   (${label}) All keywords already have articles (slug conflict).`);
      return [];
    }
    console.log(`\n🔎 (${label}) Checking similarity of ${newKws.length} keywords against existing articles...`);
    return filterOutSimilarKeywords(newKws);
  }

  let uniqueKeywords = [];
  let usingFallback  = false;   // true whenever NOT using fresh GSC data (skips "oldest first" sort below)
  let sourceLabel    = 'GSC';

  if (keywords.length) {
    uniqueKeywords = selectFromSource(keywords, 'GSC');
  } else {
    console.log('⚠️  No keywords from GSC (empty/exhausted).');
  }

  // 2nd tier: GSC is dry — research fresh keyword ideas via Serper.dev (Related Searches +
  // People Also Ask), seeded primarily from GSC's own top keywords, falling back to
  // seed-keywords.txt only if GSC has no data at all.
  if (!uniqueKeywords.length) {
    console.log(`\n🔬 No new keywords from GSC — trying Serper.dev keyword research...`);
    const serperKeywords = await runSerperResearch(keywords);

    if (serperKeywords.length) {
      uniqueKeywords = selectFromSource(serperKeywords, 'Serper');
      usingFallback = true;
      sourceLabel = 'Serper';

      // Anything beyond what this run will actually process gets saved to keywords.txt
      // so it isn't lost — the keywords.txt tier will pick it up on a future run.
      if (uniqueKeywords.length > CONFIG.MAX_ARTICLES) {
        const leftover = uniqueKeywords.slice(CONFIG.MAX_ARTICLES).map(k => k.keyword);
        appendKeywordsToFile(leftover);
        console.log(`   💾 ${leftover.length} unused idea(s) saved to keywords.txt for a future run.`);
      }
    }
  }

  // 3rd tier (last resort): GSC and Serper.dev both came up empty — fall back to the
  // manually-curated queue in keywords.txt (this also includes any leftover Serper.dev
  // ideas saved there by a previous run).
  if (!uniqueKeywords.length) {
    console.log(`\n📄 No new keywords from GSC or Serper.dev — falling back to keywords.txt...`);
    const fileKeywords = getKeywordsFromFile();
    if (fileKeywords.length) {
      console.log(`   📄 ${fileKeywords.length} keywords found in keywords.txt.`);
      uniqueKeywords = selectFromSource(fileKeywords, 'keywords.txt');
      usingFallback = true;
      sourceLabel = 'keywords.txt';
    } else {
      console.log('   keywords.txt not found or empty.');
    }
  }

  if (!uniqueKeywords.length) {
    console.log('   No new keywords from GSC, Serper.dev, or keywords.txt. Done — nothing to generate.');
    return;
  }

  // Process OLDEST keywords first, not highest-impression first — there are far more
  // keywords sitting in the backlog than MAX_ARTICLES processes per run, so always picking
  // by impression score means low-traffic/long-tail keywords could wait indefinitely.
  if (usingFallback) {
    // keywords.txt and Serper.dev ideas both carry impressions:0 (no real GSC score to rank
    // by). keywords.txt's getKeywordsFromFile() already returns entries top-to-bottom, and
    // Array.filter()/sort() preserve that order, so the oldest-added line is naturally
    // processed first. Serper.dev ideas have no meaningful order to preserve either — no
    // re-sort needed for either source.
  } else {
    const firstSeenMap = loadFirstSeenMap();
    uniqueKeywords.sort((a, b) => {
      const aDate = firstSeenMap[a.keyword.toLowerCase().trim()] || '9999-99-99';
      const bDate = firstSeenMap[b.keyword.toLowerCase().trim()] || '9999-99-99';
      if (aDate !== bDate) return aDate < bDate ? -1 : 1; // oldest first
      return (b.impressions * (1 - b.ctr)) - (a.impressions * (1 - a.ctr)); // tie-break: opportunity score
    });
  }

  const toProcess = uniqueKeywords.slice(0, IS_DRY_RUN ? uniqueKeywords.length : CONFIG.MAX_ARTICLES);
  console.log(`\n📝 Will generate ${toProcess.length} articles (source: ${sourceLabel}):\n`);

  // Built ONCE per run and reused for every keyword below — scans content/{category}/*.md
  // (all categories) so new articles can link to genuinely related existing
  // articles anywhere on the site, not just other posts in the same folder.
  console.log(`🔗 Indexing existing articles for internal-link candidates...`);
  const articleIndex   = buildArticleIndex(CONFIG.CONTENT_ROOT_DIR);
  const knownCategories = [...new Set(articleIndex.map(a => a.category))];
  console.log(`   ${articleIndex.length} articles indexed across ${knownCategories.length} categories.\n`);

  const results = [];

  for (const item of toProcess) {
    const slug = toSlug(item.keyword);
    console.log(`\n[${toProcess.indexOf(item) + 1}/${toProcess.length}] "${item.keyword}"`);
    console.log(`   📊 Impressions: ${item.impressions} | Position: ${item.position.toFixed(1)} | CTR: ${(item.ctr*100).toFixed(1)}%`);
    console.log(`   🔑 Slug: ${slug} | Folder: categories/${detectArticleCategory()}`);

    try {
      const categoryHint = guessCategoryHint(item.keyword, knownCategories);
      const relatedCandidates = findRelatedCandidates(
        { text: item.keyword, excludeUrl: `/categories/${detectArticleCategory()}/${slug}/`, categoryHint },
        articleIndex,
        { max: 6 }
      );
      console.log(`   🔗 ${relatedCandidates.length} related article candidate(s) found for internal linking.`);

      const imgPath  = await pickImage(item.keyword, slug);
      const { raw } = await generateArticleWithRetries(item.keyword, relatedCandidates);
      const filePath = parseAndSave(raw, item.keyword, slug, imgPath, relatedCandidates);
      const issues   = validateArticle(filePath);
      results.push({ keyword: item.keyword, slug, filePath, imgPath, issues });
    } catch (err) {
      console.error(`   ❌ Failed: ${err.message}`);
    }

    if (!IS_DRY_RUN && toProcess.indexOf(item) < toProcess.length - 1) {
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  console.log(`\n${'─'.repeat(55)}`);
  console.log(`✅ Done: ${results.length} articles generated\n`);
  results.forEach(r => {
    const status = r.issues.length === 0 ? '✅' : '⚠️ ';
    console.log(`  ${status} ${r.filePath}`);
  });

  if (sourceLabel === 'keywords.txt') {
    removeProcessedKeywordsFromFile(toProcess.map(k => k.keyword));
    console.log(`\n📄 ${toProcess.length} keywords removed from keywords.txt (processed).`);
  }
  // Note: sourceLabel === 'Serper' doesn't need a removal step — those keywords were
  // never written to keywords.txt in the first place (only the *leftover*, unprocessed
  // ideas were saved there, a few steps above).

  if (!IS_DRY_RUN) {
    const logPath = path.join(__dirname, '..', 'generated-articles.log');
    const entry   = results.map(r =>
      `${new Date().toISOString()} | ${r.keyword} | ${r.slug} | ${r.imgPath}`
    ).join('\n');
    fs.appendFileSync(logPath, entry + '\n');
  }
}

main().catch(err => {
  console.error('\n💥 Fatal error:', err.message);
  process.exit(1);
});