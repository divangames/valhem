const {readFileSync, existsSync} = require('node:fs');
const {Script} = require('node:vm');
const {join} = require('node:path');

const root = join(__dirname, '..');
const assets = [
  'index.html', 'startup.js', 'startup.css', 'sw.js',
  'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png',
  'assets/divan/divan.webp', 'assets/music/VALHEM - Viking Trail.wav',
  'assets/music/VALHEM - Viking Trail.opus',
];

for (const asset of assets) {
  if (!existsSync(join(root, asset))) throw new Error(`Missing VALHEM asset: ${asset}`);
}

const html = readFileSync(join(root, 'index.html'), 'utf8');
const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)];
if (scripts.length < 2 || !html.includes('VALHEM')) {
  throw new Error('VALHEM HTML or inline scripts are missing');
}
scripts.forEach((match, index) => new Script(match[1], {filename: `index.html script ${index + 1}`}));
for (const file of ['startup.js', 'sw.js']) {
  new Script(readFileSync(join(root, file), 'utf8'), {filename: file});
}
JSON.parse(readFileSync(join(root, 'manifest.webmanifest'), 'utf8'));
console.log(`[OK] VALHEM assets, ${scripts.length} inline scripts, startup, service worker and manifest`);
