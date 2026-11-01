// Builds dist/StitchEditor-update-v<version>.zip - attach it to a GitHub release on adjustapen/StitchEditor.
// The app downloads this file, unpacks it over its resources/app folder and restarts.
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const root = path.join(__dirname, '..'), pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const CRC = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (b) => { let c = 0xFFFFFFFF; for (const x of b) c = CRC[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
const walk = (d) => fs.readdirSync(path.join(root, d), { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
const appPkg = { name: pkg.name, productName: pkg.productName, version: pkg.version, description: pkg.description, main: pkg.main, private: true };
const entries = [['package.json', Buffer.from(JSON.stringify(appPkg, null, 2))], ...['main.js', 'preload.js', ...walk('src'), ...walk('build')].map(f => [f.split(path.sep).join('/'), fs.readFileSync(path.join(root, f))])];
const parts = [], cd = []; let off = 0;
for (const [name, data] of entries) {
  const nm = Buffer.from(name), comp = zlib.deflateRawSync(data, { level: 9 }), crc = crc32(data);
  const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(8, 8); h.writeUInt16LE(0x21, 12); h.writeUInt32LE(crc, 14); h.writeUInt32LE(comp.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(nm.length, 26);
  parts.push(h, nm, comp);
  const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(8, 10); c.writeUInt16LE(0x21, 14); c.writeUInt32LE(crc, 16); c.writeUInt32LE(comp.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(nm.length, 28); c.writeUInt32LE(off, 42);
  cd.push(c, nm); off += 30 + nm.length + comp.length;
}
const cdBuf = Buffer.concat(cd), e = Buffer.alloc(22); e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(entries.length, 8); e.writeUInt16LE(entries.length, 10); e.writeUInt32LE(cdBuf.length, 12); e.writeUInt32LE(off, 16);
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
const out = path.join(root, 'dist', `StitchEditor-update-v${pkg.version}.zip`);
fs.writeFileSync(out, Buffer.concat([...parts, cdBuf, e]));
console.log(`Wrote ${out} (${entries.length} files). Tag the GitHub release v${pkg.version} and attach this zip.`);
