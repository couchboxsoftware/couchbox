// Carry-over test: a library laid out like "Show.S01.../Show.S02..." season packs, with My list,
// intro-skip, kids and progress saved against the OLD split shows (as older versions stored them).
// After a scan, everything should belong to the one combined show.
// Usage: npx electron test/season-migrate-check.js
const path = require('path');
const fs = require('fs');
const os = require('os');
const { app } = require('electron');
const { TEST_SETTINGS } = require('./quiet');

const lib = fs.mkdtempSync(path.join(os.tmpdir(), 'couchbox-migrate-lib-'));
const s1 = 'Desperate.Housewives.S01.1080p.AMZN.WEBRip.DDP5.1.x265-SiGMA[rartv]';
const s2 = 'Desperate.Housewives.S02.1080p.AMZN.WEBRip.DDP5.1.x265-SiGMA[rartv]';
const ep = (dir, s, e) => path.join(dir, `Desperate.Housewives.S0${s}E0${e}.Ep.1080p.mkv`);
for (const [dir, s] of [[s1, 1], [s2, 2]]) {
  fs.mkdirSync(path.join(lib, dir), { recursive: true });
  for (let e = 1; e <= 3; e++) fs.writeFileSync(path.join(lib, ep(dir, s, e)), '');
}
fs.writeFileSync(path.join(lib, 'Night.Train.2019.mkv'), '');
const OLD1 = 'series:desperate housewives s01', OLD2 = 'series:desperate housewives s02', NEW = 'series:desperate housewives';
const epId = 'ep:' + ep(s1, 1, 2).toLowerCase();
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'couchbox-migrate-'));
process.env.COUCHBOX_DATA_DIR = dataDir;
fs.writeFileSync(path.join(dataDir, 'couchbox-data.json'), JSON.stringify({
  settings: { libraryPath: lib, previews: false, ...TEST_SETTINGS },
  profiles: [{ id: 'p1', name: 'Sam', color: '#2E9E6B', kids: false }, { id: 'p2', name: 'Alex', color: '#3B82C4', kids: false }],
  lists: { p1: [OLD2, 'film:night.train.2019.mkv', OLD1], p2: [OLD1] },
  intros: { [OLD2]: { start: 12, end: 48 } }, // old series-wide marks: no longer used, removed
  introSeasons: { [OLD2 + '|2']: { status: 'confirmed', ref: { episodeId: 'x', start: 12, end: 48 } } },
  kidsAllow: { [OLD1]: true },
  progress: { p1: { [epId]: { t: 600, d: 2500, u: Date.now() } } },
  lastProfile: 'p1',
}));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== '' ? '  -- ' + detail : ''}`);
};
const data = () => JSON.parse(fs.readFileSync(path.join(dataDir, 'couchbox-data.json'), 'utf8'));

app.on('browser-window-created', (_e, win) => {
  win.webContents.once('did-finish-load', async () => {
    if (win.webContents.getURL().includes('splash.html')) return;
    const js = (code) => win.webContents.executeJavaScript(code);
    try {
      for (let i = 0; i < 100 && !win.isVisible(); i++) await wait(100);
      await js(`document.querySelector('[data-pid="p1"]').click()`);
      for (let i = 0; i < 100 && !(await js(`S.model.series.length > 0`)); i++) await wait(200);
      await wait(1500);
      const series = await js(`S.model.series.map(s => ({ id: s.id, title: s.title, seasons: s.seasons.map(x => x.number), eps: s.episodeCount }))`);
      check('one combined show', series.length === 1 && series[0].id === NEW && series[0].title === 'Desperate Housewives', JSON.stringify(series));
      check('with seasons 1 and 2, 6 episodes', series[0] && series[0].seasons.join(',') === '1,2' && series[0].eps === 6);
      const d = data();
      check('My list: old entries replaced by the combined show, once, in place', JSON.stringify(d.lists.p1) === JSON.stringify([NEW, 'film:night.train.2019.mkv']), JSON.stringify(d.lists.p1));
      check('My list for another profile carried over too', JSON.stringify(d.lists.p2) === JSON.stringify([NEW]), JSON.stringify(d.lists.p2));
      check('a season\'s intro (found automatically) carried over', d.introSeasons[NEW + '|2'] && d.introSeasons[NEW + '|2'].status === 'confirmed' && !d.introSeasons[OLD2 + '|2'], JSON.stringify(d.introSeasons));
      check('old series-wide intro marks are removed', !('intros' in d));
      check('kids setting carried over', d.kidsAllow[NEW] === true && !(OLD1 in d.kidsAllow), JSON.stringify(d.kidsAllow));
      check('episode progress untouched', d.progress.p1[epId] && d.progress.p1[epId].t === 600);
      check('the app shows the carried-over My list straight away', await js(`S.list.includes(${JSON.stringify(NEW)}) && !S.list.includes(${JSON.stringify(OLD1)})`));
      // A second scan changes nothing more.
      const before = fs.readFileSync(path.join(dataDir, 'couchbox-data.json'), 'utf8');
      await js(`cb.refresh()`);
      await wait(2500);
      check('a second scan leaves the settings as they are', JSON.stringify(JSON.parse(before).lists) === JSON.stringify(data().lists) && JSON.stringify(JSON.parse(before).introSeasons) === JSON.stringify(data().introSeasons));
    } catch (e) {
      failed++;
      console.log('FAIL  ' + e.message);
    }
    console.log(`\n${failed ? failed + ' failed' : 'all passed'}`);
    app.exit(0);
  });
});

require('../main.js');
