const {referencedAssets} = require('./build-pages.cjs');

const base = process.argv[2] || 'https://divangames.github.io/valhem/';
const site = new URL(base);
if (site.protocol !== 'https:') throw new Error('Expected an HTTPS Pages URL');

async function get(relative, method = 'GET') {
  const url = new URL(relative, site);
  const response = await fetch(url, {method, cache: 'no-store'});
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return response;
}

async function check() {
  const html = await (await get('index.html')).text();
  const sw = await (await get('sw.js')).text();
  const assets = referencedAssets(html, sw);
  for (const asset of assets) {
    const response = await get(asset, 'HEAD');
    const bytes = Number(response.headers.get('content-length'));
    if (bytes === 0) throw new Error('Empty published asset: ' + asset);
  }
  console.log(`[OK] Published VALHEM: ${assets.size} media URLs respond successfully`);
}

(async () => {
  const attempts = process.argv.includes('--retry') ? 12 : 1;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await check();
      return;
    } catch (error) {
      if (attempt === attempts) throw error;
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
})().catch(error => { console.error('[FAIL] ' + error.message); process.exitCode = 1; });
