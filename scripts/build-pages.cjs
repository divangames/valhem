const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const required = ['index.html', 'icon.svg', 'icon-192.png', 'icon-512.png',
  'manifest.webmanifest', 'startup.css', 'startup.js', 'sw.js'];
const webExtensions = new Set(['.avif', '.gif', '.jpeg', '.jpg', '.png', '.svg', '.webp',
  '.m4a', '.mp3', '.ogg', '.opus', '.woff', '.woff2']);
const wavFallback = 'assets/music/VALHEM - Viking Trail.wav';

function relativeFiles(directory, prefix = '') {
  return fs.readdirSync(directory, {withFileTypes: true}).flatMap(entry => {
    const name = path.posix.join(prefix, entry.name);
    return entry.isDirectory()
      ? relativeFiles(path.join(directory, entry.name), name)
      : entry.isFile() ? [name] : [];
  });
}

function build(destination) {
  const output = path.resolve(destination);
  if (output === root || output === path.join(root, 'assets') ||
      output.startsWith(path.join(root, 'assets') + path.sep)) {
    throw new Error('Output cannot overwrite game files or source assets');
  }
  const files = [...required, ...relativeFiles(path.join(root, 'assets'), 'assets')
    .filter(file => webExtensions.has(path.extname(file).toLowerCase()) || file === wavFallback)];
  for (const file of files) {
    const source = path.join(root, file);
    if (!fs.statSync(source).size) throw new Error('Empty Pages asset: ' + file);
    const target = path.join(output, file);
    fs.mkdirSync(path.dirname(target), {recursive: true});
    fs.copyFileSync(source, target);
  }
  fs.writeFileSync(path.join(output, '.nojekyll'), '');
  return files;
}

function referencedAssets(html, sw) {
  const references = new Set();
  for (const source of [html, sw]) {
    for (const match of source.matchAll(/(?:\.\/)?assets\/[A-Za-z0-9_./%() -]+\.(?:avif|gif|jpe?g|png|svg|webp|m4a|mp3|ogg|opus|wav|woff2?)/gi)) {
      references.add(decodeURIComponent(match[0]).replace(/^\.\//, ''));
    }
  }
  const biomeMap = html.match(/const BIOME_MUSIC_FILES=\{([\s\S]*?)\};/);
  if (!biomeMap) throw new Error('Missing biome music map');
  for (const match of biomeMap[1].matchAll(/:\s*'([^']+\.m4a)'/g)) {
    references.add('assets/music/bioms/' + match[1]);
  }
  return references;
}

function verify(destination) {
  const html = fs.readFileSync(path.join(destination, 'index.html'), 'utf8');
  const sw = fs.readFileSync(path.join(destination, 'sw.js'), 'utf8');
  const references = referencedAssets(html, sw);
  for (const file of references) {
    if (!fs.existsSync(path.join(destination, file))) {
      throw new Error('Missing referenced Pages asset: ' + file);
    }
  }
  for (const file of ['assets/divan/divan.webp', 'assets/music/Death.m4a', wavFallback]) {
    if (!references.has(file)) throw new Error('Asset is not wired into game: ' + file);
  }
  if ([...references].filter(file => file.startsWith('assets/music/bioms/')).length !== 6) {
    throw new Error('Expected all six biome music tracks');
  }
  return references.size;
}

if (require.main === module) {
  const destination = process.argv[2];
  if (!destination) throw new Error('Usage: node scripts/build-pages.cjs OUTPUT_DIR');
  const files = build(destination);
  const references = verify(destination);
  console.log('[OK] Pages artifact: ' + files.length + ' files, ' + references + ' referenced assets present');
}

module.exports = {build, verify, referencedAssets};
