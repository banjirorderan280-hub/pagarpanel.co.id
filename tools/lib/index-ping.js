/**
 * tools/lib/index-ping.js
 *
 * Working replacement for the old pingSearchEngines() in recycle-posts.js (which pinged
 * endpoints that are retired or were never real: Google/Bing sitemap ping, pingomatic via GET,
 * sitemaps.org, feedburner, indexnow.org/ping?sitemap=).
 *
 * WHAT ACTUALLY WORKS TODAY:
 *   - IndexNow (Bing, Yandex, Seznam, Naver — Google does NOT participate): a POST with a JSON
 *     body listing the EXACT URLs that changed, plus a key proving domain ownership via a small
 *     text file hosted at the site root. Implemented below via api.indexnow.org.
 *   - Google: no supported "push this URL" call exists for ordinary content. The supported
 *     signal is an accurate sitemap.xml with a correct <lastmod> — which this project already
 *     provides via setLastmod() in recycle-posts.js / revise-articles.js.
 */

const fs     = require('fs');
const path   = require('path');
const https  = require('https');
const http   = require('http');
const crypto = require('crypto');

const KEY_STATE_FILE = path.join(__dirname, '..', '..', '.indexnow-key.json');
const STATIC_DIR     = path.join(__dirname, '..', '..', 'static');

/**
 * Returns this site's persistent IndexNow key, generating it (and writing the required
 * static/<key>.txt verification file) the first time this ever runs. The SAME key must keep
 * being used on every future run.
 *
 * deploy.yml calls `node tools/ping-indexnow.js --ensure-key` BEFORE the Hugo build so the key file
 * is copied into public/ and goes live in the same deploy; the ping step afterwards waits until
 * https://<site>/<key>.txt really answers 200 before submitting. The file and
 * .indexnow-key.json are committed by deploy.yml (`git add public/ static/ .indexnow-key.json`).
 */
function ensureIndexNowKey() {
  let key;
  if (fs.existsSync(KEY_STATE_FILE)) {
    try { key = JSON.parse(fs.readFileSync(KEY_STATE_FILE, 'utf8')).key; } catch { key = null; }
  }
  if (!key || !/^[a-f0-9]{32}$/i.test(key)) {
    key = crypto.randomBytes(16).toString('hex');
    fs.writeFileSync(KEY_STATE_FILE, JSON.stringify({ key, createdAt: new Date().toISOString() }, null, 2));
    console.log(`   🔑 New IndexNow key generated and saved to ${path.basename(KEY_STATE_FILE)}: ${key}`);
  }

  const keyFilePath = path.join(STATIC_DIR, `${key}.txt`);
  if (!fs.existsSync(keyFilePath)) {
    if (!fs.existsSync(STATIC_DIR)) fs.mkdirSync(STATIC_DIR, { recursive: true });
    fs.writeFileSync(keyFilePath, key); // file content must be EXACTLY the key, no extra whitespace
    console.log(`   🔑 IndexNow key file created: static/${key}.txt (published at the site root — make sure it gets committed).`);
  }

  return key;
}

const ENDPOINT = () => new URL(process.env.INDEXNOW_ENDPOINT || 'https://api.indexnow.org/indexnow');

function postJson(endpoint, payload, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const lib = endpoint.protocol === 'http:' ? http : https;
    const req = lib.request({
      hostname: endpoint.hostname,
      port    : endpoint.port || undefined,
      path    : endpoint.pathname + endpoint.search,
      method  : 'POST',
      headers : {
        'Content-Type'  : 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
      },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ statusCode: res.statusCode, body: data, retryAfter: res.headers['retry-after'] }));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`Timeout after ${timeoutMs / 1000}s (${endpoint.hostname})`)));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// Meaning of the IndexNow response codes (https://www.indexnow.org/documentation).
const STATUS_EXPLAIN = {
  200: 'URLs submitted.',
  202: 'Accepted — the key file is still being validated by the search engine; URLs will be processed.',
  400: 'Bad request (malformed JSON).',
  403: 'Key invalid: https://<site>/<key>.txt is not reachable yet or its content is not exactly the key.',
  422: 'URLs do not belong to the host, or the key does not match the host.',
  429: 'Too many requests (rate-limited / flagged as spam) — slow down.',
};

/**
 * Submits `urls` (full https:// page URLs that were actually added/changed — NOT a sitemap URL)
 * to IndexNow, in batches of up to 10,000 (the protocol limit). Retries once on HTTP 429.
 * Does nothing if `urls` is empty.
 *
 * @param {string} siteUrl - e.g. "https://pagarpanel.co.id/"
 * @param {string[]} urls  - full page URLs, same host as siteUrl
 * @returns {Promise<{ok:boolean, statusCode?:number, explain?:string, body?:string, error?:string, skipped?:boolean}>}
 */
async function submitToIndexNow(siteUrl, urls) {
  if (!urls || !urls.length) return { skipped: true, ok: true, reason: 'no URLs to submit' };

  const key = ensureIndexNowKey();
  const host = new URL(siteUrl).host;
  const keyLocation = `${siteUrl.replace(/\/$/, '')}/${key}.txt`;
  const own = urls.filter(u => { try { return new URL(u).host === host; } catch { return false; } });
  if (own.length !== urls.length) console.warn(`   ⚠️  ${urls.length - own.length} URL(s) skipped: not on host ${host}.`);

  let last = { ok: true };
  for (let i = 0; i < own.length; i += 10000) {
    const batch = own.slice(i, i + 10000);
    const payload = { host, key, keyLocation, urlList: batch };
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const r = await postJson(ENDPOINT(), payload);
        const explain = STATUS_EXPLAIN[r.statusCode] || '';
        if (r.statusCode === 200 || r.statusCode === 202) {
          console.log(`   ✅ IndexNow: ${batch.length} URL(s) submitted (HTTP ${r.statusCode}). ${explain}`);
          last = { ok: true, statusCode: r.statusCode, explain };
          break;
        }
        if (r.statusCode === 429 && attempt === 1) {
          const wait = Math.min(parseInt(r.retryAfter, 10) || 30, 120);
          console.warn(`   ⏳ IndexNow HTTP 429 — retrying once in ${wait}s...`);
          await new Promise(res => setTimeout(res, wait * 1000));
          continue;
        }
        console.warn(`   ⚠️  IndexNow returned HTTP ${r.statusCode}: ${explain} ${r.body.slice(0, 200)}`);
        last = { ok: false, statusCode: r.statusCode, explain, body: r.body };
        break;
      } catch (err) {
        console.warn(`   ⚠️  IndexNow submission failed: ${err.message}`);
        last = { ok: false, error: err.message };
        break;
      }
    }
    if (!last.ok) break;
  }
  return last;
}

module.exports = { submitToIndexNow, ensureIndexNowKey };
