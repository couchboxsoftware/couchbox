// The Unmatched tab and the improved Fix match, with a stand-in TMDB (test/fake-tmdb.js):
// the tab and its count (hidden for kids, with no key, and at 0); cards with the file name and
// folder that open Fix match; the year box and Films/Series/Both; tidying a matched file into
// Films\ (with its subtitles, progress and My list); a film file matched as an episode; a whole
// series matched (with a clash that's never overwritten); and a file that's converting, moved
// only once its conversion is done.
// Usage: npx electron test/unmatched-check.js   (screenshots go to COUCHBOX_SNAP_OUT, or a temp folder)
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');
const { app } = require('electron');
const { TEST_SETTINGS } = require('./quiet');
const ffmpeg = require('ffmpeg-static');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'couchbox-um-'));
const lib = path.join(tmp, 'Videos');
const imgs = path.join(tmp, 'img');
const out = process.env.COUCHBOX_SNAP_OUT || path.join(tmp, 'snaps');
for (const d of [lib, imgs, out]) fs.mkdirSync(d, { recursive: true });
process.env.COUCHBOX_FAKE_IMAGES = imgs;
process.env.COUCHBOX_DATA_DIR = path.join(tmp, 'data');
process.env.COUCHBOX_CONV_RATE = '0.3';
fs.mkdirSync(process.env.COUCHBOX_DATA_DIR);
require('./fake-tmdb');

