const { app, BrowserWindow, ipcMain, dialog, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const fsw = require('fs');
const zlib = require('zlib');

function createWindow() {
  const win = new BrowserWindow({
    width: 1480, height: 920, minWidth: 1100, minHeight: 700,
    backgroundColor: '#181818', show: false, title: 'Stitch Editor', autoHideMenuBar: true, icon: path.join(__dirname, 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  win.loadFile(path.join(__dirname, 'src', 'index.html'));
  win.once('ready-to-show', () => win.show()); // no blank window before the first frame is painted
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') win.webContents.toggleDevTools();
    // F11 fullscreen - Electron's default menu normally provides it, but the app has no menu
    if (input.type === 'keyDown' && input.key === 'F11' && !input.isAutoRepeat) { e.preventDefault(); win.setFullScreen(!win.isFullScreen()); }
  });
}

// testing: keep settings, autosave and projects in another folder so the real ones aren't touched
if (process.env.STITCH_USER_DATA) app.setPath('userData', process.env.STITCH_USER_DATA);

Menu.setApplicationMenu(null);
app.setAppUserModelId('com.adjustapen.stitcheditor');

// Put a "Stitch Editor" shortcut in the Start menu so it shows up in Windows search (refreshed every launch, so it follows the app if the folder moves)
function ensureStartMenuShortcut() {
  if (process.platform !== 'win32' || !app.isPackaged) return;
  try {
    const dir = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs');
    const lnk = path.join(dir, 'Stitch Editor.lnk');
    const ico = path.join(__dirname, 'build', 'icon.ico');
    const opts = { target: process.execPath, cwd: path.dirname(process.execPath), description: 'Stitch Editor - image and template editor', appUserModelId: 'com.adjustapen.stitcheditor' };
    if (fsw.existsSync(ico)) { opts.icon = ico; opts.iconIndex = 0; }
    shell.writeShortcutLink(lnk, fsw.existsSync(lnk) ? 'replace' : 'create', opts);
  } catch (err) { console.error('shortcut failed', err); }
}

// keeps the version shown in Windows "Installed apps" right after an auto-update (only when installed with the Setup)
function syncInstalledVersion() {
  if (process.platform !== 'win32' || !app.isPackaged) return;
  const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\StitchEditor';
  const { execFile } = require('child_process');
  execFile('reg', ['query', key, '/v', 'DisplayVersion'], { windowsHide: true }, (err, out) => {
    if (err || String(out).includes(app.getVersion())) return;
    execFile('reg', ['add', key, '/v', 'DisplayVersion', '/t', 'REG_SZ', '/d', app.getVersion(), '/f'], { windowsHide: true }, () => {});
  });
}

ipcMain.handle('save-file', async (e, { defaultPath, filters, data, encoding }) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const res = await dialog.showSaveDialog(win, { defaultPath, filters });
  if (res.canceled || !res.filePath) return null;
  await fs.writeFile(res.filePath, Buffer.from(data, encoding === 'base64' ? 'base64' : 'utf8'));
  return res.filePath;
});

// writes several files into one folder the user picks (Export set)
ipcMain.handle('save-files', async (e, { title, files }) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const res = await dialog.showOpenDialog(win, { title, properties: ['openDirectory', 'createDirectory', 'promptToCreate'] });
  if (res.canceled || !res.filePaths?.[0]) return null;
  const dir = res.filePaths[0];
  const exist = files.filter(f => fsw.existsSync(path.join(dir, path.basename(f.name)))).map(f => f.name);
  if (exist.length) { const r = await dialog.showMessageBox(win, { type: 'question', buttons: ['Replace', 'Cancel'], defaultId: 0, cancelId: 1, message: `Replace ${exist.join(' and ')}?`, detail: 'They already exist in that folder.' }); if (r.response !== 0) return null; }
  for (const f of files) await fs.writeFile(path.join(dir, path.basename(f.name)), Buffer.from(f.data, 'base64'));
  return dir;
});

// autosave.stitch holds the session (which projects are open). Up to 0.3.x it held every open tab, so the
// first write after updating keeps that old file as a backup.
const autosavePath = () => path.join(app.getPath('userData'), 'autosave.stitch');
const legacyBackupPath = () => path.join(app.getPath('userData'), 'autosave-0.3-backup.stitch');
ipcMain.handle('autosave-write', async (e, data) => {
  if (!fsw.existsSync(legacyBackupPath()) && fsw.existsSync(autosavePath())) {
    const cur = await fs.readFile(autosavePath(), 'utf8').catch(() => '');
    if (cur && !cur.slice(0, 200).includes('"session":')) await fs.copyFile(autosavePath(), legacyBackupPath());
  }
  await writeAtomic(autosavePath(), data);
  return true;
});
ipcMain.handle('autosave-read', async () => {
  try { return await fs.readFile(autosavePath(), 'utf8'); } catch { return null; }
});

