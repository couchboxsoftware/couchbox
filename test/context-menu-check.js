// The right-click menu (Couchbox > Copy / Move to Couchbox): started by Explorer with
// "--add copy <file>" while Couchbox is closed (it starts hidden: no window, splash or sounds),
// more launches gathered into one job, folders searched inside (season folders land as one show),
// non-video files ignored, "already there" and name clashes counted (never overwritten), no
// Couchbox folder yet, and the registry entries written and removed by the switch in Settings.
// Uses a throwaway registry key (HKCU\Software\CouchboxTest), never the real menu, and catches
// the notifications instead of showing them. Uses the stand-in TMDB (test/fake-tmdb.js).
// Usage: npx electron test/context-menu-check.js
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');
const { app, BrowserWindow } = require('electron');
const { TEST_SETTINGS } = require('./quiet');
const ffmpeg = require('ffmpeg-static');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'couchbox-menu-'));
const lib = path.join(tmp, 'Videos');
const pc = path.join(tmp, 'pc');
const imgs = path.join(tmp, 'img');
for (const d of [lib, pc, imgs]) fs.mkdirSync(d, { recursive: true });
process.env.COUCHBOX_DATA_DIR = path.join(tmp, 'data');
fs.mkdirSync(process.env.COUCHBOX_DATA_DIR);
process.env.COUCHBOX_FAKE_IMAGES = imgs;
process.env.COUCHBOX_SHELL_MENU_TEST = '1';
const REG = 'HKEY_CURRENT_USER\\Software\\CouchboxTest';
process.env.COUCHBOX_REG_ROOT = REG + '\\Classes';
process.env.COUCHBOX_ADD_GATHER_MS = '1500';
require('./fake-tmdb');

const run = (args) => {
  const r = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
  if (r.status !== 0) throw new Error(String(r.stderr));
};
['poster1', 'poster2', 'poster3', 'backdrop1', 'backdrop2', 'still1'].forEach((n) => run(['-f', 'lavfi', '-i', 'color=c=0x445566:size=200x300', '-frames:v', '1', path.join(imgs, n + '.jpg')]));
function video(file, secs = 8) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  run(['-f', 'lavfi', '-i', `testsrc2=size=320x180:rate=25:duration=${secs}`, '-f', 'lavfi', '-i', `sine=duration=${secs}`, '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', file]);
  const t = new Date(Date.now() - 3600e3);
  fs.utimesSync(file, t, t);
  return file;
}
// Already in Couchbox.
video(path.join(lib, 'Films', 'Night Train (2019).mkv'));
video(path.join(lib, 'Imported', 'home movie.mkv'), 4);
// On "the PC".
const fern = video(path.join(pc, 'Fernhill.2018.1080p.mkv'));
const paper = video(path.join(pc, 'to move', 'Paper Moons 2021.mkv'));
const pack = path.join(pc, 'to move', 'The Long Coast S01');
video(path.join(pack, 'The.Long.Coast.S01E01.mkv'));
video(path.join(pack, 'The.Long.Coast.S01E02.mkv'));
fs.writeFileSync(path.join(pack, 'readme.txt'), 'not a video');
fs.copyFileSync(path.join(lib, 'Films', 'Night Train (2019).mkv'), path.join(pc, 'to move', 'Night Train (2019).mkv')); // already there
video(path.join(pc, 'to move', 'home movie.mkv'), 6); // same name as one in Imported: a clash

fs.writeFileSync(path.join(process.env.COUCHBOX_DATA_DIR, 'couchbox-data.json'), JSON.stringify({
  settings: { libraryPath: lib, previews: false, tmdbKey: 'test-key', ...TEST_SETTINGS },
  profiles: [{ id: 'p1', name: 'Sam', color: '#2E9E6B', kids: false }],
}));
// As if Explorer started Couchbox with Copy to Couchbox on the Fernhill file.
process.argv.push('--add', 'copy', fern);

