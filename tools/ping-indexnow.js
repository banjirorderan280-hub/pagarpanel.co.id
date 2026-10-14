/**
 * tools/ping-indexnow.js
 *
 * Tells IndexNow search engines (Bing, Yandex, Seznam, Naver, ...) which pages are NEW or CHANGED
 * after a deploy. Meant to run at the END of deploy.yml, after public/ has been pushed:
 *
 *   node tools/ping-indexnow.js --ensure-key                       (before the build: creates the key file)
 *   node tools/ping-indexnow.js --old-sitemap=<file> --wait        (after the push: pings)
 *
 * How it decides what to submit: it compares the sitemap that was live BEFORE this deploy
 * (--old-sitemap, the previous commit's public/sitemap.xml) with the freshly built
 * public/sitemap.xml. A URL is submitted when it is new, or when its <lastmod> changed. This
 * covers new articles (generate-articles), revisions (revise-articles), link fixes
 * (fix-orphans) and recycled posts (recycle-posts) with one code path, because all of them end in
 * a deploy.
 *
 * Why it waits (--wait): Cloudflare Pages needs a short while to publish the pushed public/.
 * IndexNow verifies ownership by downloading https://<site>/<key>.txt and Bing then fetches the
 * submitted pages; pinging before they are live gives 403/404 and wastes the submission. The
 * script polls the key file (and one submitted page) until both answer 200, then submits.
 *
 * Google does NOT take part in IndexNow and has no "push a URL" call for normal pages. For
 * Google the working signals are an accurate sitemap.xml (<lastmod>, built by Hugo) listed in
 * robots.txt (done by compress-sitemap.js) and submitted once in Search Console.
 *
 * Flags:
 *   --ensure-key         only create/verify .indexnow-key.json + static/<key>.txt, then exit
 *   --old-sitemap=FILE   sitemap of the previous deploy (missing file = first run, see --recent-days)
 *   --new-sitemap=FILE   default: public/sitemap.xml
 *   --recent-days=N      first run only (no old sitemap): submit just URLs with lastmod in the last N days (default 7)
 *   --wait               wait (max 10 min) until the key file and a changed page are live
 *   --dry-run            print what would be submitted, send nothing
 *   --max=N              cap on submitted URLs (default 10000, the protocol limit)
 *
 * Env (tests only): INDEXNOW_ENDPOINT overrides https://api.indexnow.org/indexnow;
 *   INDEXNOW_SITE_URL overrides the baseURL read from config.toml.
 * Never fails the pipeline: problems are printed (and shown as GitHub ::warning:: annotations),
 * exit code stays 0 unless the arguments are invalid.
 */

const fs   = require('fs');
const path = require('path');
const { submitToIndexNow, ensureIndexNowKey } = require('./lib/index-ping.js');

const ROOT = path.join(__dirname, '..');
const ARGS = process.argv.slice(2);
const flag = n => ARGS.includes(`--${n}`);
const opt  = (n, d) => { const a = ARGS.find(x => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : d; };

const warn = msg => { console.warn(`⚠️  ${msg}`); if (process.env.GITHUB_ACTIONS) console.log(`::warning::${msg}`); };

function siteUrl() {
  if (process.env.INDEXNOW_SITE_URL) return process.env.INDEXNOW_SITE_URL.replace(/\/?$/, '/'); // tests only
  const toml = require('toml'); // lazy: --ensure-key does not need it
  const cfg = toml.parse(fs.readFileSync(path.join(ROOT, 'config.toml'), 'utf8'));
  return cfg.baseURL.replace(/\/?$/, '/');
}

// Pages worth submitting. Tag archives, pagination and the placeholder "home/" section pages
// are noise for IndexNow; articles, category lists and the home page are not.
function isSubmittable(url) {
  const p = new URL(url).pathname;
  if (/^\/(tags|page|home)(\/|$)/.test(p)) return false;
  if (/\/page\/\d+\/?$/.test(p)) return false;
  if (p === '/categories/') return false;
  return true;
}

// Minimal sitemap reader (Hugo's sitemap is flat: <url><loc>…</loc><lastmod>…</lastmod></url>).
function parseSitemap(file) {
  const xml = fs.readFileSync(file, 'utf8');
  const map = new Map();
  const re = /<url>\s*<loc>([^<]+)<\/loc>(?:\s*<lastmod>([^<]*)<\/lastmod>)?/g;
  let m;
  while ((m = re.exec(xml))) map.set(m[1].trim(), (m[2] || '').trim());
  return map;
}

function diffSitemaps(oldMap, newMap, recentDays) {
  const out = [];
  if (!oldMap) {
    const cutoff = Date.now() - recentDays * 86400000;
    for (const [url, lm] of newMap) {
      const t = Date.parse(lm);
      if (!isNaN(t) && t >= cutoff) out.push({ url, lastmod: lm });
    }
    return out;
  }
  for (const [url, lm] of newMap) {
    if (!oldMap.has(url) || oldMap.get(url) !== lm) out.push({ url, lastmod: lm });
  }
  return out;
}

async function httpGet(url, timeoutMs = 15000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctl.signal, redirect: 'follow', headers: { 'User-Agent': 'pagarpanel-indexnow-check' } });
    const text = res.status === 200 ? await res.text() : '';
    return { status: res.status, text };
  } catch (err) {
    return { status: 0, text: '', error: err.message };
  } finally { clearTimeout(t); }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitUntilLive(key, base, probeUrl, maxMs = 600000, everyMs = 15000) {
  const keyUrl = `${base.replace(/\/$/, '')}/${key}.txt`;
  const t0 = Date.now();
  let lastKey = '', lastPage = '';
  while (Date.now() - t0 < maxMs) {
    const k = await httpGet(keyUrl);
    const keyOk = k.status === 200 && k.text.trim() === key;
    // Cache-buster so an edge cache cannot answer with the pre-deploy 404/old page.
    const p = probeUrl ? await httpGet(`${probeUrl}${probeUrl.includes('?') ? '&' : '?'}_=${Date.now()}`) : { status: 200 };
    const pageOk = p.status === 200;
    lastKey = `key file ${keyOk ? 'OK' : `HTTP ${k.status}${k.status === 200 ? ' (content != key)' : ''}`}`;
    lastPage = `page ${pageOk ? 'OK' : `HTTP ${p.status}`}`;
    if (keyOk && pageOk) {
      console.log(`   ✅ Live after ${Math.round((Date.now() - t0) / 1000)}s (${lastKey}, ${lastPage}).`);
      return { live: true };
    }
    console.log(`   ⏳ Not live yet (${lastKey}; ${lastPage}) — retrying in ${everyMs / 1000}s...`);
    await sleep(everyMs);
  }
  return { live: false, detail: `${lastKey}; ${lastPage}` };
}