const run = (args) => {
  const r = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
  if (r.status !== 0) throw new Error(String(r.stderr));
};
// Fake posters and stills.
['poster1', 'poster2', 'poster3', 'backdrop1', 'backdrop2', 'still1'].forEach((n, i) => run(['-f', 'lavfi', '-i', `color=c=0x${['8a3b2e', '2e5a8a', '3b8a4f', '6a3b8a', '8a7a2e', '444444'][i]}:size=300x450`, '-frames:v', '1', path.join(imgs, n + '.jpg')]));
function video(rel, audio = 'aac', secs = 10) {
  const f = path.join(lib, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  run(['-f', 'lavfi', '-i', `testsrc2=size=320x180:rate=25:duration=${secs}`, '-f', 'lavfi', '-i', `sine=duration=${secs}`, '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', audio, f]);
  const t = new Date(Date.now() - 3600e3);
  fs.utimesSync(f, t, t);
  return f;
}
video('Imported/mystery clip.mkv');
fs.writeFileSync(path.join(lib, 'Imported', 'mystery clip.srt'), '1\n00:00:01,000 --> 00:00:02,000\nHello\n');
video('Films/Odd Name (2001).mkv');
video('Series/Unknown Show/Season 01/Unknown Show - S01E01.mkv');
video('Series/Unknown Show/Season 01/Unknown Show - S01E02.mkv');
video('Imported/busy clip.mkv', 'eac3', 20); // needs converting
video('Films/Night Train (2019).mkv'); // recognised: never on the tab

const mysteryId = 'film:imported\\mystery clip.mkv';
fs.writeFileSync(path.join(process.env.COUCHBOX_DATA_DIR, 'couchbox-data.json'), JSON.stringify({
  settings: { libraryPath: lib, previews: false, tmdbKey: 'test-key', ...TEST_SETTINGS, autoConvert: true },
  profiles: [{ id: 'p1', name: 'Sam', color: '#2E9E6B', kids: false }, { id: 'p3', name: 'Kids', color: '#D9A21B', kids: true }],
  progress: { p1: { [mysteryId]: { t: 4, d: 10, u: Date.now() } } },
  lists: { p1: [mysteryId] },
}));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const errors = [];
const check = (name, ok, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== '' ? '  -- ' + detail : ''}`);
};
const exists = (rel) => fs.existsSync(path.join(lib, rel));

app.on('browser-window-created', (_e, win) => {
  win.webContents.once('did-finish-load', async () => {
    if (win.webContents.getURL().includes('splash.html')) return;
    win.webContents.on('console-message', (e) => {
      if (e.level === 'error' || e.level === 3) errors.push(e.message);
    });
    const js = (code) => win.webContents.executeJavaScript(code);
    const snap = async (name) => {
      await wait(500);
      fs.writeFileSync(path.join(out, name + '.png'), (await win.webContents.capturePage()).toPNG());
      console.log('snap', path.join(out, name + '.png'));
    };
    const until = async (code, ms = 30000) => {
      for (let t = 0; t < ms; t += 250) {
        if (await js(code)) return true;
        await wait(250);
      }
      return false;
    };
    const fix = async (id, query, { kind, year, pickTitle, season, episode }) => {
      await js(`Unmatched.openFix(${JSON.stringify(id)}, true)`);
      await wait(600);
      if (kind) await js(`document.querySelector('input[name="fm-kind"][value="${kind}"]')?.click()`);
      await js(`(() => { document.getElementById('fm-q').value = ${JSON.stringify(query)}; document.getElementById('fm-year').value = ${JSON.stringify(year || '')}; document.getElementById('fm-go').click(); })()`);
      await until(`document.querySelectorAll('#fm-results .match').length > 0`, 8000);
      await js(`[...document.querySelectorAll('#fm-results .match')].find(b => b.innerText.includes(${JSON.stringify(pickTitle)})).click()`);
      if (season) {
        await wait(300);
        await js(`(() => { document.getElementById('fm-season').value = '${season}'; document.getElementById('fm-episode').value = '${episode}'; document.getElementById('fm-ep-save').click(); })()`);
      }
      await until(`!document.querySelector('.fm')`, 15000);
      await wait(2500);
    };
    try {
      win.setSize(1400, 900);
      for (let i = 0; i < 100 && !win.isVisible(); i++) await wait(100);
      await js(`document.querySelector('[data-pid="p1"]').click()`);
      await until(`S.model.status.phase === 'idle' && S.model.films.some(f => f.noMatch)`, 40000);
      await wait(1000);

      // The tab.
      const tab = await js(`(() => { const t = document.querySelector('.tab[data-tab="unmatched"]'); return { hidden: t.hidden, count: t.querySelector('.tab-count').textContent }; })()`);
      check('Unmatched tab after My list, with the count', !tab.hidden && tab.count === '4', JSON.stringify(tab));
      await js(`document.querySelector('.tab[data-tab="unmatched"]').click()`);
      await wait(500);
      const cards = await js(`[...document.querySelectorAll('.um-card')].map(c => c.innerText.replace(/\\s+/g, ' '))`);
      check('cards from Imported\\, Films\\ and Series\\, newest first, with file name and folder', cards.length === 4 && cards.some((c) => /mystery clip\.mkv Imported/.test(c)) && cards.some((c) => /Odd Name.*Films/.test(c)) && cards.some((c) => /Unknown Show.*2 episodes/.test(c)), cards.join(' | '));
      check('a recognised title is not on the tab', !cards.some((c) => /Night Train/.test(c)));
      await snap('100-unmatched-tab');
      // Clicking a card opens Fix match straight away, with the preview.
      await js(`document.querySelector('.um-card[data-id="' + CSS.escape(${JSON.stringify(mysteryId)}) + '"]').click()`);
      await wait(1200);
      check('clicking a card opens Fix match (file name, folder, preview)', await js(`!!document.querySelector('.fm') && /mystery clip\\.mkv/.test(document.querySelector('.fm-file').innerText) && !!document.querySelector('.fm-preview')`));
      check('an unmatched film searches Both to start with', await js(`document.querySelector('input[name="fm-kind"]:checked').value === 'both'`));
      await js(`(() => { document.getElementById('fm-q').value = 'fernhill'; document.getElementById('fm-q').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); })()`);
      await until(`document.querySelectorAll('#fm-results .match').length > 0`, 8000);
      check('Enter searches', await js(`/Fernhill/.test(document.getElementById('fm-results').innerText)`));
      await js(`document.querySelector('input[name="fm-kind"][value="tv"]').click()`);
      await wait(800);
      check('Series only: no films in the results', await js(`!/Fernhill/.test(document.getElementById('fm-results').innerText)`));
      await snap('101-fix-match');
      await js('closeModal()');

      // 1. An Imported film: tidied into Films\ with its subtitle; progress and My list follow.
      await fix(mysteryId, 'fernhill', { kind: 'film', year: '2018', pickTitle: 'Fernhill' });
      const newId = 'film:films\\fernhill (2018).mkv';
      check('matched: moved to Films\\Fernhill (2018).mkv with its subtitle', exists('Films/Fernhill (2018).mkv') && exists('Films/Fernhill (2018).srt') && !exists('Imported/mystery clip.mkv'));
      check('...shown with its poster, off the tab', await js(`!!byId(${JSON.stringify(newId)}) && !!byId(${JSON.stringify(newId)}).poster && !Unmatched.items().some(i => i.id === ${JSON.stringify(newId)})`));
      const p1 = await js(`cb.getProgress('p1')`);
      check('...its progress and My list followed it', !!p1[newId] && (await js(`cb.getList('p1')`)).includes(newId));
      check('the tab stays open, count down to 3', await js(`S.tab === 'unmatched' && document.querySelector('.tab[data-tab="unmatched"] .tab-count').textContent === '3'`));

      // 2. A film file that's really an episode.
      await fix('film:films\\odd name (2001).mkv', 'the long coast', { kind: 'tv', pickTitle: 'The Long Coast', season: 1, episode: 2 });
      check('a film file matched to a series lands as that episode', exists('Series/The Long Coast/Season 01/The Long Coast - S01E02.mkv') && !exists('Films/Odd Name (2001).mkv'));
      check('...and it shows inside the series', await js(`(byId('series:the long coast') || { seasons: [] }).seasons.some(s => s.episodes.some(e => e.episode === 2))`));

      // 3. A whole series, where episode 2 is already there: never overwritten.
      await fix('series:unknown show', 'the long coast', { pickTitle: 'The Long Coast' });
      check('a matched series: episode 1 moved into Series\\The Long Coast\\Season 01', exists('Series/The Long Coast/Season 01/The Long Coast - S01E01.mkv'));
      check('a clash is never overwritten (episode 2 stays where it was)', exists('Series/Unknown Show/Season 01/Unknown Show - S01E02.mkv'));

      // 4. A file that's converting moves once its conversion is done.
      const busyId = 'film:imported\\busy clip.mkv';
      await until(`!!(S.conv.files[${JSON.stringify(busyId)}])`, 30000);
      await fix(busyId, 'paper moons', { kind: 'film', pickTitle: 'Paper Moons' });
      check('a converting file isn\'t moved yet', exists('Imported/busy clip.mkv') || fs.readdirSync(path.join(lib, 'Imported')).some((n) => /busy clip/.test(n)));
      for (let t = 0; t < 240 && !exists('Films/Paper Moons (2021).mkv'); t++) await wait(500);
      check('...it moves into Films once converted', exists('Films/Paper Moons (2021).mkv') && !fs.readdirSync(path.join(lib, 'Imported')).some((n) => /busy clip/.test(n)));

      // When the tab hides.
      await js(`S.model.tmdb = false; Unmatched.updateTab()`);
      check('hidden with no TMDB key', await js(`document.querySelector('.tab[data-tab="unmatched"]').hidden`));
      await js(`S.model.tmdb = true; pickProfile('p3')`);
      await wait(1000);
      check('hidden for kids', await js(`document.querySelector('.tab[data-tab="unmatched"]').hidden`));
      await js(`pickProfile('p1')`);
      await wait(800);
      // The title page's Fix match has the same window.
      await js(`openDetails('film:films\\\\night train (2019).mkv')`);
      await wait(500);
      await js(`document.querySelector('[data-act="fix-match"]').click()`);
      await wait(800);
      check('Fix match from a title\'s page uses the new window (films first)', await js(`!!document.querySelector('.fm-search #fm-year') && document.querySelector('input[name="fm-kind"]:checked').value === 'film'`));
      await js('closeModal()');
      check('no errors in the app', errors.length === 0, errors.join(' | '));
    } catch (e) {
      failed++;
      console.log('FAIL  ' + e.stack);
    }
    console.log(`\n${failed ? failed + ' failed' : 'all passed'}`);
    app.exit(0);
  });
});

require('../main.js');
