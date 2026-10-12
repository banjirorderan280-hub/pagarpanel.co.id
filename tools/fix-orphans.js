/**
 * fix-orphans.js
 *
 * LAYER 2 — for each orphan in orphans.json (produced by find-orphans.js), ask AI to find ONE
 * natural sentence in a candidate donor article and insert ONE internal link to the orphan.
 *
 * This is deliberately a MUCH narrower task than revise-articles.js: the AI is asked to quote
 * back ONE existing sentence VERBATIM plus that same sentence with a link inserted. The script
 * applies it as an EXACT STRING SUBSTITUTION (donorBody.replace(original, updated)):
 *   - if "original" doesn't appear in the donor file EXACTLY ONCE, nothing is written;
 *   - if "updated" doesn't contain exactly one link pointing at the exact orphan URL, rejected;
 *   - if "updated" (link stripped back out) differs too much in length from "original", rejected.
 * Everything else in the donor file (frontmatter, images, shortcodes, every other sentence) is
 * byte-identical to before — only `lastmod:` is bumped.
 *
 * WORKFLOW:
 *   1. Read candidates from orphans.json (run tools/find-orphans.js first).
 *   2. Process up to LIMIT orphans per run (progress kept in .orphan-fix-progress.json).
 *   3. For each orphan, try its donors in order (best match first) until one produces a valid,
 *      verified insertion, or all donors are exhausted.
 *
 * USAGE:
 *   node tools/fix-orphans.js --dry-run            → preview without modifying files
 *   node tools/fix-orphans.js --apply --limit=10   → fix up to 10 orphans this session
 *   node tools/fix-orphans.js --verify-cf          → test each CLOUDFLARE_ACCOUNT_ID +
 *       CLOUDFLARE_API_TOKEN pair independently.
 *
 * REQUIRES: CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN (Workers AI), orphans.json.
 * No npm dependencies (Node built-ins only).
 */

const fs    = require('fs');
const path  = require('path');
const https = require('https');

const PROMPTS = require('./prompts/fix-orphans.json');
const { parseAIResponse, validateInsertion, splitFrontMatter, applyInsertion } = require('./lib/orphan-link.js');

function renderTemplate(str, vars) {
  return str.replace(/\{\{(\w+)\}\}/g, (_, key) => (key in vars ? vars[key] : `{{${key}}}`));
}

const ARGS  = process.argv.slice(2);
const APPLY = ARGS.includes('--apply');
const VERIFY_CF = ARGS.includes('--verify-cf');
const LIMIT_ARG = (ARGS.find(a => a.startsWith('--limit=')) || '').replace('--limit=', '');
const LIMIT = LIMIT_ARG ? parseInt(LIMIT_ARG, 10) : 10;
const DIR_ARG = (ARGS.find(a => a.startsWith('--dir=')) || '--dir=content').replace('--dir=', '');

const CONTENT_DIR  = path.join(process.cwd(), DIR_ARG);
const ORPHANS_FILE = path.join(process.cwd(), 'orphans.json');
const PROGRESS_FILE = path.join(process.cwd(), '.orphan-fix-progress.json');
const LOG_FILE      = path.join(process.cwd(), 'orphan-fixes.log');

// ─── Cloudflare Workers AI — same convention as generate-articles.js / revise-articles.js.
// CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN may each hold MULTIPLE values (one per line or
// comma-separated). N ids + N tokens pair 1:1 by line order; 1 id + N tokens rotate on one account.
// Each file keeps its OWN copy of this block (see revise-articles.js) — keep them in sync by hand.
function parseTokens(raw) {
  return (raw || '').split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
}

const CONFIG = {
  CF_ACCOUNT_IDS: parseTokens(process.env.CLOUDFLARE_ACCOUNT_ID),
  CF_API_TOKENS : parseTokens(process.env.CLOUDFLARE_API_TOKEN),
  HOST        : 'api.cloudflare.com',
  MODEL       : '@cf/aisingapore/gemma-sea-lion-v4-27b-it',
  TIMEOUT_MS  : 60000,
  MAX_RETRIES_PER_ORPHAN: 2,
};