async function main() {
  if (flag('ensure-key')) {
    const key = ensureIndexNowKey();
    console.log(`IndexNow key ready: ${key} → static/${key}.txt`);
    return;
  }

  const base = siteUrl();
  const newSitemapFile = path.resolve(opt('new-sitemap', path.join(ROOT, 'public', 'sitemap.xml')));
  const oldSitemapFile = opt('old-sitemap', '') ? path.resolve(opt('old-sitemap', '')) : '';
  const recentDays = parseInt(opt('recent-days', '7'), 10);
  const max = Math.min(parseInt(opt('max', '10000'), 10) || 10000, 10000);

  if (!fs.existsSync(newSitemapFile)) { warn(`IndexNow: ${newSitemapFile} not found — build the site first. Nothing submitted.`); return; }

  const newMap = parseSitemap(newSitemapFile);
  let oldMap = null;
  if (oldSitemapFile && fs.existsSync(oldSitemapFile)) {
    oldMap = parseSitemap(oldSitemapFile);
    console.log(`🔎 Comparing sitemaps: ${oldMap.size} URLs before → ${newMap.size} URLs now.`);
  } else {
    console.log(`🔎 No previous sitemap (first deploy?) — submitting only URLs with lastmod in the last ${recentDays} day(s).`);
  }

  const changed = diffSitemaps(oldMap, newMap, recentDays)
    .filter(c => isSubmittable(c.url))
    .sort((a, b) => Date.parse(b.lastmod || 0) - Date.parse(a.lastmod || 0))
    .slice(0, max);

  if (!changed.length) { console.log('ℹ️  IndexNow: no new or changed pages in this deploy — nothing to submit.'); return; }

  const urls = changed.map(c => c.url);
  console.log(`📮 ${urls.length} new/changed URL(s) to submit:`);
  urls.slice(0, 10).forEach(u => console.log(`   • ${u}`));
  if (urls.length > 10) console.log(`   … and ${urls.length - 10} more`);

  if (flag('dry-run')) { console.log('🧪 --dry-run: nothing sent.'); return; }

  const key = ensureIndexNowKey();
  if (flag('wait')) {
    // Probe a real article (not a list page) when possible: that is what Bing will fetch.
    const probe = urls.find(u => /\/categories\/[^/]+\/[^/]+\/$/.test(u)) || urls[0];
    console.log(`⏳ Waiting for the deploy to go live (probe: ${probe}) ...`);
    const r = await waitUntilLive(key, base, probe);
    if (!r.live) { warn(`IndexNow: site not live after 10 min (${r.detail}). Nothing submitted — run "npm run ping" later or re-run Deploy Site.`); return; }
  }

  const res = await submitToIndexNow(base, urls);
  if (!res.ok) warn(`IndexNow submission failed (${res.statusCode || res.error || 'unknown'}): ${res.explain || res.body || ''}`);
}

main().catch(err => { warn(`IndexNow crashed: ${err.message}`); });
