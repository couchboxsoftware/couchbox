const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { JsonStore } = require('./src/main/store');
const { Library } = require('./src/main/library');
const { Tmdb } = require('./src/main/tmdb');
const updater = require('./src/main/updater');
const { Finder } = require('./src/main/finder');

if (process.env.COUCHBOX_DATA_DIR) app.setPath('userData', process.env.COUCHBOX_DATA_DIR);

let win = null;
let store = null;
let library = null;
let updates = null;
let finder = null;

const send = (ch, payload) => {
  if (win && !win.isDestroyed()) win.webContents.send(ch, payload);
};

function getKey() {
  const s = store.data.settings;
  if (s.tmdbKeyEnc) {
    try {
      return safeStorage.decryptString(Buffer.from(s.tmdbKeyEnc, 'base64'));
    } catch (_) {
      return '';
    }
  }
  return s.tmdbKey || '';
}

function setKey(key) {
  const s = store.data.settings;
  delete s.tmdbKey;
  delete s.tmdbKeyEnc;
  if (key) {
    if (safeStorage.isEncryptionAvailable()) s.tmdbKeyEnc = safeStorage.encryptString(key).toString('base64');
    else s.tmdbKey = key;
  }
  store.save();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#121212',
    title: 'Couchbox',
    icon: path.join(__dirname, 'build', 'icon.png'),
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#00000000', symbolColor: '#e8e8e8', height: 36 },
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  // The main window stays hidden until the splash hands over (see finishSplash).
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('enter-full-screen', () => send('fullscreen', true));
  win.on('leave-full-screen', () => send('fullscreen', false));
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.control && input.shift && input.key.toLowerCase() === 'i') win.webContents.toggleDevTools();
    // F11 switches fullscreen on and off anywhere in the app.
    if (input.type === 'keyDown' && input.key === 'F11' && !input.control && !input.alt) {
      e.preventDefault();
      win.setFullScreen(!win.isFullScreen());
    }
  });
  // Never navigate the app window away; open web links in the browser.
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

/* ---------- splash ---------- */
let splash = null;
let splashShownAt = 0;
let splashLoaded = false;
const splashQueue = [];
const boot = { rendererReady: false, scanned: false, finished: false };
const SPLASH_MIN_MS = 2300;

function createSplash() {
  splash = new BrowserWindow({
    width: 640,
    height: 360,
    frame: false,
    // Sofa-shaped splash: only the sofa is painted, the rest of the window is see-through.
    transparent: true,
    hasShadow: false,
    resizable: false,
    movable: true,
    center: true,
    show: false,
    skipTaskbar: false,
    backgroundColor: '#00000000',
    title: 'Couchbox',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  splash.once('ready-to-show', () => {
    splash.show();
    splashShownAt = Date.now();
  });
  splash.webContents.once('did-finish-load', () => {
    splashLoaded = true;
    splashQueue.splice(0).forEach(runSplash);
  });
  splash.webContents.on('will-navigate', (e) => e.preventDefault());
  splash.on('closed', () => (splash = null));
  splash.loadFile(path.join(__dirname, 'renderer', 'splash.html'), { query: { v: require('./package.json').version } });
}

function runSplash(code) {
  if (!splash || splash.isDestroyed()) return;
  if (!splashLoaded) return splashQueue.push(code);
  splash.webContents.executeJavaScript(code).catch(() => {});
}
const splashStep = (text, status) => runSplash(`window.step && step(${JSON.stringify(text)}, ${JSON.stringify(status)})`);

function maybeFinishSplash() {
  if (boot.finished || !boot.rendererReady || !boot.scanned) return;
  boot.finished = true;
  splashStep('fluffing the cushions', 'ok');
  const wait = Math.max(0, SPLASH_MIN_MS - (Date.now() - (splashShownAt || Date.now())));
  setTimeout(() => {
    runSplash('window.finish && finish()');
    setTimeout(() => {
      runSplash('window.fadeOut && fadeOut()');
      setTimeout(() => {
        if (win && !win.isDestroyed()) {
          win.show();
          win.focus();
        }
        if (splash && !splash.isDestroyed()) splash.close();
        updates.start(); // first update check a few seconds after the app is up
      }, 420);
    }, 650);
  }, wait);
}

ipcMain.on('app-ready', () => {
  boot.rendererReady = true;
  maybeFinishSplash();
});

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  updates = updater.create({ send });
  createSplash();
  // Safety net: never leave someone staring at the splash.
  setTimeout(() => {
    boot.rendererReady = boot.scanned = true;
    maybeFinishSplash();
  }, 15000);
  const dataDir = app.getPath('userData');
  store = new JsonStore(path.join(dataDir, 'couchbox-data.json'), {
    settings: { libraryPath: null, volume: 1, autoplayNext: true, previews: true },
    profiles: [],
    progress: {},
    lists: {},
    intros: {},
    kidsAllow: {},
    lastProfile: null,
  });
  splashStep('reading settings', 'ok');
  library = new Library(dataDir, {
    onChange: (model) => {
      send('library', model);
      if (!boot.scanned) {
        boot.scanned = true;
        const eps = model.series.reduce((n, s) => n + s.episodeCount, 0);
        if (model.root) splashStep('indexing library', `${model.films.length} films / ${model.series.length} series / ${eps} eps`);
        maybeFinishSplash();
      }
    },
    onStatus: (s) => send('status', s),
  });
  library.setTmdbKey(getKey());
  library.setRoot(store.data.settings.libraryPath);
  finder = new Finder({
    getLibrary: () => library,
    send,
    // Never search the Couchbox folder itself or the app's own data (thumbnails, converted copies).
    getExcluded: () => [library.root, dataDir, path.dirname(process.execPath)],
  });
  splashStep('checking video folder', store.data.settings.libraryPath ? (library.root ? 'ok' : 'missing') : 'not set yet');
  createWindow();
  // Scan only once the window has loaded, so the scan doesn't hold up startup.
  win.webContents.once('did-finish-load', () => {
    splashStep('warming up the projector', 'ok');
    setTimeout(() => library.refresh(), 30);
  });
});

