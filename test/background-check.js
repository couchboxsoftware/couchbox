// Background mode: closing hides Couchbox to the tray and conversions carry on; the tray's
// colour, status and menu; Pause/Resume; keeping the PC awake only while converting; a file
// added while hidden gets queued; a second launch shows the window; Start with Windows (a
// stand-in, so this never touches the Windows registry); Quit asks while converting and leaves
// no half-made files. Also runs itself once with --background to check a hidden start (no
// window, splash or sounds until it's opened).
// Usage: npx electron test/background-check.js
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync, spawn } = require('child_process');
const { app, dialog, BrowserWindow } = require('electron');
const { TEST_SETTINGS } = require('./quiet');
const ffmpeg = require('ffmpeg-static');

const PHASE_BG = process.argv.includes('--background');
process.env.COUCHBOX_NO_LOGIN_ITEM = '1'; // never touch the real "Start with Windows" entry
const root = path.join(__dirname, '..');
const tmp = process.env.BG_TMP || fs.mkdtempSync(path.join(os.tmpdir(), 'couchbox-bg-'));
const lib = path.join(tmp, 'Videos');
const dataDir = path.join(tmp, PHASE_BG ? 'data-bg' : 'data');
for (const d of [lib, dataDir, path.join(lib, 'Films')]) fs.mkdirSync(d, { recursive: true });
process.env.COUCHBOX_DATA_DIR = dataDir;
process.env.COUCHBOX_CONV_RATE = '0.25'; // conversions last long enough to watch
const freeFile = path.join(tmp, 'free.txt');
fs.writeFileSync(freeFile, String(500 * 1024 ** 3));
process.env.COUCHBOX_FAKE_FREE_FILE = freeFile;
process.env.COUCHBOX_SPACE_RECHECK_MS = '1000';

// Each film gets its own sound: byte-identical files count as copies of one film (copies.js).
let tone = 300;
function make(rel, secs = 12) {
  const file = path.join(lib, rel);
  tone += 50;
  const r = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=size=320x180:rate=25:duration=${secs}`, '-f', 'lavfi', '-i', `sine=frequency=${tone}:duration=${secs}`,
    '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'eac3', file]);
  if (r.status !== 0) throw new Error(String(r.stderr));
  const t = new Date(Date.now() - 3600e3);
  fs.utimesSync(file, t, t);
}
if (!PHASE_BG) {
  make('Films/One (2001).mkv');
  make('Films/Two (2002).mkv');
}
fs.writeFileSync(path.join(dataDir, 'couchbox-data.json'), JSON.stringify({
  settings: { libraryPath: lib, previews: false, ...TEST_SETTINGS, autoConvert: !PHASE_BG, openingSounds: PHASE_BG },
  profiles: [{ id: 'p1', name: 'Sam', color: '#2E9E6B', kids: false }],
}));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${PHASE_BG ? '[hidden start] ' : ''}${name}${detail !== '' ? '  -- ' + detail : ''}`);
};
const until = async (fn, ms = 30000) => {
  for (let t = 0; t < ms; t += 250) {
    if (await fn()) return true;
    await wait(250);
  }
  return false;
};
const cbx = () => global.__couchbox;

/* ---------- phase B: started with --background ---------- */
if (PHASE_BG) {
  const windows = [];
  const sent = [];
  app.on('browser-window-created', (_e, w) => {
    windows.push(w);
    const orig = w.webContents.send.bind(w.webContents);
    w.webContents.send = (ch, ...a) => {
      sent.push(ch);
      return orig(ch, ...a);
    };
  });
  app.whenReady().then(async () => {
    await wait(5000);
    const main = windows.find((w) => !w.isDestroyed() && /index\.html/.test(w.webContents.getURL()));
    check('no splash window', !windows.some((w) => !w.isDestroyed() && /splash/.test(w.webContents.getURL())) && windows.length === 1, windows.length + ' windows');
    check('the main window stays hidden', main && !main.isVisible());
    check('no opening sounds', !sent.includes('app-shown'));
    check('the tray is there', !!cbx().bg && cbx().bg.trayState() === 'idle');
    cbx().bg.show();
    await wait(800);
    check('opening it from the tray shows the window', main.isVisible());
    check('...with the opening sounds (they are on)', sent.filter((c) => c === 'app-shown').length === 1);
    console.log(`\n[hidden start] ${failed ? failed + ' failed' : 'all passed'}`);
    app.exit(failed ? 1 : 0);
  });
  require('../main.js');
  return;
}

