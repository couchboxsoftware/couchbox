const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { JsonStore } = require('./src/main/store');
const { Library } = require('./src/main/library');
const { Tmdb } = require('./src/main/tmdb');
const updater = require('./src/main/updater');
const { Finder } = require('./src/main/finder');
const { Converter } = require('./src/main/converter');
const { Downloads } = require('./src/main/downloads');
const background = require('./src/main/background');
const { Tidy } = require('./src/main/tidy');
const { Copies } = require('./src/main/copies');
const shellMenu = require('./src/main/shell-menu');
const { Intros } = require('./src/main/intros');

if (process.env.COUCHBOX_DATA_DIR) app.setPath('userData', process.env.COUCHBOX_DATA_DIR);

// One Couchbox at a time: opening it again (Start menu, desktop) shows the one already running,
// even when it's hidden in the tray. (The lock is per data folder, so tests don't clash.)
if (!app.requestSingleInstanceLock()) {
  app.exit(0);
  process.exit(0);
}
// Started hidden (by "Start with Windows", or by the right-click menu's Copy/Move to Couchbox):
// no window, splash or sounds until it's opened.
const FIRST_ADDS = shellMenu.parseAdds(process.argv);
const BACKGROUND = process.argv.includes('--background') || FIRST_ADDS.length > 0;
let bg = null;
let addQueue = null;

let win = null;
let store = null;
let library = null;
let updates = null;
let finder = null;
let converter = null;
let downloads = null;
let intros = null;
let avatarDir = null; // profile pictures: <data>\avatars\<profile>-<time>.jpg

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

/* ---------- shows merged from season folders ---------- */
// map: { "series:desperate housewives s01": "series:desperate housewives", ... }. Moves My list
// entries, intro-skip times and kids settings from the old split shows to the combined show.
// Only touches entries that use an old id, so after the first time it changes nothing.
function migrateShowIds(map) {
  const d = store.data;
  let changed = false;
  for (const pid of Object.keys(d.lists || {})) {
    const list = d.lists[pid];
    if (!list.some((id) => map[id])) continue;
    const seen = new Set();
    d.lists[pid] = list.map((id) => map[id] || id).filter((id) => !seen.has(id) && seen.add(id));
    changed = true;
  }
  for (const key of ['kidsAllow']) {
    const obj = d[key] || {};
    for (const [old, now] of Object.entries(map)) {
      if (!(old in obj)) continue;
      if (!(now in obj)) obj[now] = obj[old];
      delete obj[old];
      changed = true;
    }
  }
  // Each season's intro (found automatically) follows the show to its new id.
  if (intros && intros.migrateShows(map)) changed = true;
  if (!changed) return;
  store.save();
  send('prefs-changed', { kidsAllow: d.kidsAllow });
}

// A converted file got a new name (for example .avi -> .mp4), so its id changed: move every
// profile's progress, My list entries and the kids setting to the new id.
function migrateFileId(oldId, newId) {
  const d = store.data;
  for (const p of Object.values(d.progress)) {
    if (p[oldId] && !p[newId]) p[newId] = p[oldId];
    delete p[oldId];
  }
  for (const pid of Object.keys(d.lists || {})) d.lists[pid] = [...new Set(d.lists[pid].map((id) => (id === oldId ? newId : id)))];
  if (oldId in d.kidsAllow) {
    if (!(newId in d.kidsAllow)) d.kidsAllow[newId] = d.kidsAllow[oldId];
    delete d.kidsAllow[oldId];
  }
  if (intros) intros.migrate(oldId, newId); // its intro too
  store.save();
  send('prefs-changed', { kidsAllow: d.kidsAllow, progress: true });
}

/* ---------- warnings ---------- */
// Anything that needs attention raises a warning against a Settings tab and section. The app
// shows a yellow "!" on the menu button, on Settings in the menu, on the tab and on the section.
const warnings = new Map();
function setWarning(id, w) {
  if (w) warnings.set(id, { id, ...w });
  else if (!warnings.delete(id)) return;
  send('warnings', [...warnings.values()]);
  if (bg) bg.setWarnings([...warnings.values()]); // the tray icon turns yellow
}

/* ---------- how the window opens ---------- */
// "When Couchbox opens": window (1400 x 860, centred), maximised, fullscreen (the default) or
// remember (size, position, maximised and fullscreen as they were when the app last closed).
const OPEN_MODES = ['window', 'maximized', 'fullscreen', 'remember'];
const openMode = () => (OPEN_MODES.includes(store.data.settings.openMode) ? store.data.settings.openMode : 'fullscreen');