const notes = [];
global.__couchboxNotify = (n) => notes.push(n);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== '' ? '  -- ' + detail : ''}`);
};
const exists = (rel) => fs.existsSync(path.join(lib, rel));
const until = async (fn, ms = 60000) => {
  for (let t = 0; t < ms; t += 250) {
    if (await fn()) return true;
    await wait(250);
  }
  return false;
};
const regQuery = (key) => spawnSync('reg.exe', ['query', key, '/ve'], { encoding: 'utf8' });

const windows = [];
app.on('browser-window-created', (_e, w) => windows.push(w));
app.on('browser-window-created', (_e, win) => {
  win.webContents.once('did-finish-load', async () => {
    if (win.webContents.getURL().includes('splash.html')) return;
    const js = (code) => win.webContents.executeJavaScript(code);
    try {
      // 1. Started by Explorer with Copy to Couchbox: hidden, and the file is added.
      await until(() => notes.some((n) => /^Added/.test(n.title)));
      check('started hidden: no splash, no window', !windows.some((w) => !w.isDestroyed() && /splash/.test(w.webContents.getURL())) && !win.isVisible());
      check('Copy to Couchbox: added as Films\\Fernhill (2018).mkv, original kept', exists('Films/Fernhill (2018).mkv') && fs.existsSync(fern));
      check('one notification at the end: "Added 1 video to Couchbox"', notes.filter((n) => /^Added/.test(n.title)).length === 1 && notes.find((n) => /^Added/.test(n.title)).title === 'Added 1 video to Couchbox', JSON.stringify(notes));

      // 2. Five launches (Move to Couchbox) within a moment: one job, one notification.
      notes.length = 0;
      const moves = [paper, pack, path.join(pc, 'to move', 'Night Train (2019).mkv'), path.join(pc, 'to move', 'home movie.mkv'), path.join(pack, 'readme.txt')];
      for (const p of moves) {
        app.emit('second-instance', {}, [process.execPath, '--add', 'move', p], tmp);
        await wait(200);
      }
      await until(() => notes.some((n) => /^Added/.test(n.title)));
      await wait(1500);
      const end = notes.filter((n) => /^Added/.test(n.title));
      check('five launches make one job with one notification', end.length === 1, JSON.stringify(notes.map((n) => n.title + ' / ' + n.body)));
      check('it says what happened: added, already there, couldn\'t be added', /^Added 3 videos to Couchbox$/.test(end[0]?.title) && /1 already there/.test(end[0]?.body) && /1 couldn't be added/.test(end[0]?.body), end[0] && end[0].title + ' / ' + end[0].body);
      check('Move: the film moved in, original removed', exists('Films/Paper Moons (2021).mkv') && !fs.existsSync(paper));
      check('a season folder lands as one show in Series\\', exists('Series/The Long Coast/Season 01/The Long Coast - S01E01.mkv') && exists('Series/The Long Coast/Season 01/The Long Coast - S01E02.mkv'));
      check('non-video files are ignored', !fs.readdirSync(lib, { recursive: true }).some((n) => /readme/.test(String(n))));
      check('a name clash is never overwritten (the one there is untouched, the other stays put)', fs.statSync(path.join(lib, 'Imported', 'home movie.mkv')).size < fs.statSync(path.join(pc, 'to move', 'home movie.mkv')).size);
      check('"already there" isn\'t moved in again (left where it was)', fs.existsSync(path.join(pc, 'to move', 'Night Train (2019).mkv')));

      // 3. No Couchbox folder yet.
      notes.length = 0;
      const libObj = global.__couchbox.library;
      const root = libObj.root;
      libObj.root = null;
      app.emit('second-instance', {}, [process.execPath, '--add', 'copy', fern], tmp);
      await until(() => notes.length > 0, 10000);
      check('no Couchbox folder yet: "Choose a Couchbox folder first"', notes[0]?.title === 'Choose a Couchbox folder first');
      libObj.root = root;

      // 4. The registry entries, and the switch in Settings, App.
      const copyCmd = regQuery(`${REG}\\Classes\\SystemFileAssociations\\.mkv\\shell\\Couchbox\\shell\\1copy\\command`);
      check('on start the menu is written (videos): Copy runs Couchbox with --add copy', copyCmd.status === 0 && copyCmd.stdout.includes(process.execPath) && /--add copy "%1"/.test(copyCmd.stdout), copyCmd.stdout.trim().split('\n').pop());
      check('...and for folders', regQuery(`${REG}\\Classes\\Directory\\shell\\Couchbox\\shell\\2move\\command`).status === 0);
      await js(`pickProfile('p1')`);
      await wait(800);
      await js(`openSettings(null, 'app')`);
      await wait(400);
      check('Settings, App: "Show Couchbox in the right-click menu", on', await js(`!!document.querySelector('#set-shellmenu') && document.querySelector('#set-shellmenu').checked`));
      await js(`document.querySelector('#set-shellmenu').click()`);
      await wait(1500);
      check('turning it off removes the menu', regQuery(`${REG}\\Classes\\SystemFileAssociations\\.mkv\\shell\\Couchbox`).status !== 0 && regQuery(`${REG}\\Classes\\Directory\\shell\\Couchbox`).status !== 0);
      await js(`document.querySelector('#set-shellmenu').click()`);
      await wait(1500);
      check('turning it on adds it back', regQuery(`${REG}\\Classes\\SystemFileAssociations\\.mp4\\shell\\Couchbox\\shell\\2move\\command`).status === 0);
    } catch (e) {
      failed++;
      console.log('FAIL  ' + e.stack);
    }
    spawnSync('reg.exe', ['delete', REG, '/f']); // tidy up the throwaway key
    check('the throwaway registry key is removed', regQuery(REG).status !== 0);
    console.log(`\n${failed ? failed + ' failed' : 'all passed'}`);
    app.exit(0);
  });
});

require('../main.js');