app.on('window-all-closed', () => {
  library && library.cancelAll();
  store && store.save(true);
  library && library.meta.save(true);
  app.quit();
});

// ---- IPC ----
const publicSettings = () => {
  const s = store.data.settings;
  return { libraryPath: s.libraryPath, hasTmdbKey: !!getKey(), volume: s.volume, autoplayNext: s.autoplayNext !== false, previews: s.previews !== false };
};

ipcMain.handle('init', () => ({
  settings: publicSettings(),
  profiles: store.data.profiles,
  lastProfile: store.data.lastProfile,
  intros: store.data.intros,
  kidsAllow: store.data.kidsAllow,
  model: library.model(),
}));

ipcMain.handle('kids:set', (_e, itemId, allow) => {
  if (allow == null) delete store.data.kidsAllow[itemId];
  else store.data.kidsAllow[itemId] = !!allow;
  store.save();
  return store.data.kidsAllow;
});

ipcMain.handle('choose-folder', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Choose your video folder', properties: ['openDirectory'] });
  if (r.canceled || !r.filePaths[0]) return null;
  store.data.settings.libraryPath = r.filePaths[0];
  store.save();
  library.setRoot(r.filePaths[0]);
  library.refresh();
  return publicSettings();
});

ipcMain.handle('set-tmdb-key', async (_e, key) => {
  key = (key || '').trim();
  if (key) {
    try {
      await new Tmdb(key, '').validate();
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }
  setKey(key);
  library.setTmdbKey(key);
  library.refresh();
  return { ok: true, settings: publicSettings() };
});

ipcMain.handle('settings:set', (_e, patch) => {
  const allowed = ['volume', 'autoplayNext', 'previews'];
  for (const k of allowed) if (k in patch) store.data.settings[k] = patch[k];
  store.save();
  return publicSettings();
});

ipcMain.handle('profiles:save', (_e, profiles) => {
  store.data.profiles = profiles;
  const ids = new Set(profiles.map((p) => p.id));
  for (const k of Object.keys(store.data.progress)) if (!ids.has(k)) delete store.data.progress[k];
  for (const k of Object.keys(store.data.lists)) if (!ids.has(k)) delete store.data.lists[k];
  store.save();
  return store.data.profiles;
});

ipcMain.handle('profiles:last', (_e, id) => {
  store.data.lastProfile = id;
  store.save();
});

ipcMain.handle('progress:get', (_e, pid) => store.data.progress[pid] || {});
ipcMain.handle('progress:set', (_e, pid, fileId, t, d) => {
  const p = (store.data.progress[pid] = store.data.progress[pid] || {});
  if (t == null) delete p[fileId];
  else p[fileId] = { t: Math.round(t), d: Math.round(d), u: Date.now() };
  store.save();
});
ipcMain.handle('progress:bulk', (_e, pid, entries) => {
  const p = (store.data.progress[pid] = store.data.progress[pid] || {});
  const now = Date.now();
  for (const [fileId, t, d] of entries) {
    if (t == null) delete p[fileId];
    else p[fileId] = { t: Math.round(t), d: Math.round(d), u: now };
  }
  store.save();
  return p;
});

ipcMain.handle('list:get', (_e, pid) => store.data.lists[pid] || []);
ipcMain.handle('list:toggle', (_e, pid, itemId) => {
  const l = (store.data.lists[pid] = store.data.lists[pid] || []);
  const i = l.indexOf(itemId);
  if (i >= 0) l.splice(i, 1);
  else l.unshift(itemId);
  store.save();
  return l;
});

ipcMain.handle('intro:set', (_e, seriesId, range) => {
  if (range) store.data.intros[seriesId] = range;
  else delete store.data.intros[seriesId];
  store.save();
  return store.data.intros;
});

ipcMain.handle('subtitle', (_e, fileId, index) => library.subtitle(fileId, index));
ipcMain.handle('convert', (_e, fileId) => library.convert(fileId, (p) => send('convert-progress', { fileId, p })));
ipcMain.handle('convert:cancel', (_e, fileId) => library.cancelConvert(fileId));
ipcMain.handle('match:search', (_e, itemId, q) => library.searchMatches(itemId, q));
ipcMain.handle('match:fix', (_e, itemId, tmdbId) => library.fixMatch(itemId, tmdbId));
ipcMain.handle('library:refresh', () => library.refresh());
ipcMain.handle('library:clear-meta', () => library.clearMetadata());
// Opens the video folder in File Explorer. Returns an error message, or '' when it worked.
ipcMain.handle('library:open', async () => {
  const dir = store.data.settings.libraryPath;
  if (!dir || !fs.existsSync(dir)) return "Couchbox can't find your video folder. Choose it again with Change folder.";
  return (await shell.openPath(dir)) ? "Windows couldn't open the folder." : '';
});
ipcMain.handle('fullscreen', (_e, on) => win.setFullScreen(!!on));
ipcMain.handle('window:state', () => ({ maximized: win.isMaximized(), fullscreen: win.isFullScreen() }));
ipcMain.handle('reveal', (_e, fileId) => {
  const f = library.findFile(fileId);
  if (f && fs.existsSync(f.file)) shell.showItemInFolder(f.file);
});
/* ---------- Find videos ---------- */
const QUICK_PLACES = [
  ['videos', 'Videos'],
  ['downloads', 'Downloads'],
  ['desktop', 'Desktop'],
];

function drives() {
  const out = [];
  for (let c = 67; c <= 90; c++) {
    const d = String.fromCharCode(c) + ':\\';
    try {
      if (fs.existsSync(d)) out.push(d);
    } catch (_) {}
  }
  return out;
}

ipcMain.handle('finder:places', () => {
  const quick = QUICK_PLACES.map(([key, label]) => {
    let p = null;
    try {
      p = app.getPath(key);
    } catch (_) {}
    return { key, label, path: p, exists: !!p && fs.existsSync(p) };
  });
  const last = store.data.settings.finderWhere || { whole: false, quick: ['videos', 'downloads', 'desktop'], folders: [] };
  return { quick, drives: drives(), last, state: finder.state(), hasLibrary: !!library.root, hasTmdbKey: !!getKey() };
});
ipcMain.handle('finder:choose-folder', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Choose a folder to search', properties: ['openDirectory'] });
  return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
});
ipcMain.handle('finder:search', (_e, where, filters) => {
  // Remember where to look (not the filters: those reset each time, as agreed).
  store.data.settings.finderWhere = { whole: !!where.whole, quick: where.quick || [], folders: where.folders || [] };
  store.save();
  const roots = where.whole
    ? drives()
    : [...QUICK_PLACES.filter(([k]) => (where.quick || []).includes(k)).map(([k]) => app.getPath(k)), ...(where.folders || [])].filter((p) => p && fs.existsSync(p));
  finder.search({ roots, ...filters }).catch((e) => console.error('[finder]', e));
  return true;
});
ipcMain.handle('finder:stop', () => finder.stop());
ipcMain.handle('finder:state', () => finder.state());
ipcMain.handle('finder:select', (_e, ids, value) => finder.select(ids, value));
ipcMain.handle('finder:use-copy', (_e, id) => finder.useCopy(id));
ipcMain.handle('finder:plan', (_e, mode) => finder.plan(mode));
ipcMain.handle('finder:add', (_e, mode) => finder.add(mode, (p) => send('finder-progress', p)));
ipcMain.handle('finder:add-stop', () => finder.stopAdd());
ipcMain.handle('finder:reveal', (_e, file) => {
  if (file && fs.existsSync(file)) shell.showItemInFolder(file);
});

ipcMain.handle('update:state', () => updates.getState());
ipcMain.handle('update:check', () => updates.check(true));
ipcMain.handle('update:download', () => updates.download());
ipcMain.handle('open-tmdb',() => shell.openExternal('https://www.themoviedb.org/settings/api'));
