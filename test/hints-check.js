// Hint pop-ups (renderer/hints.js): the + menu's hint shows the first time, before the menu;
// "Don't show this again" keeps it away (and is saved); the Delete hint shows before the Delete
// window, and again next time if it wasn't turned off; Esc closes a hint; Settings, App, Hints
// lists every hint and shows them again.
// Usage: npx electron test/hints-check.js   (screenshots go to COUCHBOX_SNAP_OUT, or a temp folder)
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');
const { app } = require('electron');
const { TEST_SETTINGS } = require('./quiet');
const ffmpeg = require('ffmpeg-static');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'couchbox-hints-'));
const lib = path.join(tmp, 'Videos');
const out = process.env.COUCHBOX_SNAP_OUT || path.join(tmp, 'snaps');
for (const d of [path.join(lib, 'Films'), out]) fs.mkdirSync(d, { recursive: true });
process.env.COUCHBOX_DATA_DIR = path.join(tmp, 'data');
process.env.COUCHBOX_NO_LOGIN_ITEM = '1';
fs.mkdirSync(process.env.COUCHBOX_DATA_DIR);
const film = path.join(lib, 'Films', 'Night Train (2019).mkv');
const r = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=10:duration=8', '-f', 'lavfi', '-i', 'sine=duration=8', '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', film]);
if (r.status !== 0) throw new Error(String(r.stderr));
const t0 = new Date(Date.now() - 3600e3);
fs.utimesSync(film, t0, t0);
const dataFile = path.join(process.env.COUCHBOX_DATA_DIR, 'couchbox-data.json');
fs.writeFileSync(dataFile, JSON.stringify({
  settings: { libraryPath: lib, previews: false, ...TEST_SETTINGS, hintsOff: {} }, // hints on for this check
  profiles: [{ id: 'p1', name: 'Sam', color: '#2E9E6B', kids: false }],
}));
const stored = () => JSON.parse(fs.readFileSync(dataFile, 'utf8'));

const wait = (ms) => new Promise((res) => setTimeout(res, ms));
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
    const js = (code) => win.webContents.executeJavaScript(code);
    const has = (sel) => js(`!!document.querySelector(${JSON.stringify(sel)})`);
    const click = async (sel, ms = 400) => {
      await js(`document.querySelector(${JSON.stringify(sel)}).click()`);
      await wait(ms);
    };
    const until = async (code, ms = 30000) => {
      for (let t = 0; t < ms; t += 250) {
        if (await js(code)) return true;
        await wait(250);
      }
      return false;
    };
    const hover = async () => {
      await js(`showHover(document.querySelector('.row .card'))`);
      await wait(300);
    };
    try {
      for (let i = 0; i < 100 && !win.isVisible(); i++) await wait(100);
      await js(`document.querySelector('[data-pid="p1"]').click()`);
      await until(`S.model && S.model.films.length === 1`);
      await wait(800);

      // The + menu: the hint first, then the menu.
      await hover();
      await click('#hovercard [data-act="menu-plus"]');
      check('the first + opens a hint before the menu', (await has('#hint-layer .hint-pop')) && !(await has('.tmenu')) && /My list and collections/.test(await js(`document.querySelector('#hint-layer').textContent`)));
      check("...with Don't show this again", await has('#hint-layer [data-hint-off]'));
      fs.writeFileSync(path.join(out, '170-hint-plus.png'), (await win.webContents.capturePage()).toPNG());
      await js(`document.querySelector('#hint-layer [data-hint-off]').click()`);
      await click('#hint-layer [data-hint-ok]', 600);
      check('OK closes it and the menu opens', !(await has('#hint-layer .hint-pop')) && (await has('.tmenu')));
      check("...and Don't show this again is saved", typeof (await js(`S.settings.hintsOff['plus-menu']`)) === 'number');
      await js(`Menus.close()`);
      await hover();
      await click('#hovercard [data-act="menu-plus"]');
      check('the next + goes straight to the menu', !(await has('#hint-layer .hint-pop')) && (await has('.tmenu')));
      await js(`Menus.close()`);

      // Delete: the hint first, then the Delete window; not turned off, so it shows again.
      await hover();
      await click('#hovercard [data-act="menu-cog"]');
      await js(`[...document.querySelectorAll('.tmenu .tm-item')].find((b) => b.textContent.startsWith('Delete')).click()`);
      await wait(400);
      check('Delete shows its hint about the bin first', (await has('#hint-layer .hint-pop')) && /bin for 7 days/.test(await js(`document.querySelector('#hint-layer').textContent`)) && !(await has('#menu-layer .pin-window')));
      await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
      await wait(500);
      check('Esc closes it, then the Delete window opens', !(await has('#hint-layer .hint-pop')) && (await has('#menu-layer #dl-word')));
      await click('#dl-cancel');
      await hover();
      await click('#hovercard [data-act="menu-cog"]');
      await js(`[...document.querySelectorAll('.tmenu .tm-item')].find((b) => b.textContent.startsWith('Delete')).click()`);
      await wait(400);
      check("not turned off, so it shows again next time", await has('#hint-layer .hint-pop'));
      await click('#hint-layer [data-hint-ok]', 500);
      await click('#dl-cancel');

      // Settings, App, Hints.
      await js(`openSettings(null, 'app')`);
      await wait(500);
      const rows = await js(`[...document.querySelectorAll('#settings-hints .hint-row')].map((r) => r.textContent.replace(/\\s+/g, ' ').trim())`);
      check('Settings, App lists every hint', rows.length === 2 && /Turned off/.test(rows[0]) && /Showing/.test(rows[1]), JSON.stringify(rows));
      fs.writeFileSync(path.join(out, '171-settings-hints.png'), (await win.webContents.capturePage()).toPNG());
      await click('#settings-hints [data-act="hint-reset"]', 500);
      check('Show again turns it back on', !(await js(`S.settings.hintsOff['plus-menu']`)) && /Showing/.test(await js(`document.querySelector('#settings-hints .hint-row').textContent`)));
      await js(`cb.setSettings({ hintsOff: { 'plus-menu': 1, 'delete-bin': 2 } }).then((s) => { S.settings = s; document.querySelector('#settings-hints').innerHTML = '<h3>Hints</h3>' + Hints.settingsHTML(); })`);
      await wait(300);
      await click('#settings-hints [data-act="hints-reset-all"]', 500);
      check('Show all hints again turns them all back on', (await js(`Object.keys(S.settings.hintsOff).length`)) === 0);
      await js(`closeModal()`);
      await hover();
      await click('#hovercard [data-act="menu-plus"]');
      check('...and the + hint shows again', await has('#hint-layer .hint-pop'));
      await click('#hint-layer [data-hint-ok]', 300);

      check('no errors in the console', errors.length === 0, errors.join(' | '));
    } catch (e) {
      failed++;
      console.log('FAIL  ' + e.stack + (errors.length ? '\n  page errors: ' + errors.join(' | ') : ''));
    }
    console.log(`\n${failed ? failed + ' failed' : 'all passed'}`);
    app.exit(failed ? 1 : 0);
  });
});

require('../main.js');
