// The smarter matching in the app, with a stand-in TMDB (test/fake-tmdb.js): after the update,
// automatic matches are checked again once (a wrong one is put right), titles picked in Fix
// match are never touched, a year at the start of a name is understood, an unsure title goes
// to Unmatched with its best guesses at the top of Fix match, and nothing is checked twice.
// Usage: npx electron test/rematch-check.js   (screenshots go to COUCHBOX_SNAP_OUT, or a temp folder)
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');
const { app } = require('electron');
const { TEST_SETTINGS } = require('./quiet');
const ffmpeg = require('ffmpeg-static');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'couchbox-rm-'));
const lib = path.join(tmp, 'Videos');
const imgs = path.join(tmp, 'img');
const out = process.env.COUCHBOX_SNAP_OUT || path.join(tmp, 'snaps');
for (const d of [lib, imgs, out]) fs.mkdirSync(d, { recursive: true });
process.env.COUCHBOX_FAKE_IMAGES = imgs;
process.env.COUCHBOX_DATA_DIR = path.join(tmp, 'data');
fs.mkdirSync(process.env.COUCHBOX_DATA_DIR);
const { calls } = require('./fake-tmdb');

const run = (args) => {
  const r = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
  if (r.status !== 0) throw new Error(String(r.stderr));
};
['poster1', 'poster2', 'poster3', 'backdrop1', 'backdrop2', 'still1'].forEach((n, i) => run(['-f', 'lavfi', '-i', `color=c=0x${['8a3b2e', '2e5a8a', '3b8a4f', '6a3b8a', '8a7a2e', '444444'][i]}:size=300x450`, '-frames:v', '1', path.join(imgs, n + '.jpg')]));
let tone = 300;
function video(rel, secs = 10) {
  const f = path.join(lib, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  tone += 60; // each different: identical files count as copies
  run(['-f', 'lavfi', '-i', `testsrc2=size=160x90:rate=10:duration=${secs}`, '-f', 'lavfi', '-i', `sine=frequency=${tone}:duration=${secs}`, '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', f]);
  const t = new Date(Date.now() - 3600e3);
  fs.utimesSync(f, t, t);
}
video('Films/Night Train (2019).mkv');
video('Films/Fernhill.mkv');
video('Films/2021 - Paper Moons.mkv');
video('Films/Melody Time (1948).mkv', 90); // 1.5 minutes; TMDB's only answer is a 9-minute short
const ids = {
  wrong: 'film:films\\night train (2019).mkv',
  mine: 'film:films\\fernhill.mkv',
  yearFirst: 'film:films\\2021 - paper moons.mkv',
  unsure: 'film:films\\melody time (1948).mkv',
};
const dataDir = process.env.COUCHBOX_DATA_DIR;
fs.writeFileSync(path.join(dataDir, 'couchbox-data.json'), JSON.stringify({
  settings: { libraryPath: lib, previews: false, tmdbKey: 'test-key', ...TEST_SETTINGS },
  profiles: [{ id: 'p1', name: 'Sam', color: '#2E9E6B', kids: false }],
}));
// What an earlier Couchbox left: a wrong automatic match, and a title picked in Fix match.
fs.writeFileSync(path.join(dataDir, 'metadata.json'), JSON.stringify({
  files: {}, seasons: {}, added: {}, verified: {},
  titles: {
    [ids.wrong]: { tmdbId: 424242, title: 'Wrong Film', year: 1999, overview: '', genres: [] },
    [ids.mine]: { tmdbId: 777, title: 'My Own Pick', year: 2000, overview: '', genres: [] },
  },
  overrides: { [ids.mine]: 777 },
}));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const errors = [];
const check = (name, ok, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== '' ? '  -- ' + detail : ''}`);
};
const meta = () => JSON.parse(fs.readFileSync(path.join(dataDir, 'metadata.json'), 'utf8'));

app.on('browser-window-created', (_e, win) => {
  win.webContents.once('did-finish-load', async () => {
    if (win.webContents.getURL().includes('splash.html')) return;
    win.webContents.on('console-message', (e) => {
      if (e.level === 'error' || e.level === 3) errors.push(e.message);
    });
    const js = (code) => win.webContents.executeJavaScript(code);
    const until = async (code, ms = 30000) => {
      for (let t = 0; t < ms; t += 250) {
        if (await js(code)) return true;
        await wait(250);
      }
      return false;
    };
    const snap = async (name) => {
      await wait(500);
      fs.writeFileSync(path.join(out, name + '.png'), (await win.webContents.capturePage()).toPNG());
      console.log('snap', path.join(out, name + '.png'));
    };
    try {
      for (let i = 0; i < 100 && !win.isVisible(); i++) await wait(100);
      await js(`document.querySelector('[data-pid="p1"]').click()`);
      await until(`S.model && S.model.status && S.model.status.phase === 'idle' && S.model.films.length === 4`, 40000);
      await wait(1500);
      const film = (id) => js(`(() => { const f = S.model.films.find((x) => x.id === ${JSON.stringify(id)}); return f && { title: f.title, year: f.year, noMatch: f.noMatch, guesses: f.guesses }; })()`);

      const w = await film(ids.wrong);
      check('a wrong automatic match is put right when checked again', w && w.title === 'Night Train' && w.year === 2019, JSON.stringify(w));
      const m = await film(ids.mine);
      check('a title picked in Fix match is never touched', m && m.title === 'My Own Pick', JSON.stringify(m));
      const y = await film(ids.yearFirst);
      check('a year at the start: "2021 - Paper Moons" is Paper Moons (2021)', y && y.title === 'Paper Moons' && y.year === 2021, JSON.stringify(y));
      const u = await film(ids.unsure);
      check('an unsure title goes to Unmatched', u && u.noMatch, JSON.stringify(u));
      check('...with its best guess kept', u && u.guesses.length === 1 && /old time song/i.test(u.guesses[0].title), JSON.stringify(u && u.guesses));
      const md = meta();
      check('the check-again is recorded as done', md.matcher === 2, String(md.matcher));

      // Nothing is checked twice: another scan sends no searches.
      const before = calls.filter((c) => c.startsWith('/3/search')).length;
      await global.__couchbox.library.refresh();
      await wait(500);
      const after = calls.filter((c) => c.startsWith('/3/search')).length;
      check('another scan checks nothing again', after === before, `${after - before} new searches`);

      // Fix match: the guesses come first.
      await js(`Unmatched.openFix(${JSON.stringify(ids.unsure)}, true)`);
      await until(`!!document.querySelector('#fm-results .match')`, 8000);
      const fm = await js(`(() => { const r = document.getElementById('fm-results'); const h = [...r.querySelectorAll('.fm-group')].map((x) => x.textContent); return { heads: h, first: (r.querySelector('.match b') || {}).textContent || '' }; })()`);
      check('Fix match lists "Best guesses" first', fm.heads[0] === 'Best guesses' && /old time song/i.test(fm.first), JSON.stringify(fm));
      await snap('130-fix-match-guesses');
      await js(`closeModal()`);

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
