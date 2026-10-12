const fs = require('fs');
const zlib = require('zlib');
const path = require('path');
const toml = require('toml');

const ROOT = path.join(__dirname, '..'); // repo root (this script lives in tools/)
const configPath = path.join(ROOT, 'config.toml');
const sitemapPath = path.join(ROOT, 'public', 'sitemap.xml');
const sitemapGzipPath = path.join(ROOT, 'public', 'sitemap.xml.gz');
const robotsPath = path.join(ROOT, 'public', 'robots.txt');

function getBaseUrl() {
  const configContent = fs.readFileSync(configPath, 'utf-8');
  const config = toml.parse(configContent);
  return config.baseURL.endsWith('/') ? config.baseURL.slice(0, -1) : config.baseURL;
}

function ensureRobotsTxt() {
  const baseUrl = getBaseUrl();

  // Catatan: "Noindex" BUKAN direktif robots.txt yang valid dan diabaikan Google.
  // Untuk noindex, gunakan <meta name="robots" content="noindex"> di HTML
  // atau X-Robots-Tag di header HTTP.
  // sitemap.xml.gz tidak didukung oleh Google via robots.txt — hanya sitemap.xml.
  const robotsContent = `User-agent: *
Allow: /

Disallow: /categories/*/page/
Disallow: /tags/*/page/
Disallow: /page/

Sitemap: ${baseUrl}/sitemap.xml`;

  fs.writeFileSync(robotsPath, robotsContent);
  console.log('robots.txt berhasil dibuat atau diperbarui.');
}

function compressSitemap() {
  if (!fs.existsSync(sitemapPath)) {
    console.error('sitemap.xml tidak ditemukan di public/. Pastikan Hugo build sudah selesai.');
    process.exit(1);
  }

  const gzip = zlib.createGzip();
  const source = fs.createReadStream(sitemapPath);
  const destination = fs.createWriteStream(sitemapGzipPath);

  source.pipe(gzip).pipe(destination)
    .on('finish', () => {
      console.log('sitemap.xml berhasil dikompres menjadi sitemap.xml.gz');
    })
    .on('error', (err) => {
      console.error('Error saat mengompresi sitemap:', err);
      process.exit(1);
    });
}

ensureRobotsTxt();
compressSitemap();