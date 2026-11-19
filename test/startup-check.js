// Start-up: the splash shows on its own with the main window waiting behind it, its bar steps
// through the loading, it stays at least 2.3 seconds, then hands over and closes and the main
// window shows; only one Couchbox runs (a second one passes over to the first and exits); F11
// switches full screen on and off; Ctrl+, opens Settings, but not while the player is open.
// Usage: npx electron test/startup-check.js
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, spawnSync } = require('child_process');
const { app, BrowserWindow } = require('electron');
const { TEST_SETTINGS } = require('./quiet');
const ffmpeg = require('ffmpeg-static');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'couchbox-start-'));
const lib = path.join(tmp, 'Videos');
fs.mkdirSync(path.join(lib, 'Films'), { recursive: true });
process.env.COUCHBOX_DATA_DIR = path.join(tmp, 'data');
process.env.COUCHBOX_NO_LOGIN_ITEM = '1';
fs.mkdirSync(process.env.COUCHBOX_DATA_DIR);
const film = path.join(lib, 'Films', 'Night Train (2019).mp4');
const r = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25:duration=30', '-f', 'lavfi', '-i', 'sine=duration=30', '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', film]);
if (r.status !== 0) throw new Error(String(r.stderr));
const t0 = new Date(Date.now() - 3600e3);
fs.utimesSync(film, t0, t0);
fs.writeFileSync(path.join(process.env.COUCHBOX_DATA_DIR, 'couchbox-data.json'), JSON.stringify({
  settings: { libraryPath: lib, previews: false, ...TEST_SETTINGS },
  profiles: [{ id: 'p1', name: 'Sam', color: '#2E9E6B', kids: false }],
}));

const wait = (ms) => new Promise((res) => setTimeout(res, ms));
let failed = 0;
const errors = [];
const check = (name, ok, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== '' ? '  -- ' + detail : ''}`);
};

// Watch the splash from the moment it's made.
let splash = null;
let main = null;
let splashUpAt = 0;
const widths = new Set();
app.on('browser-window-created', (_e, w) => {
  if (!splash) {
    splash = w; // the splash is made first
    w.once('show', () => (splashUpAt = Date.now()));
    const poll = setInterval(async () => {
      if (w.isDestroyed()) return clearInterval(poll);
      try {
        const width = await w.webContents.executeJavaScript(`(document.getElementById('bar') || {getAttribute(){return null}}).getAttribute('width')`);
        if (width != null) widths.add(Number(width));
      } catch (_) {}
    }, 40);
    return;
  }
  if (!main) {
    main = w;
    w.webContents.once('did-finish-load', run);
  }
});

async function run() {
  const win = main;
  const js = (code) => win.webContents.executeJavaScript(code);
  const until = async (fn, ms = 20000) => {
    for (let t = 0; t < ms; t += 100) {
      if (await fn()) return true;
      await wait(100);
    }
    return false;
  };
  const key = (keyCode, modifiers = []) => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    win.webContents.sendInputEvent({ type: 'char', keyCode, modifiers });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  };
  win.webContents.on('console-message', (e) => {
    if (e.level === 'error' || e.level === 3) errors.push(e.message);
  });
  try {
    // The splash: up first, on its own, the main window hidden behind it.
    check('the splash is showing', /splash\.html/.test(splash.webContents.getURL()) && (await until(() => !splash.isDestroyed() && splash.isVisible(), 5000)));
    check('the main window waits behind it', !win.isVisible());
    await until(() => splash.isDestroyed(), 20000);
    const shownFor = Date.now() - splashUpAt;
    const steps = [...widths].sort((a, b) => a - b);
    check('the splash bar steps through the loading', steps.length >= 3 && steps[steps.length - 1] >= 75.9, steps.join(' → '));
    check('the splash stays at least 2.3 seconds', shownFor >= 2300, shownFor + ' ms');
    check('the splash hands over and closes', splash.isDestroyed());
    check('then the main window shows', await until(() => win.isVisible(), 3000));

    // Only one Couchbox: a second one (same data folder) passes over to this one and exits.
    win.hide();
    const second = spawn(process.execPath, ['--mute-audio', path.join(__dirname, '..')], { env: { ...process.env }, stdio: 'ignore' });
    const code = await Promise.race([new Promise((res) => second.on('exit', res)), wait(20000).then(() => 'still running')]);
    if (code === 'still running') second.kill();
    check('a second Couchbox exits straight away', code === 0, 'exit ' + code);
    check('...and shows the one already running', await until(() => win.isVisible(), 3000));
    check('...with still just one main window', BrowserWindow.getAllWindows().filter((w) => /index\.html/.test(w.webContents.getURL())).length === 1);

    // F11, twice.
    win.focus();
    win.webContents.focus();
    key('F11');
    check('F11 goes full screen', await until(() => win.isFullScreen(), 4000));
    key('F11');
    check('F11 again comes out of full screen', await until(() => !win.isFullScreen(), 4000));
    await wait(600);

    // Ctrl+, opens Settings (once a profile is picked), but not while the player is open.
    await js(`document.querySelector('[data-pid="p1"]').click()`);
    await until(() => js(`!!(S.model && S.model.films.length === 1)`));
    await wait(500);
    win.webContents.focus();
    key(',', ['control']);
    check('Ctrl+, opens Settings', await until(() => js(`!!document.querySelector('.settings-dlg')`), 3000));
    await js('closeModal()');
    await wait(300);
    await js(`playFile(S.model.films[0].id)`);
    await until(() => js(`(() => { const v = document.querySelector('#player video.main'); return !!v && v.currentTime > 0.3; })()`));
    win.webContents.focus();
    key(',', ['control']);
    await wait(700);
    check('...but not while the player is open', !(await js(`!!document.querySelector('.settings-dlg')`)) && (await js('Player.isOpen()')));
    await js('Player.close()');
    await wait(400);

    check('no errors in the console', errors.length === 0, errors.join(' | '));
  } catch (e) {
    failed++;
    console.log('FAIL  ' + e.stack);
  }
  console.log(`\n${failed ? failed + ' failed' : 'all passed'}`);
  app.exit(failed ? 1 : 0);
}

require('../main.js');
