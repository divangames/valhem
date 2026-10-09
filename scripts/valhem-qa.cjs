const {readFileSync, existsSync, mkdtempSync, rmSync} = require('node:fs');
const {Script} = require('node:vm');
const {join} = require('node:path');
const {tmpdir} = require('node:os');
const {build, verify} = require('./build-pages.cjs');

const root = join(__dirname, '..');
const assets = [
  'viking-rig.js', 'assets/images/heroes/viking-rig.png',
  'assets/images/heroes/viking-full.png',
  'assets/images/heroes/viking-avatar.png',
  'assets/images/heroes/viking-sprite.png',
  'assets/images/heroes/berserk-full.png',
  'assets/images/heroes/berserk-avatar.png',
  'assets/images/heroes/berserk-sprite.png',
  'assets/images/heroes/maiden-full.png',
  'assets/images/heroes/maiden-avatar.png',
  'assets/images/heroes/maiden-sprite.png',
  'assets/images/heroes/ulf-full.png',
  'assets/images/heroes/ulf-avatar.png',
  'assets/images/heroes/ulf-sprite.png',
  'index.html', 'startup.js', 'startup.css', 'sw.js',
  'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png',
  'assets/images/arena/hall-floor.png',
  'assets/divan/divan_logo.webp', 'assets/images/main_menu/main_horizon.webp',
  'assets/images/main_menu/main_vertical.webp', 'assets/music/VALHEM - Viking Trail.wav',
  'assets/music/VALHEM - Viking Trail.opus', 'assets/music/Death.m4a',
  'assets/music/bioms/01 VALHEM - Crypt Battle Charge.m4a',
  'assets/music/bioms/02 VALHEM - Clash in the Woods.m4a',
  'assets/music/bioms/03 VALHEM - Frostpeak Battle (Battle Yells Edit).m4a',
  'assets/music/bioms/04 VALHEM - Realm of Fire Combat.m4a',
  'assets/music/bioms/05 VALHEM - Helheim Wasteland Combat.m4a',
  'assets/music/bioms/06 VALHEM - Gates of Asgard Instrumental.m4a',
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
for (const file of ['startup.js', 'sw.js', 'viking-rig.js']) {
  new Script(readFileSync(join(root, file), 'utf8'), {filename: file});
}
JSON.parse(readFileSync(join(root, 'manifest.webmanifest'), 'utf8'));
const artifact = mkdtempSync(join(tmpdir(), 'valhem-pages-qa-'));
try {
  build(artifact);
  const count = verify(artifact);
  console.log(`[OK] Pages artifact contains ${count} referenced media files`);
} finally {
  rmSync(artifact, {recursive: true, force: true});
}
console.log(`[OK] VALHEM assets, ${scripts.length} inline scripts, startup, service worker and manifest`);