// The remembered bounds, if they're still on a connected screen (a monitor may have gone).
function rememberedBounds() {
  const w = store.data.settings.windowState;
  const b = w && w.bounds;
  if (!b || !(b.width >= 900 && b.height >= 600)) return null;
  const { screen } = require('electron');
  const area = screen.getDisplayMatching(b).workArea;
  const overlapX = Math.min(b.x + b.width, area.x + area.width) - Math.max(b.x, area.x);
  const overlapY = Math.min(b.y + b.height, area.y + area.height) - Math.max(b.y, area.y);
  return overlapX > 200 && overlapY > 100 ? b : null;
}

function saveWindowState() {
  if (!win || win.isDestroyed()) return;
  store.data.settings.windowState = { bounds: win.getNormalBounds(), maximized: win.isMaximized(), fullscreen: win.isFullScreen() };
  store.save(true);
}

// Called as the splash hands over: put the hidden window into the chosen state, then show it.
function showMainWindow() {
  const mode = openMode();
  const saved = store.data.settings.windowState || {};
  const full = mode === 'fullscreen' || (mode === 'remember' && saved.fullscreen);
  const max = mode === 'maximized' || (mode === 'remember' && saved.maximized && !saved.fullscreen);
  if (full) win.setFullScreen(true);
  else if (max) win.maximize();
  win.show();
  win.focus();
  send('app-shown', { openingSounds: store.data.settings.openingSounds !== false, soundVolume: soundVolume() });
}

const soundVolume = () => {
  const v = store.data.settings.soundVolume;
  return typeof v === 'number' ? Math.min(1, Math.max(0, v)) : 0.5;
};

