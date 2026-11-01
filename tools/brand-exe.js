// Stamps the app's name, version and icon onto the Windows exe (a renamed electron.exe), so Task Manager,
// the taskbar and file properties say "Stitch Editor" instead of "Electron".
//   node tools/brand-exe.js "<path to Stitch Editor.exe>"
const path = require('path');
const rceditMod = require('rcedit'), rcedit = rceditMod.rcedit || rceditMod;
const pkg = require('../package.json');
const exe = process.argv[2];
if (!exe) { console.error('usage: node tools/brand-exe.js <exe>'); process.exit(1); }
rcedit(exe, {
  icon: path.join(__dirname, '..', 'build', 'icon.ico'),
  'file-version': pkg.version,
  'product-version': pkg.version,
  'version-string': {
    FileDescription: pkg.productName, ProductName: pkg.productName, InternalName: pkg.productName,
    OriginalFilename: pkg.productName + '.exe', CompanyName: 'adjustapen', LegalCopyright: '© adjustapen',
  },
}).then(() => console.log(`Branded ${exe} as ${pkg.productName} ${pkg.version}`), (err) => { console.error(err.message); process.exit(1); });