CONFIG.CF_ACCOUNT_IDS.forEach((id, i) => {
  if (!/^[a-f0-9]{32}$/i.test(id)) {
    console.warn(`⚠️  CLOUDFLARE_ACCOUNT_ID line ${i + 1} doesn't look like a valid Cloudflare account ID ` +
      `(expected 32 hex characters, got ${id.length} chars: "${id}").`);
  }
});
if (CONFIG.CF_ACCOUNT_IDS.length > 1 && CONFIG.CF_ACCOUNT_IDS.length !== CONFIG.CF_API_TOKENS.length) {
  console.warn(`⚠️  CLOUDFLARE_ACCOUNT_ID has ${CONFIG.CF_ACCOUNT_IDS.length} line(s) but CLOUDFLARE_API_TOKEN has ` +
    `${CONFIG.CF_API_TOKENS.length} line(s). For multi-account rotation these must match 1:1, same order.`);
}

let tokenIdx = 0;
function currentToken() { return CONFIG.CF_API_TOKENS[tokenIdx] || ''; }
function currentAccountId() { return CONFIG.CF_ACCOUNT_IDS[tokenIdx] || CONFIG.CF_ACCOUNT_IDS[0] || ''; }
function currentPath() { return `/client/v4/accounts/${currentAccountId()}/ai/v1/chat/completions`; }
function rotateToken() { tokenIdx = (tokenIdx + 1) % CONFIG.CF_API_TOKENS.length; }

function log(msg) { console.log(msg); }