function createWindow() {
  const b = openMode() === 'remember' ? rememberedBounds() : null;
  win = new BrowserWindow({
    width: b ? b.width : 1400,
    height: b ? b.height : 860,
    ...(b ? { x: b.x, y: b.y } : { center: true }),
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
      autoplayPolicy: 'no-user-gesture-required', // the opening "bloom" plays before any click
    },
  });
  // Restore the exact remembered bounds (the constructor's size can come out a few pixels off
  // with Windows display scaling, which would make the window creep larger every launch).
  if (b) {
    win.setBounds(b);
    // Windows can still land a pixel or two out; measure and correct once.
    const a = win.getBounds();
    if (a.width !== b.width || a.height !== b.height || a.x !== b.x || a.y !== b.y)
      win.setBounds({ x: b.x - (a.x - b.x), y: b.y - (a.y - b.y), width: b.width - (a.width - b.width), height: b.height - (a.height - b.height) });
  }
  // The main window stays hidden until the splash hands over (see showMainWindow).
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  bg.attach(win); // the close button hides to the tray; a real quit saves the window state too
  win.on('close', () => bg.isQuitting() && saveWindowState());
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
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, autoplayPolicy: 'no-user-gesture-required' },
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
  // The splash plays the opening organ itself, if opening sounds are on.
  const sound = store.data.settings.openingSounds !== false ? '1' : '0';
  splash.loadFile(path.join(__dirname, 'renderer', 'splash.html'), { query: { v: require('./package.json').version, sound, vol: String(soundVolume()) } });
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
  if (BACKGROUND) {
    // Started hidden: stay in the tray until someone opens Couchbox.
    updates.start();
    return;
  }
  splashStep('fluffing the cushions', 'ok');
  const wait = Math.max(0, SPLASH_MIN_MS - (Date.now() - (splashShownAt || Date.now())));
  setTimeout(() => {
    runSplash('window.finish && finish()');
    setTimeout(() => {
      runSplash('window.fadeOut && fadeOut()');
      setTimeout(() => {
        if (win && !win.isDestroyed()) showMainWindow();
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
  updates = updater.create({
    send,
    // A downloaded update waits for running conversions to finish, and no new ones start meanwhile.
    canInstall: () => !converter || converter.running.size === 0,
    onWaiting: () => converter && converter.setHold(true),
  });
  // Settings are read first: the splash needs to know whether to play its sound.
  const dataDir = app.getPath('userData');
  store = new JsonStore(path.join(dataDir, 'couchbox-data.json'), {
    settings: { libraryPath: null, volume: 1, autoplayNext: true, previews: true },
    profiles: [],
    progress: {},
    lists: {},
    kidsAllow: {},
    lastProfile: null,
  });
  avatarDir = path.join(dataDir, 'avatars');
  bg = background.create({
    getWindow: () => win,
    store,
    getConverter: () => converter,
    showWindow: showMainWindow,
    saveWindowState,
    send,
    booting: () => !BACKGROUND && !boot.finished,
  });
  bg.startTray();
  // Keep "Start with Windows" pointing at this copy of Couchbox (it may have moved or updated).
  if (store.data.settings.startWithWindows) bg.setStartWithWindows(true);
  // Opening Couchbox again shows this one; Explorer's Copy/Move to Couchbox hands its files over.
  app.on('second-instance', (_e, argv) => {
    const adds = shellMenu.parseAdds(argv || []);
    if (adds.length && addQueue) addQueue.add(adds);
    else bg.show();
  });
  if (!BACKGROUND) createSplash();
  // Safety net: never leave someone staring at the splash.
  setTimeout(() => {
    boot.rendererReady = boot.scanned = true;
    maybeFinishSplash();
  }, 15000);
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
    onMigrate: migrateShowIds,
  });
  library.setTmdbKey(getKey());
  library.setRoot(store.data.settings.libraryPath);
  // Files still downloading: shown in purple, and never converted until they're finished.
  downloads = new Downloads({
    getLibrary: () => library,
    onChange: ({ structural }) => {
      send('downloads', { ...downloads.view(), structural });
      if (structural) converter.pump();
    },
    onStarted: (file) => converter.cancelPath(file),
  });
  library.downloads = downloads;
  downloads.start();
  converter = new Converter({
    dataDir,
    getLibrary: () => library,
    getProgress: () => store.data.progress,
    migrate: migrateFileId,
    onWarning: setWarning,
    // The tray follows the queue too (its colour and status, and keeping the PC awake).
    send: (ch, payload) => {
      send(ch, payload);
      if (ch === 'conversions') {
        bg.conversions(payload);
        // Nothing converting any more: intro detection can carry on.
        if (!payload.converting && intros) intros.schedule();
      }
    },
    enabled: () => store.data.settings.autoConvert !== false,
  });
  converter.start();
  // After Fix match, files are tidied into Films\ or Series\ (some wait for their conversion).
  library.tidy = new Tidy({
    getLibrary: () => library,
    getConverter: () => converter,
    migrateFile: migrateFileId,
    migrateShow: migrateShowIds,
    store,
  });
  // Spare copies and different versions put in the folder by hand.
  library.copies = new Copies({
    dataDir,
    getLibrary: () => library,
    binFile: (file, label) => converter.binCopy(file, label),
    // "Replace the one I have": start from the beginning (a "watched" tick stays).
    clearResume: (cardId) => {
      for (const p of Object.values(store.data.progress)) {
        const e = p[cardId];
        if (e && !(e.d > 0 && e.t / e.d >= 0.95)) delete p[cardId];
      }
      store.save();
      send('prefs-changed', { kidsAllow: store.data.kidsAllow, progress: true });
    },
    onWarning: setWarning,
    send,
  });
  // Intros found automatically, one season at a time, once the conversion queue is empty.
  intros = new Intros({ dataDir, getLibrary: () => library, getConverter: () => converter, store, send });
  // The right-click menu: files handed over by Explorer are added like Find videos adds them.
  addQueue = new shellMenu.AddQueue({
    getLibrary: () => library,
    notify: (n) => (global.__couchboxNotify || shellMenu.windowsNotify)(n),
    showWindow: (tab) => {
      bg.show();
      if (tab) send('open-settings', tab);
    },
  });
  addQueue.add(FIRST_ADDS);
  // Keep the menu pointing at this Couchbox (installed copies; the switch is in Settings, App).
  if (shellMenu.available() && store.data.settings.shellMenu !== false) shellMenu.register().then((err) => err && console.error('[menu]', err));
  library.afterRefresh = () => {
    converter.pump();
    library.tidy.runPending().catch((e) => console.error('[tidy]', e));
    intros.schedule();
  };
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

// Quitting: stop conversions and delete their half-made files (originals are never touched).
app.on('will-quit', () => {
  if (!converter) return;
  converter.stopAll();
  converter.cleanTemps();
  if (intros) intros.stop();
});

// For the test scripts (they run in this same process).
global.__couchbox = { get intros() { return intros; }, get addQueue() { return addQueue; }, get bg() { return bg; }, get converter() { return converter; }, get library() { return library; }, get updates() { return updates; } };

app.on('window-all-closed', () => {
  converter && converter.stopAll(); // half-done conversions start again next time
  downloads && downloads.stop();
  store && store.save(true);
  library && library.meta.save(true);
  app.quit();
});

// ---- IPC ----
const publicSettings = () => {
  const s = store.data.settings;
  return {
    libraryPath: s.libraryPath, hasTmdbKey: !!getKey(), volume: s.volume, autoplayNext: s.autoplayNext !== false, previews: s.previews !== false,
    openMode: openMode(), openingSounds: s.openingSounds !== false, soundVolume: soundVolume(),
    autoConvert: s.autoConvert !== false,
    startWithWindows: !!s.startWithWindows,
    shellMenu: s.shellMenu !== false,
    shellMenuAvailable: shellMenu.available(),
  };
};

ipcMain.handle('init', () => ({
  settings: publicSettings(),
  avatarBase: require('url').pathToFileURL(avatarDir).href + '/',
  profiles: store.data.profiles,
  lastProfile: store.data.lastProfile,
  introData: intros.view(),
  introAskMs: Number(process.env.COUCHBOX_INTRO_ASK_MS) || 15000, // how long "Was that the intro?" stays
  kidsAllow: store.data.kidsAllow,
  model: library.model(),
  conversions: converter.view(),
  downloads: downloads.view(),
  copies: library.copies.view(),
  warnings: [...warnings.values()],
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
  converter.cancelRunning(); // conversions in the old folder stop; the new folder gets its own queue
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
  const allowed = ['volume', 'autoplayNext', 'previews', 'openingSounds', 'soundVolume', 'openMode', 'autoConvert', 'startWithWindows'];
  if ('startWithWindows' in patch) bg.setStartWithWindows(!!patch.startWithWindows);
  for (const k of allowed) if (k in patch) store.data.settings[k] = patch[k];
  if ('openMode' in patch && !OPEN_MODES.includes(patch.openMode)) store.data.settings.openMode = 'fullscreen';
  store.save();
  if ('autoConvert' in patch) {
    if (!patch.autoConvert) converter.cancelRunning();
    converter.pump();
  }
  return publicSettings();
});

/* ---------- profile pictures ---------- */
const AVATAR_TYPES = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp'];
const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp' };

// Opens a picture for the cropper. It comes back as a data URL: the cropper draws it on a
// canvas and reads the pixels back, which file:// images wouldn't allow.
ipcMain.handle('avatar:choose', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Choose a profile picture', properties: ['openFile'], filters: [{ name: 'Pictures', extensions: AVATAR_TYPES }] });
  if (r.canceled || !r.filePaths[0]) return null;
  const file = r.filePaths[0];
  const ext = path.extname(file).slice(1).toLowerCase();
  if (!MIME[ext]) return { error: 'Choose a JPG, PNG, WebP, GIF or BMP picture.' };
  const size = fs.statSync(file).size;
  if (size > 40 * 1024 * 1024) return { error: 'That picture is too big (over 40 MB).' };
  return { dataUrl: `data:${MIME[ext]};base64,${fs.readFileSync(file).toString('base64')}` };
});

// Saves the cropped 200 x 200 JPEG. A new name each time, so the app never shows an old copy.
ipcMain.handle('avatar:save', (_e, profileId, dataUrl) => {
  const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl || '');
  if (!m || !/^[\w-]+$/.test(profileId)) return null;
  fs.mkdirSync(avatarDir, { recursive: true });
  const name = `${profileId}-${Date.now().toString(36)}.jpg`;
  fs.writeFileSync(path.join(avatarDir, name), Buffer.from(m[1], 'base64'));
  return name;
});

// Deletes picture files no profile uses any more (replaced, removed, or the profile deleted).
function cleanAvatars() {
  const used = new Set(store.data.profiles.map((p) => p.avatar).filter(Boolean));
  let files = [];
  try {
    files = fs.readdirSync(avatarDir);
  } catch (_) {}
  for (const f of files) if (!used.has(f)) fs.rmSync(path.join(avatarDir, f), { force: true });
}

ipcMain.handle('profiles:save', (_e, profiles) => {
  // A picture is only ever a plain file name inside the avatars folder.
  for (const p of profiles) if (p.avatar && !/^[\w-]+\.jpg$/.test(p.avatar)) delete p.avatar;
  store.data.profiles = profiles;
  cleanAvatars();
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
  if (t != null && d > 0 && t / d >= 0.9) converter.checkBin(); // a binned original may be done with
});
ipcMain.handle('progress:bulk', (_e, pid, entries) => {
  const p = (store.data.progress[pid] = store.data.progress[pid] || {});
  const now = Date.now();
  for (const [fileId, t, d] of entries) {
    if (t == null) delete p[fileId];
    else p[fileId] = { t: Math.round(t), d: Math.round(d), u: now };
  }
  store.save();
  converter.checkBin(); // "Mark as watched" counts as watched for the bin too
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

// Intros found automatically (intros.js): Yes and No after a Skip.
ipcMain.handle('intros:confirm', (_e, episodeId) => intros.confirm(episodeId));
ipcMain.handle('intros:reject', (_e, episodeId, old, answers) => intros.reject(episodeId, old, answers));

ipcMain.handle('subtitle', (_e, fileId, index) => library.subtitle(fileId, index));
/* ---------- conversions ---------- */
ipcMain.handle('conv:state', () => converter.view());
ipcMain.handle('conv:queue-next', (_e, key) => converter.queueNext(key));
ipcMain.handle('conv:retry', (_e, fileId) => converter.retry(fileId));
ipcMain.handle('conv:force', (_e, fileId) => converter.force(fileId));
ipcMain.handle('conv:pause', (_e, paused) => converter.setPaused(paused));
ipcMain.handle('conv:restore', (_e, key, mode) => converter.restore(key, mode === 'skip' ? 'skip' : 'retry'));
ipcMain.handle('conv:empty-bin', () => converter.emptyBin());
ipcMain.handle('conv:open-bin', async () => {
  const dir = converter.binDir();
  if (!dir || !fs.existsSync(dir)) return 'The bin is empty.';
  return (await shell.openPath(dir)) ? "Windows couldn't open the folder." : '';
});
ipcMain.handle('playing', (_e, fileId) => converter.setPlaying(fileId));

/* ---------- copies and versions ---------- */
ipcMain.handle('copies:bin', (_e, file) => library.copies.moveSpare(file));
ipcMain.handle('copies:keep', (_e, key) => library.copies.keepBoth(key));
ipcMain.handle('copies:decide', (_e, key, choice) => library.copies.decideVersion(key, choice));
ipcMain.handle('match:search', (_e, itemId, q, opts) => library.searchMatches(itemId, q, opts || {}));
ipcMain.handle('match:fix', (_e, itemId, tmdbId, opts) => library.fixMatch(itemId, tmdbId, opts || {}));
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
// "Update now anyway": stop the running conversions (they restart after the update) and install.
ipcMain.handle('update:install-now', () => {
  converter.cancelRunning();
  return updates.installNow();
});
ipcMain.handle('app:quit', () => bg.requestQuit());
// The right-click menu switch: adds or removes the menu straight away. Returns a problem, or ''.
ipcMain.handle('shellmenu:set', async (_e, on) => {
  if (!shellMenu.available()) return "The right-click menu needs the installed Couchbox (not the portable one).";
  const err = await (on ? shellMenu.register() : shellMenu.unregister());
  if (!err) {
    store.data.settings.shellMenu = !!on;
    store.save();
  }
  return err;
});

/* ---------- What's new (CHANGELOG.md) ---------- */
// whatsNew: the version to show the one-time "What's new" card for, after an update. A brand-new
// install (no profiles yet) doesn't get it; someone updating from before this existed does.
ipcMain.handle('changelog:get', () => {
  const changelog = require('./src/main/changelog');
  const current = require('./package.json').version;
  const entries = changelog.load();
  const seen = store.data.lastSeenVersion;
  let whatsNew = null;
  if (seen !== current) {
    if ((seen || store.data.profiles.length) && entries.some((e) => e.version === current)) whatsNew = current;
    else {
      store.data.lastSeenVersion = current;
      store.save();
    }
  }
  return { entries, current, whatsNew };
});
ipcMain.handle('changelog:seen', () => {
  store.data.lastSeenVersion = require('./package.json').version;
  store.save();
});
ipcMain.handle('open-tmdb',() => shell.openExternal('https://www.themoviedb.org/settings/api'));
