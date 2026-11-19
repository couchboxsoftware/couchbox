// Closing: windows inside Couchbox only close on a press AND release outside them (real mouse
// presses: dragging out of a window, or pressing outside and letting go inside, keeps it open),
// and Esc closes one; the close button hides Couchbox to the tray instead of quitting, and the
// tray brings it back; Quit while conversions are running asks first, "Keep running" keeps
// it running, and "Quit" quits. The question is answered by the check, so no real dialog waits.
// Usage: npx electron test/close-check.js
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');
const { app, dialog } = require('electron');
const { TEST_SETTINGS } = require('./quiet');
const ffmpeg = require('ffmpeg-static');

process.env.COUCHBOX_NO_LOGIN_ITEM = '1';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'couchbox-close-'));
const lib = path.join(tmp, 'Videos');
const dataDir = path.join(tmp, 'data');
for (const d of [path.join(lib, 'Films'), dataDir]) fs.mkdirSync(d, { recursive: true });
process.env.COUCHBOX_DATA_DIR = dataDir;
process.env.COUCHBOX_CONV_RATE = '0.25'; // a conversion that lasts long enough to quit during
const freeFile = path.join(tmp, 'free.txt');
fs.writeFileSync(freeFile, String(500 * 1024 ** 3));
process.env.COUCHBOX_FAKE_FREE_FILE = freeFile;
const film = path.join(lib, 'Films', 'Long Haul (2001).mkv'); // E-AC-3 sound: needs converting
const r = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25:duration=20', '-f', 'lavfi', '-i', 'sine=duration=20',
  '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'eac3', film]);
if (r.status !== 0) throw new Error(String(r.stderr));
const t0 = new Date(Date.now() - 3600e3);
fs.utimesSync(film, t0, t0);
fs.writeFileSync(path.join(dataDir, 'couchbox-data.json'), JSON.stringify({
  settings: { libraryPath: lib, previews: false, ...TEST_SETTINGS, autoConvert: true },
  profiles: [{ id: 'p1', name: 'Sam', color: '#2E9E6B', kids: false }],
}));

const wait = (ms) => new Promise((res) => setTimeout(res, ms));
let failed = 0;
const errors = [];
const check = (name, ok, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== '' ? '  -- ' + detail : ''}`);
};
const until = async (fn, ms = 30000) => {
  for (let t = 0; t < ms; t += 200) {
    if (await fn()) return true;
    await wait(200);
  }
  return false;
};

let asked = [];
let quitChecks = null;
app.on('browser-window-created', (_e, win) => {
  win.webContents.once('did-finish-load', async () => {
    if (win.webContents.getURL().includes('splash.html')) return;
    win.webContents.on('console-message', (e) => {
      if (e.level === 'error' || e.level === 3) errors.push(e.message);
    });
    const js = (code) => win.webContents.executeJavaScript(code);
    const wc = win.webContents;
    const { bg, converter } = global.__couchbox;
    const open = () => js(`!!document.querySelector('.settings-dlg')`);
    // A real press at a, moved in steps to b, released at b.
    const drag = async (a, b) => {
      wc.sendInputEvent({ type: 'mouseMove', x: a.x, y: a.y });
      await wait(30);
      wc.sendInputEvent({ type: 'mouseDown', x: a.x, y: a.y, button: 'left', clickCount: 1 });
      await wait(60);
      for (let i = 1; i <= 6; i++) {
        wc.sendInputEvent({ type: 'mouseMove', x: Math.round(a.x + ((b.x - a.x) * i) / 6), y: Math.round(a.y + ((b.y - a.y) * i) / 6), modifiers: ['leftButtonDown'] });
        await wait(25);
      }
      wc.sendInputEvent({ type: 'mouseUp', x: b.x, y: b.y, button: 'left', clickCount: 1 });
      await wait(400);
    };
    // A spot where the dark area round the window (the overlay itself) is under the mouse.
    const offWindow = () => js(`(() => { const ov = document.querySelector('#modal-root .overlay[data-close="1"]');
      for (const [x, y] of [[8, innerHeight - 8], [innerWidth - 8, innerHeight - 8], [8, innerHeight / 2], [innerWidth - 8, innerHeight / 2], [innerWidth / 2, innerHeight - 8]])
        if (document.elementFromPoint(x, y) === ov) return { x: Math.round(x), y: Math.round(y) };
      return null; })()`);
    try {
      for (let i = 0; i < 100 && !win.isVisible(); i++) await wait(100);
      await js(`document.querySelector('[data-pid="p1"]').click()`);
      await until(() => js(`!!(S.model && S.model.films.length === 1)`));
      await wait(600);
      win.focus();
      wc.focus();

      // Windows close only on a press and release outside them.
      await js(`openSettings(null, 'app')`);
      await wait(700);
      const box = await js(`(() => { const b = document.querySelector('.settings-dlg').getBoundingClientRect(); return { inside: { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) } }; })()`);
      box.outside = await offWindow();
      if (!box.outside) throw new Error('no dark area round Settings to press on');
      await drag(box.inside, box.outside);
      check('pressing inside a window and letting go outside keeps it open', await open());
      await drag(box.outside, box.inside);
      check('pressing outside and letting go inside keeps it open', await open());
      await drag(box.outside, box.outside);
      check('a press and release outside closes it', !(await open()));
      await js(`openSettings(null, 'app')`);
      await wait(400);
      wc.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
      wc.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
      check('Esc closes it', await until(async () => !(await open()), 2000));

      // The close button hides to the tray; the tray brings it back.
      win.close();
      await wait(600);
      check('closing hides Couchbox to the tray (it keeps running)', !win.isDestroyed() && !win.isVisible() && !!bg.trayState());
      bg.show();
      check('...and the tray opens it again', await until(() => win.isVisible(), 3000));

      // Quit while converting: asks; Keep running keeps it; Quit quits.
      check('a conversion is running', await until(() => converter.running.size > 0, 30000), String(converter.running.size));
      let answer = 1; // Keep running
      dialog.showMessageBox = async (...a) => {
        asked.push((a.length > 1 ? a[1] : a[0]).message);
        return { response: answer };
      };
      bg.trayMenu().find((i) => i.label === 'Quit').click();
      await wait(800);
      check('Quit while converting asks first', asked.length === 1 && /1 conversion is running\. Quit anyway\?/.test(asked[0]), asked.join(' | '));
      check('"Keep running" keeps Couchbox and the conversion running', !win.isDestroyed() && converter.running.size > 0);
      answer = 0; // Quit
      quitChecks = () => {
        check('"Quit" quits (asked once more, nothing else)', asked.length === 2, asked.join(' | '));
        check('no errors in the console', errors.length === 0, errors.join(' | '));
        console.log(`\n${failed ? failed + ' failed' : 'all passed'}`);
      };
      bg.trayMenu().find((i) => i.label === 'Quit').click();
      setTimeout(() => {
        check('"Quit" quits', false, 'still running after 15 s');
        app.exit(1);
      }, 15000).unref();
    } catch (e) {
      failed++;
      console.log('FAIL  ' + e.stack);
      console.log(`\n${failed} failed`);
      app.exit(1);
    }
  });
});
app.on('quit', () => {
  if (quitChecks) quitChecks();
  app.exit(failed ? 1 : 0);
});

require('../main.js');
