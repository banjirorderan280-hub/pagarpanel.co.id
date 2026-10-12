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
const crypto = require('crypto');

const KEY_STATE_FILE = path.join(__dirname, '..', '..', '.indexnow-key.json');
const STATIC_DIR     = path.join(__dirname, '..', '..', 'static');

/**
 * Returns this site's persistent IndexNow key, generating it (and writing the required
 * static/<key>.txt verification file) the first time this ever runs. The SAME key must keep
 * being used on every future run.
 *
 * First-run caveat: static/<key>.txt isn't LIVE until the build gets deployed a few steps
 * later in the workflow, so the very first submission may be rejected with a key-verification
 * error. This self-resolves from the next run onward. The file and .indexnow-key.json must be
 * committed (recycle.yml does `git add static/ .indexnow-key.json`).
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

function httpsPostJson(hostname, reqPath, payload, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = https.request({
      hostname,
      path: reqPath,
      method: 'POST',
      headers: {
        'Content-Type'  : 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
      },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`Timeout after ${timeoutMs / 1000}s (${hostname}${reqPath})`)));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * Submits `urls` (full https:// page URLs that were actually added/changed — NOT a sitemap URL)
 * to IndexNow in one batched call (up to 10,000 URLs per the protocol spec). Does nothing if
 * `urls` is empty.
 *
 * @param {string} siteUrl - e.g. "https://pagarpanel.co.id/"
 * @param {string[]} urls  - full page URLs, same host as siteUrl
 */
async function submitToIndexNow(siteUrl, urls) {
  if (!urls || !urls.length) return { skipped: true, reason: 'no URLs to submit' };

  const key = ensureIndexNowKey();
  const host = new URL(siteUrl).host;
  const keyLocation = `${siteUrl.replace(/\/$/, '')}/${key}.txt`;
  const payload = { host, key, keyLocation, urlList: urls.slice(0, 10000) };

  try {
    const { statusCode, body } = await httpsPostJson('api.indexnow.org', '/indexnow', payload);
    if (statusCode === 200 || statusCode === 202) {
      console.log(`   ✅ IndexNow: ${urls.length} URL(s) submitted to Bing/Yandex/Seznam/Naver (HTTP ${statusCode}).`);
      return { ok: true, statusCode };
    }
    console.warn(`   ⚠️  IndexNow submission returned HTTP ${statusCode}: ${body.slice(0, 200)}`);
    return { ok: false, statusCode, body };
  } catch (err) {
    console.warn(`   ⚠️  IndexNow submission failed: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

module.exports = { submitToIndexNow, ensureIndexNowKey };
