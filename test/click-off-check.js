// Click-off closing, with real mouse presses and releases (not scripted clicks): a window or
// menu closes only when the press AND the release are both outside it. Pressing inside and
// letting go outside (like selecting text), or pressing outside and letting go inside, keeps it
// open. Covers Settings, film details, Fix match (with a text selection that's kept), the
// profile menu and the player's Speed menu.
// Usage: npx electron test/click-off-check.js
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');
const { app } = require('electron');
const { TEST_SETTINGS } = require('./quiet');
const ffmpeg = require('ffmpeg-static');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'couchbox-co-'));
const lib = path.join(tmp, 'Videos');
const imgs = path.join(tmp, 'img');
for (const d of [lib, imgs]) fs.mkdirSync(d, { recursive: true });
process.env.COUCHBOX_FAKE_IMAGES = imgs;
process.env.COUCHBOX_DATA_DIR = path.join(tmp, 'data');
fs.mkdirSync(process.env.COUCHBOX_DATA_DIR);
require('./fake-tmdb');

const run = (args) => {
  const r = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
  if (r.status !== 0) throw new Error(String(r.stderr));
};
['poster1', 'poster2', 'poster3', 'backdrop1', 'backdrop2', 'still1'].forEach((n) => run(['-f', 'lavfi', '-i', 'color=c=0x444444:size=300x450', '-frames:v', '1', path.join(imgs, n + '.jpg')]));
let tone = 300;
function video(rel, secs = 30) {
  const f = path.join(lib, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  tone += 70; // each video different: identical files count as copies of one
  run(['-f', 'lavfi', '-i', `testsrc2=size=320x180:rate=25:duration=${secs}`, '-f', 'lavfi', '-i', `sine=frequency=${tone}:duration=${secs}`, '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', f]);
  const t = new Date(Date.now() - 3600e3);
  fs.utimesSync(f, t, t);
}
video('Films/Night Train (2019).mkv');
video('Imported/mystery clip.mkv');
const filmId = 'film:films\\night train (2019).mkv';
const mysteryId = 'film:imported\\mystery clip.mkv';
fs.writeFileSync(path.join(process.env.COUCHBOX_DATA_DIR, 'couchbox-data.json'), JSON.stringify({
  settings: { libraryPath: lib, previews: false, tmdbKey: 'test-key', ...TEST_SETTINGS },
  profiles: [{ id: 'p1', name: 'Sam', color: '#2E9E6B', kids: false }],
}));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const errors = [];
const check = (name, ok, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== '' ? '  -- ' + detail : ''}`);
};

app.on('browser-window-created', (_e, win) => {
  win.webContents.once('did-finish-load', async () => {
    if (win.webContents.getURL().includes('splash.html')) return;
    win.webContents.on('console-message', (e) => {
      if (e.level === 'error' || e.level === 3) errors.push(e.message);
    });
    const wc = win.webContents;
    const js = (code) => wc.executeJavaScript(code);
    const until = async (code, ms = 20000) => {
      for (let t = 0; t < ms; t += 250) {
        if (await js(code)) return true;
        await wait(250);
      }
      return false;
    };
    // The centre (or a spot near the left edge) of an element.
    const at = (sel, left = false) => js(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect();
      return { x: Math.round(${left} ? r.left + 6 : r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
    // A spot where the dark area round a window (the overlay itself) is what's under the mouse.
    const offWindow = () => js(`(() => { const ov = document.querySelector('#modal-root .overlay[data-close="1"]');
      for (const [x, y] of [[8, innerHeight - 8], [innerWidth - 8, innerHeight - 8], [8, innerHeight / 2], [innerWidth - 8, innerHeight / 2], [innerWidth / 2, innerHeight - 8]])
        if (document.elementFromPoint(x, y) === ov) return { x: Math.round(x), y: Math.round(y) };
      return null; })()`);
    // A real press at `a`, a drag to `b` (button held), and the release at `b`.
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
    const open = () => js(`!!document.querySelector('#modal-root .overlay[data-close="1"]')`);

    // The three cases for a click-off window: in->out, out->in (both stay open), out->out (closes).
    const threeWays = async (name, openIt, insideSel) => {
      await openIt();
      await wait(700);
      const off = await offWindow();
      check(`${name}: there's a dark area round it to click`, !!off);
      if (!off) return;
      await drag(await at(insideSel), off);
      check(`${name}: press inside, let go outside -> stays open`, await open());
      await drag(off, await at(insideSel));
      check(`${name}: press outside, let go inside -> stays open`, await open());
      await drag(off, off);
      check(`${name}: press and let go outside -> closes`, !(await open()));
    };

    try {
      for (let i = 0; i < 100 && !win.isVisible(); i++) await wait(100);
      await js(`document.querySelector('[data-pid="p1"]').click()`);
      await until(`S.model && S.model.films.length === 2`);
      await wait(1500);

      await threeWays('Settings', () => js(`openSettings(null, 'app')`), '#modal-root .overlay[data-close="1"] > *');
      await threeWays('Film details', () => js(`openDetails(${JSON.stringify(filmId)})`), '#modal-root .details');

      // Fix match: select text in the search box by dragging out past the window's edge.
      await js(`Unmatched.openFix(${JSON.stringify(mysteryId)}, true)`);
      await wait(700);
      await js(`(() => { const q = document.getElementById('fm-q'); q.value = 'mystery clip with a long name to select'; q.focus(); q.setSelectionRange(0, 0); })()`);
      const selected = () => js(`(() => { const q = document.getElementById('fm-q'); return q ? q.selectionEnd - q.selectionStart : -1; })()`);
      const inBox = await at('#fm-q');
      await drag(await at('#fm-q', true), inBox);
      const control = await selected();
      check('Fix match: dragging inside the search box selects text', control > 0, control + ' characters');
      await js(`document.getElementById('fm-q').setSelectionRange(0, 0)`);
      const off = await offWindow();
      // Let go to the right of the box, past the window's edge (to the left would select nothing).
      const offRight = await js(`(() => { const ov = document.querySelector('#modal-root .overlay[data-close="1"]'); const r = document.getElementById('fm-q').getBoundingClientRect();
        for (let x = innerWidth - 8; x > r.right; x -= 20) if (document.elementFromPoint(x, r.top + r.height / 2) === ov) return { x, y: Math.round(r.top + r.height / 2) };
        return null; })()`);
      check('Fix match: there is dark area to the right of the window', !!offRight);
      await drag(await at('#fm-q', true), offRight || off);
      check('Fix match: selecting text and letting go outside keeps the window', await open());
      const sel = await js(`(() => { const q = document.getElementById('fm-q'); return q ? q.selectionEnd - q.selectionStart : -1; })()`);
      check('Fix match: ...and the selection', sel > 0, sel + ' characters selected');
      await drag(off, off);
      check('Fix match: press and let go outside -> closes', !(await open()));

      // A click with no mouse (keyboard, or a script) on the dark area still closes, as before.
      await js(`openSettings(null, 'app')`);
      await wait(600);
      await js(`document.querySelector('#modal-root .overlay[data-close="1"]').click()`);
      await wait(400);
      check('a non-mouse click on the dark area still closes', !(await open()));

      // The profile menu.
      const menuOpen = () => js(`!!document.getElementById('pmenu')`);
      const away = await js(`({ x: Math.round(innerWidth / 2), y: innerHeight - 8 })`);
      await js(`document.querySelector('[data-act="profile-menu"]').click()`);
      await wait(400);
      await drag(await at('#pmenu'), away);
      check('profile menu: press inside, let go outside -> stays open', await menuOpen());
      await drag(away, await at('#pmenu'));
      check('profile menu: press outside, let go inside -> stays open', await menuOpen());
      await drag(away, away);
      check('profile menu: press and let go outside -> closes', !(await menuOpen()));
      await js(`closeModal()`);

      // The player's Speed menu.
      await js(`playFile(${JSON.stringify(filmId)})`);
      await until(`(() => { const v = document.querySelector('#player video.main'); return v && v.readyState >= 2; })()`);
      await wait(800);
      await js(`(() => { const v = document.querySelector('#player video.main'); v.pause(); document.querySelector('[data-p="speed-menu"]').click(); })()`);
      await wait(400);
      const popOpen = () => js(`!!document.querySelector('#player .p-pop')`);
      check('player: the Speed menu is open', await popOpen());
      const mid = await js(`({ x: Math.round(innerWidth / 2), y: Math.round(innerHeight / 2) })`);
      await drag(await at('#player .p-pop h4'), mid);
      check('player menu: press inside, let go outside -> stays open', await popOpen());
      await drag(mid, await at('#player .p-pop h4'));
      check('player menu: press outside, let go inside -> stays open', await popOpen());
      await drag(mid, mid);
      check('player menu: press and let go outside -> closes', !(await popOpen()));
      await wait(400);
      check('...without starting the video', await js(`document.querySelector('#player video.main').paused`));
      // With no menu open, clicking the picture still plays and pauses.
      await drag(mid, mid);
      await wait(500);
      check('player: clicking the picture still plays', !(await js(`document.querySelector('#player video.main').paused`)));

      check('no errors in the console', errors.length === 0, errors.join(' | '));
    } catch (e) {
      failed++;
      console.log('FAIL  ' + e.stack);
    }
    console.log(`\n${failed ? failed + ' failed' : 'all passed'}`);
    app.exit(failed ? 1 : 0);
  });
});

require('../main.js');