// Project library (Home page): projects/<id>.stitch is the project, projects/<id>.json its name, kind, size and thumbnail
const projDir = () => path.join(app.getPath('userData'), 'projects');
const projFile = (id, ext) => { if (!/^[\w-]{1,80}$/.test(String(id))) throw new Error('bad project id'); return path.join(projDir(), id + ext); };
// write to a temp file then rename, so a crash never leaves half a file; unique temp names let writes overlap safely
let tmpN = 0;
async function writeAtomic(file, data) { const tmp = `${file}.${++tmpN}.tmp`; await fs.writeFile(tmp, data, 'utf8'); await fs.rename(tmp, file); }
ipcMain.handle('projects-list', async () => {
  let names = []; try { names = await fs.readdir(projDir()); } catch { return []; }
  const out = [];
  for (const n of names) if (n.endsWith('.json')) { try { out.push(JSON.parse(await fs.readFile(path.join(projDir(), n), 'utf8'))); } catch { /* skip unreadable */ } }
  return out.sort((a, b) => (b.updated || 0) - (a.updated || 0));
});
ipcMain.handle('project-read', async (e, id) => { try { return await fs.readFile(projFile(id, '.stitch'), 'utf8'); } catch { return null; } });
ipcMain.handle('project-write', async (e, id, data, meta) => {
  await fs.mkdir(projDir(), { recursive: true });
  await writeAtomic(projFile(id, '.stitch'), data); await writeAtomic(projFile(id, '.json'), JSON.stringify(meta));
  return true;
});
ipcMain.handle('project-delete', async (e, id) => { for (const ext of ['.stitch', '.json']) await fs.rm(projFile(id, ext), { force: true }); return true; });