/* ---------- phase A: the normal start ---------- */
let quitChecks = null;
app.on('browser-window-created', (_e, win) => {
  win.webContents.once('did-finish-load', async () => {
    if (win.webContents.getURL().includes('splash.html')) return;
    const js = (code) => win.webContents.executeJavaScript(code);
    try {
      for (let i = 0; i < 100 && !win.isVisible(); i++) await wait(100);
      await js(`document.querySelector('[data-pid="p1"]').click()`);
      const { bg, converter } = cbx();
      await until(() => converter.running.size > 0);
      check('a conversion is running', converter.running.size > 0);
      check('tray: orange (busy) with the status', bg.trayState() === 'busy' && /^Converting \d/.test(bg.trayStatus()), bg.trayStatus());
      check('the PC is kept awake while converting', bg.keepingAwake());
      const labels = bg.trayMenu().map((i) => i.label);
      check('tray menu: status, Open Couchbox, Pause conversions, Quit', labels.includes('Open Couchbox') && labels.includes('Pause conversions') && labels.includes('Quit'), labels.join(' | '));

      // Close: hides, keeps converting.
      win.close();
      await wait(800);
      check('the close button hides the window (not closed)', !win.isDestroyed() && !win.isVisible());
      check('conversions carry on while hidden', converter.running.size > 0);
      check('the first hide shows the "still running" notification once', JSON.parse(fs.readFileSync(path.join(dataDir, 'couchbox-data.json'), 'utf8')).settings.trayHintShown === true);

      // A file added while hidden is found and queued.
      make('Films/Three (2003).mkv');
      const t3 = 'film:films\\three (2003).mkv';
      await until(() => converter.jobs().some((j) => j.id === t3), 40000);
      check('a file added while hidden is queued', converter.jobs().some((j) => j.id === t3));

      // Pause and Resume from the tray.
      bg.trayMenu().find((i) => i.label === 'Pause conversions').click();
      // The tray hears about it a moment after the conversions stop (the queue's update is batched).
      await until(() => converter.running.size === 0 && /^Paused/.test(bg.trayStatus()), 10000);
      check('tray Pause: nothing converting, PC allowed to sleep', converter.running.size === 0 && !bg.keepingAwake() && /^Paused/.test(bg.trayStatus()), bg.trayStatus());
      check('tray: back to grey when nothing is converting', bg.trayState() === 'idle');
      bg.trayMenu().find((i) => i.label === 'Resume conversions').click();
      await until(() => converter.running.size > 0 && bg.keepingAwake(), 10000);
      check('tray Resume: converting again', converter.running.size > 0 && bg.keepingAwake());

      // Warning: yellow.
      fs.writeFileSync(freeFile, '1000');
      make('Films/Four (2004).mkv');
      await until(() => bg.trayState() === 'warn', 40000);
      check('tray: yellow when there is a warning (not enough space)', bg.trayState() === 'warn', bg.trayStatus());
      fs.writeFileSync(freeFile, String(500 * 1024 ** 3));
      await until(() => bg.trayState() !== 'warn', 10000);

      // A second launch shows the existing window.
      const second = spawn(process.execPath, ['--mute-audio', root], { env: { ...process.env }, stdio: 'ignore' });
      const code = await new Promise((r) => second.on('exit', r));
      await wait(800);
      check('a second Couchbox exits and shows the one already running', code === 0 && win.isVisible() && BrowserWindow.getAllWindows().filter((w) => /index\.html/.test(w.webContents.getURL())).length === 1, 'exit ' + code);

      // Start with Windows (stand-in).
      await js(`openSettings(null, 'app')`);
      await wait(400);
      check('Settings, App: a "Start with Windows" switch, off', await js(`!!document.querySelector('[data-setting="startWithWindows"]') && !document.querySelector('[data-setting="startWithWindows"]').checked`));
      await js(`document.querySelector('[data-setting="startWithWindows"]').click()`);
      await wait(500);
      check('turning it on registers Couchbox to start hidden', bg.loginItem().openAtLogin === true);
      await js(`document.querySelector('[data-setting="startWithWindows"]').click(); closeModal()`);
      await wait(500);
      check('turning it off removes it', bg.loginItem().openAtLogin === false);

      // Quit while converting: asks; "Keep running" keeps it.
      await until(() => converter.running.size > 0, 20000);
      let asked = null;
      dialog.showMessageBox = async (...a) => {
        asked = (a.length > 1 ? a[1] : a[0]).message;
        return { response: 1 };
      };
      await js(`document.querySelector('[data-act="profile-menu"]').click()`);
      await wait(300);
      check('profile menu has Quit Couchbox', await js(`!!document.querySelector('#pmenu [data-act="quit-app"]')`));
      await js(`document.querySelector('#pmenu [data-act="quit-app"]').click()`);
      await wait(800);
      check('Quit while converting asks first', /conversions? (is|are) running\. Quit anyway\?/.test(asked || ''), asked);
      check('"Keep running" keeps it running', !win.isDestroyed() && converter.running.size > 0);

      // "Quit": leaves no half-made files. Checked as the app quits.
      const temps = () => fs.readdirSync(path.join(lib, 'Films')).filter((n) => /\.converting\./.test(n));
      check('there is a half-made file right now', temps().length > 0, temps().join(', '));
      dialog.showMessageBox = async () => ({ response: 0 });
      quitChecks = () => {
        check('Quit: no half-made files left', temps().length === 0, temps().join(', '));
        check('Quit: the originals are untouched', ['One (2001).mkv', 'Two (2002).mkv', 'Three (2003).mkv'].every((n) => fs.existsSync(path.join(lib, 'Films', n))));
        console.log(`\n${failed ? failed + ' failed' : 'all passed'}`);
      };
      bg.trayMenu().find((i) => i.label === 'Quit').click();
    } catch (e) {
      failed++;
      console.log('FAIL  ' + e.stack);
      console.log(`\n${failed} failed`);
      app.exit(1);
    }
  });
});
app.on('quit', () => quitChecks && quitChecks()); // after Couchbox's own clean-up (on will-quit)

// The hidden start first, in its own process (and its own data folder).
const b = spawnSync(process.execPath, ['--mute-audio', __filename, '--background'], { env: { ...process.env, BG_TMP: tmp }, encoding: 'utf8', timeout: 60000 });
process.stdout.write((b.stdout || '').split('\n').filter((l) => /^(PASS|FAIL)|hidden start\]/.test(l)).join('\n') + '\n');
if (b.status !== 0) failed++;

require('../main.js');