async function verifyCfPairs() {
  log(`\n🔍 Verifying CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN pair(s)`);
  log(`${'─'.repeat(60)}\n`);
  if (CONFIG.CF_API_TOKENS.length === 0) { log('❌ CLOUDFLARE_API_TOKEN not found.'); return; }
  if (CONFIG.CF_ACCOUNT_IDS.length === 0) { log('❌ CLOUDFLARE_ACCOUNT_ID not found.'); return; }

  let anyFailed = false;
  for (let i = 0; i < CONFIG.CF_API_TOKENS.length; i++) {
    const token = CONFIG.CF_API_TOKENS[i];
    const accountId = CONFIG.CF_ACCOUNT_IDS[i] || CONFIG.CF_ACCOUNT_IDS[0];
    const label = `Pair ${i + 1} (account ...${accountId.slice(-6)})`;
    try {
      const body = JSON.stringify({ model: CONFIG.MODEL, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 });
      await httpRequest(CONFIG.HOST, `/client/v4/accounts/${accountId}/ai/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, body, 20000);
      log(`   ✅ ${label}: OK`);
    } catch (err) {
      anyFailed = true;
      log(`   ❌ ${label}: ${err.message}`);
    }
  }
  log(anyFailed ? '\n⚠️  One or more pairs failed.' : '\n✅ All pairs authenticated successfully.');
}

function httpRequest(hostname, reqPath, options, body, timeoutMs = CONFIG.TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path: reqPath, ...options }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data)); } catch { resolve(data); }
        } else if (res.statusCode === 429) {
          const err = new Error(`Rate limited: ${data.slice(0, 200)}`);
          err.isRateLimit = true;
          err.retryAfterSec = res.headers['retry-after'] ? parseInt(res.headers['retry-after'], 10) : null;
          reject(err);
        } else {
          const err = new Error(`HTTP ${res.statusCode}: ${data.slice(0, 300)}`);
          err.statusCode = res.statusCode;
          err.isAuthError = (res.statusCode === 401 || res.statusCode === 403);
          reject(err);
        }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`Timeout after ${timeoutMs / 1000}s`)));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function callAI(messages, retries = 3) {
  const body = JSON.stringify({ model: CONFIG.MODEL, messages, temperature: 0.4, max_tokens: 2048 });
  let keysTriedThisCall = 0;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const result = await httpRequest(CONFIG.HOST, currentPath(), {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${currentToken()}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, body);
      const choice = result?.choices?.[0];
      const content = choice?.message?.content;
      if (!content) throw new Error(`AI returned empty content. Raw response: ${JSON.stringify(result).slice(0, 300)}`);
      return content;
    } catch (err) {
      if (err.isRateLimit || err.isAuthError) {
        if (CONFIG.CF_API_TOKENS.length > 1 && keysTriedThisCall < CONFIG.CF_API_TOKENS.length - 1) {
          keysTriedThisCall++;
          rotateToken();
          attempt--;
          continue;
        }
        if (err.isRateLimit && err.retryAfterSec && err.retryAfterSec <= 90 && attempt < retries) {
          await new Promise(r => setTimeout(r, err.retryAfterSec * 1000 + 500));
          continue;
        }
        throw err;
      }
      if (attempt === retries) throw err;
      await new Promise(r => setTimeout(r, attempt * 3000));
    }
  }
}

async function main() {
  if (VERIFY_CF) { await verifyCfPairs(); return; }

  log(`\n🕸️  fix-orphans — insert one internal link per orphan article (narrow, verified substitution)`);
  log(`   Mode  : ${APPLY ? 'APPLY (will write files)' : 'DRY-RUN (preview only)'}`);
  log(`   Limit : ${LIMIT} orphan(s) this run`);
  log(`${'─'.repeat(60)}\n`);

  if (!fs.existsSync(ORPHANS_FILE)) {
    log(`❌ ${ORPHANS_FILE} not found — run: node tools/find-orphans.js first.`);
    process.exit(1);
  }
  if (!APPLY && CONFIG.CF_API_TOKENS.length === 0) {
    log('ℹ️  No CLOUDFLARE_API_TOKEN set — dry-run will still show what WOULD be attempted, but cannot call AI.');
  }
  if (APPLY && CONFIG.CF_API_TOKENS.length === 0) {
    throw new Error('CLOUDFLARE_API_TOKEN not set — required for --apply.');
  }

  const orphansData = JSON.parse(fs.readFileSync(ORPHANS_FILE, 'utf8'));
  const orphans = (orphansData.orphans || []).filter(o => o.donors && o.donors.length > 0);
  log(`📄 ${orphansData.orphanCount} orphan(s) total, ${orphans.length} with at least 1 donor candidate.\n`);

  const progress = fs.existsSync(PROGRESS_FILE)
    ? JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'))
    : { fixed: [], failed: {} };

  const todo = orphans.filter(o => !progress.fixed.includes(o.url) && (progress.failed[o.url] || 0) < CONFIG.MAX_RETRIES_PER_ORPHAN);
  log(`   Already fixed before : ${progress.fixed.length}`);
  log(`   Awaiting a fix       : ${todo.length}`);
  log(`   Will process this run: ${Math.min(LIMIT, todo.length)}\n`);

  let processed = 0, success = 0, failedThisSession = 0;
  const logLines = [];

  for (const orphan of todo) {
    if (processed >= LIMIT) break;
    processed++;
    log(`🔗 [${processed}/${Math.min(LIMIT, todo.length)}] Orphan: ${orphan.title} (${orphan.url})`);

    let fixedThisOrphan = false;
    let lastReason = 'tidak ada kandidat donor';

    for (const donor of orphan.donors) {
      const donorFilePath = path.join(CONTENT_DIR, donor.url.slice(1, -1) + '.md');
      if (!fs.existsSync(donorFilePath)) { lastReason = `file donor tidak ditemukan: ${donor.url}`; continue; }

      const raw = fs.readFileSync(donorFilePath, 'utf8');
      const parsed = splitFrontMatter(raw);
      if (!parsed) { lastReason = `frontmatter donor tidak terbaca: ${donor.url}`; continue; }

      log(`   → Mencoba donor: ${donor.title} (${donor.url})`);

      try {
        const messages = [
          { role: 'system', content: PROMPTS.linkInsertion.systemTemplate },
          { role: 'user', content: renderTemplate(PROMPTS.linkInsertion.userTemplate, {
              donorTitle: donor.title, donorUrl: donor.url, donorBody: parsed.body,
              orphanTitle: orphan.title, orphanUrl: orphan.url, orphanExcerpt: orphan.excerpt || '(tidak ada ringkasan)',
            }) },
        ];

        const rawAI = CONFIG.CF_API_TOKENS.length ? await callAI(messages) : null;
        if (!rawAI) { lastReason = 'CLOUDFLARE_API_TOKEN tidak diset (dry-run tanpa AI)'; break; }

        const parsedAI = parseAIResponse(rawAI);
        if (parsedAI.noMatch) { lastReason = `AI: tidak ada kalimat cocok di donor ini`; continue; }
        if (parsedAI.parseError) { lastReason = `gagal parse respons AI: ${parsedAI.parseError}`; continue; }

        const validationError = validateInsertion(parsed.body, orphan.url, parsedAI.original, parsedAI.updated);
        if (validationError) { lastReason = `ditolak validasi: ${validationError}`; log(`     ❌ ${lastReason}`); continue; }

        log(`     ✅ Kalimat ditemukan & tervalidasi.`);
        log(`        Asli : "${parsedAI.original.slice(0, 100)}${parsedAI.original.length > 100 ? '…' : ''}"`);
        log(`        Baru : "${parsedAI.updated.slice(0, 100)}${parsedAI.updated.length > 100 ? '…' : ''}"`);

        if (APPLY) {
          const newFileContent = applyInsertion(parsed.rawMatter, parsed.body, parsedAI.original, parsedAI.updated, new Date().toISOString().split('T')[0]);
          fs.writeFileSync(donorFilePath, newFileContent);
          progress.fixed.push(orphan.url);
        }

        success++;
        fixedThisOrphan = true;
        logLines.push(`SUCCESS,${orphan.url},"linked from ${donor.url}"`);
        break; // one link is enough for this orphan — stop trying other donors
      } catch (err) {
        if (err.isAuthError || err.isRateLimit) {
          // Every key just failed: all remaining orphans would fail identically — stop now.
          log(`\n🛑 ${err.isAuthError ? 'Authentication error' : 'Rate limited'} on all keys. Progress saved. Run "node tools/fix-orphans.js --verify-cf" to diagnose.`);
          if (APPLY) {
            fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
            if (logLines.length) fs.appendFileSync(LOG_FILE, logLines.join('\n') + '\n');
          }
          return;
        }
        lastReason = `error AI: ${err.message}`;
        log(`     ⚠️  ${lastReason}`);
      }
    }

    if (!fixedThisOrphan) {
      log(`   ❌ Tidak berhasil disambungkan (${lastReason}).`);
      progress.failed[orphan.url] = (progress.failed[orphan.url] || 0) + 1;
      failedThisSession++;
      logLines.push(`FAILED,${orphan.url},"${lastReason}"`);
    }
  }

  if (APPLY) {
    fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
    if (logLines.length) fs.appendFileSync(LOG_FILE, logLines.join('\n') + '\n');
  }

  log(`\n${'─'.repeat(60)}`);
  log(`✅ Fixed this session : ${success}`);
  log(`❌ Failed this session: ${failedThisSession}`);
  const stillTodo = orphans.filter(o => !progress.fixed.includes(o.url) && (progress.failed[o.url] || 0) < CONFIG.MAX_RETRIES_PER_ORPHAN).length;
  log(`⏳ Remaining          : ${stillTodo}`);
  if (!APPLY) log(`\nℹ️  Dry-run — no files were modified. Re-run with --apply to write changes.`);
}

main().catch(err => {
  console.error('\n💥 Fatal error:', err.message);
  process.exit(1);
});