// Live updates: when files in the app folder change, save + reload the window (or relaunch if main/preload changed).
let updTimer = null, needRelaunch = false;
function watchForUpdates() {
  try {
    fsw.watch(__dirname, { recursive: true }, (ev, file) => {
      if (!file || installing) return;
      const f = String(file).replace(/\\/g, '/');
      if (/^(main\.js|preload\.js|package\.json)$/.test(f)) needRelaunch = true; // top level only - not node_modules/**/package.json
      else if (!/^src\//.test(f)) return;
      clearTimeout(updTimer);
      updTimer = setTimeout(() => {
        const relaunch = needRelaunch; needRelaunch = false;
        const wins = BrowserWindow.getAllWindows();
        if (!wins.length) return;
        for (const w of wins) w.webContents.send('app-updated', { relaunch });
      }, 1500);
    });
  } catch (err) { console.error('watch failed', err); }
}
ipcMain.handle('relaunch', () => { app.relaunch(); app.exit(0); });
ipcMain.handle('toggle-fullscreen', (e) => { const w = BrowserWindow.fromWebContents(e.sender); w?.setFullScreen(!w.isFullScreen()); });

// ------------------------------------------------------------------ updates from GitHub releases (adjustablepen/StitchEditor)
const UPDATE_REPO = 'adjustablepen/StitchEditor';
const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');
function readSettings() { try { return JSON.parse(fsw.readFileSync(settingsPath(), 'utf8')); } catch { return {}; } }
function writeSettings(s) { try { fsw.writeFileSync(settingsPath(), JSON.stringify(s, null, 2)); } catch { /* ignore */ } }
function cmpVer(a, b) { const pa = String(a).replace(/^v\.?/i, '').split(/[.-]/).map(n => parseInt(n, 10) || 0), pb = String(b).replace(/^v\.?/i, '').split(/[.-]/).map(n => parseInt(n, 10) || 0); for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0); } return 0; }
let latest = null, installing = false;
async function checkForUpdate(manual) {
  try {
    const API = process.env.STITCH_UPDATE_API || 'https://api.github.com', H = { Accept: 'application/vnd.github+json', 'User-Agent': 'StitchEditor' };
    let rel = null;
    const r = await fetch(`${API}/repos/${UPDATE_REPO}/releases/latest`, { headers: H });
    if (r.ok) rel = await r.json();
    else {
      // no "latest" release (e.g. only pre-releases) - use the newest published one from the full list
      const r2 = await fetch(`${API}/repos/${UPDATE_REPO}/releases?per_page=20`, { headers: H });
      if (r2.status === 404) return { status: 'none', message: 'repo not found - is it public and named adjustablepen/StitchEditor?', current: app.getVersion() };
      if (!r2.ok) return { status: 'error', message: `GitHub said ${r.status}/${r2.status}`, current: app.getVersion() };
      const list = (await r2.json()).filter(x => !x.draft && x.tag_name).sort((a, b) => cmpVer(b.tag_name, a.tag_name));
      if (!list.length) return { status: 'none', message: 'the repo has no published releases (drafts don\'t count)', current: app.getVersion() };
      rel = list[0];
    }
    const ver = String(rel.tag_name || '').replace(/^v\.?/i, '');
    const assets = rel.assets || [], asset = assets.find(a => /update.*\.zip$/i.test(a.name)) || assets.find(a => /\.zip$/i.test(a.name) && a.size < 20e6);
    if (!ver || cmpVer(ver, app.getVersion()) <= 0) return { status: 'latest', current: app.getVersion() };
    if (!manual && readSettings().skipVersion === ver) return { status: 'skipped', version: ver, current: app.getVersion() };
    latest = { version: ver, name: rel.name || `v${ver}`, notes: rel.body || '', url: asset?.browser_download_url || null, page: rel.html_url };
    return { status: 'available', ...latest, current: app.getVersion() };
  } catch (err) { return { status: 'error', message: String(err.message || err), current: app.getVersion() }; }
}
function unzipBuffer(buf) {
  const files = new Map(); let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 70000); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('The update file is not a zip');
  let p = buf.readUInt32LE(eocd + 16); const n = buf.readUInt16LE(eocd + 10);
  for (let k = 0; k < n; k++) {
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), nlen = buf.readUInt16LE(p + 28), elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), loc = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen); p += 46 + nlen + elen + clen;
    if (name.endsWith('/')) continue;
    const start = loc + 30 + buf.readUInt16LE(loc + 26) + buf.readUInt16LE(loc + 28), raw = buf.subarray(start, start + csize);
    files.set(name, method === 0 ? Buffer.from(raw) : zlib.inflateRawSync(raw));
  }
  return files;
}
ipcMain.handle('app-version', () => app.getVersion());
ipcMain.handle('update-check', (e, manual) => checkForUpdate(!!manual));
ipcMain.handle('update-skip', (e, ver) => { const s = readSettings(); s.skipVersion = ver; writeSettings(s); return true; });
ipcMain.handle('update-open-page', () => { if (latest?.page) shell.openExternal(latest.page); else shell.openExternal(`https://github.com/${UPDATE_REPO}/releases`); });
ipcMain.handle('update-install', async () => {
  if (!latest) return { ok: false, message: 'No update found' };
  if (!latest.url) { shell.openExternal(latest.page); return { ok: false, message: 'This release has no update file - opened the release page instead' }; }
  installing = true;
  try {
    const r = await fetch(latest.url, { headers: { 'User-Agent': 'StitchEditor' } }); if (!r.ok) throw new Error(`download failed (${r.status})`);
    let files = unzipBuffer(Buffer.from(await r.arrayBuffer()));
    // allow the zip to have everything inside one top folder
    const names = [...files.keys()], prefix = names.every(nm => nm.includes('/')) && new Set(names.map(nm => nm.split('/')[0])).size === 1 ? names[0].split('/')[0] + '/' : '';
    if (prefix) files = new Map([...files].map(([k, v]) => [k.slice(prefix.length), v]));
    if (!files.has('main.js') || !files.has('package.json') || !files.has('src/app.js')) throw new Error('that zip is not a Stitch Editor update');
    const tmp = fsw.mkdtempSync(path.join(app.getPath('temp'), 'stitch-update-'));
    for (const [name, data] of files) {
      if (name.includes('..') || path.isAbsolute(name)) continue;
      const out = path.join(tmp, name); fsw.mkdirSync(path.dirname(out), { recursive: true }); fsw.writeFileSync(out, data);
    }
    fsw.cpSync(tmp, __dirname, { recursive: true, force: true });
    fsw.rmSync(tmp, { recursive: true, force: true });
    const s = readSettings(); delete s.skipVersion; writeSettings(s);
    setTimeout(() => { app.relaunch(); app.exit(0); }, 500);
    return { ok: true, version: latest.version };
  } catch (err) { installing = false; return { ok: false, message: String(err.message || err) }; }
});

app.whenReady().then(() => {
  ensureStartMenuShortcut(); syncInstalledVersion();
  createWindow();
  watchForUpdates();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
