// "Remove from Continue watching": the ✕ on the hover card (only in that row) and the button on
// a title's page; a film and a series (part-way, and "Next episode") leave the row on Home, Films
// and Series; the resume point is kept; Undo; playing again brings it back; only this profile;
// saved; follows Fix match's tidy; the row goes when it's empty.
// Usage: npx electron test/continue-watching-check.js
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');
const { app } = require('electron');
const { TEST_SETTINGS } = require('./quiet');
const ffmpeg = require('ffmpeg-static');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'couchbox-cw-'));
const lib = path.join(tmp, 'Videos');
const imgs = path.join(tmp, 'img');
for (const d of [lib, imgs]) fs.mkdirSync(d, { recursive: true });
process.env.COUCHBOX_FAKE_IMAGES = imgs;
process.env.COUCHBOX_DATA_DIR = path.join(tmp, 'data');
process.env.COUCHBOX_NO_LOGIN_ITEM = '1';
fs.mkdirSync(process.env.COUCHBOX_DATA_DIR);
require('./fake-tmdb');

const run = (args) => {
  const r = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
  if (r.status !== 0) throw new Error(String(r.stderr));
};
['poster1', 'poster2', 'poster3', 'backdrop1', 'backdrop2', 'still1'].forEach((n) => run(['-f', 'lavfi', '-i', 'color=c=0x445566:size=300x450', '-frames:v', '1', path.join(imgs, n + '.jpg')]));
let tone = 300;
function video(rel, secs = 8) {
  const f = path.join(lib, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  tone += 40;
  run(['-f', 'lavfi', '-i', `testsrc2=size=160x90:rate=10:duration=${secs}`, '-f', 'lavfi', '-i', `sine=frequency=${tone}:duration=${secs}`, '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', f]);
  const t = new Date(Date.now() - 3600e3);
  fs.utimesSync(f, t, t);
}
video('Films/Night Train (2019).mkv');
video('Films/Fernhill (2018).mkv');
video('Imported/mystery clip.mkv');
for (const e of [1, 2, 3]) video(`Series/The Long Coast/Season 01/The Long Coast - S01E0${e}.mkv`);
video('Series/Other Show/Season 01/Other Show - S01E01.mkv');
video('Series/Other Show/Season 01/Other Show - S01E02.mkv');

const ids = {
  night: 'film:films\\night train (2019).mkv',
  fern: 'film:films\\fernhill (2018).mkv',
  mystery: 'film:imported\\mystery clip.mkv',
  coast: 'series:the long coast',
  coastE2: 'ep:series\\the long coast\\season 01\\the long coast - s01e02.mkv',
  other: 'series:other show',
  otherE1: 'ep:series\\other show\\season 01\\other show - s01e01.mkv',
};
const now = Date.now();
const P = (t, d, ago) => ({ t, d, u: now - ago });
const dataDir = process.env.COUCHBOX_DATA_DIR;
fs.writeFileSync(path.join(dataDir, 'couchbox-data.json'), JSON.stringify({
  settings: { libraryPath: lib, previews: false, tmdbKey: 'test-key', ...TEST_SETTINGS },
  profiles: [{ id: 'p1', name: 'Sam', color: '#2E9E6B', kids: false }, { id: 'p2', name: 'Alex', color: '#3B82C4', kids: false }],
  progress: {
    // Night Train part-way; The Long Coast part-way through S1E2; Other Show: E1 finished, so "Next: E2".
    p1: { [ids.night]: P(300, 6000, 5000), [ids.coastE2]: P(200, 2400, 4000), [ids.otherE1]: P(2400, 2400, 3000), [ids.mystery]: P(100, 1000, 2000) },
    p2: { [ids.night]: P(300, 6000, 5000) },
  },
}));
const stored = () => JSON.parse(fs.readFileSync(path.join(dataDir, 'couchbox-data.json'), 'utf8'));

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
    const js = (code) => win.webContents.executeJavaScript(code);
    const until = async (code, ms = 30000) => {
      for (let t = 0; t < ms; t += 250) {
        if (await js(code)) return true;
        await wait(250);
      }
      return false;
    };
    const find = (sel, attr, val) => `[...document.querySelectorAll(${JSON.stringify(sel)})].find((e) => e.dataset[${JSON.stringify(attr)}] === ${JSON.stringify(val)})`;
    const row = async (tab) => {
      await js(`(() => { S.tab = ${JSON.stringify(tab)}; S.query = ''; renderContent(); })()`);
      await wait(250);
      return js(`[...document.querySelectorAll('.row[data-row="cw"] .card')].map((c) => c.dataset.id)`);
    };
    const hover = async (rowKey, id) => {
      await js(`showHover(${find(`.row[data-row="${rowKey}"] .card`, 'id', id)})`);
      await wait(250);
    };
    const pick = async (pid) => {
      await js(`pickProfile(${JSON.stringify(pid)})`);
      await wait(600);
    };
    try {
      for (let i = 0; i < 100 && !win.isVisible(); i++) await wait(100);
      await pick('p1');
      await until(`S.model.status && S.model.status.phase === 'idle' && allItems().length === 5`, 60000);
      await wait(600);
      const start = await row('home');
      check('Continue watching has the film, the part-way series and the "next episode" series', [ids.night, ids.coast, ids.other, ids.mystery].every((i) => start.includes(i)), JSON.stringify(start));

      // The hover card's ✕, only in Continue watching.
      await hover('cw', ids.night);
      check('hover card in Continue watching: a ✕ "Remove from Continue watching"', !!(await js(`!!document.querySelector('#hovercard [data-act="cw-hide"]')`)) && /Remove from Continue watching/.test(await js(`document.querySelector('#hovercard [data-act="cw-hide"]').title`)));
      await js('hideHover()');
      await hover('films', ids.night);
      check('...but not on the same title in another row', !(await js(`!!document.querySelector('#hovercard [data-act="cw-hide"]')`)));
      await js('hideHover()');
      await hover('cw', ids.night);
      const before = (await js(`cb.getProgress('p1')`))[ids.night];
      await js(`document.querySelector('#hovercard [data-act="cw-hide"]').click()`);
      await wait(500);
      check('✕ takes the film out of the row on Home', !(await row('home')).includes(ids.night));
      check('...and on Films', !(await row('films')).includes(ids.night));
      check('...says so, with Undo', (await js(`document.getElementById('toast').classList.contains('show')`)) && /Removed from Continue watching/.test(await js(`document.getElementById('toast').textContent`)) && !!(await js(`!!document.querySelector('#toast .toast-act')`)));
      const after = (await js(`cb.getProgress('p1')`))[ids.night];
      check('...the resume point is kept', JSON.stringify(before) === JSON.stringify(after));
      await js(`document.querySelector('#toast .toast-act').click()`);
      await wait(400);
      check('Undo puts it back', (await row('home')).includes(ids.night));

      // A title's page.
      await js(`openDetails(${JSON.stringify(ids.coast)})`);
      await wait(400);
      check("a title in the row: its page has Remove from Continue watching", !!(await js(`!!document.querySelector('#modal-root .details [data-act="cw-hide"]')`)));
      await js(`document.querySelector('#modal-root .details [data-act="cw-hide"]').click()`);
      await wait(500);
      check('...pressing it removes the series (part-way) from Home and Series', !(await row('home')).includes(ids.coast) && !(await row('series')).includes(ids.coast));
      check("...and the button goes", !(await js(`!!document.querySelector('#modal-root .details [data-act="cw-hide"]')`)));
      await js(`closeModal(); openDetails(${JSON.stringify(ids.fern)})`);
      await wait(300);
      check("a title not in the row: no button", !(await js(`!!document.querySelector('#modal-root .details [data-act="cw-hide"]')`)));
      await js(`closeModal()`);
      await row('home');
      await hover('cw', ids.other);
      await js(`document.querySelector('#hovercard [data-act="cw-hide"]').click()`);
      await wait(500);
      check('a series showing "Next episode" can be removed too', !(await row('home')).includes(ids.other));

      // Only this profile; saved.
      check('saved for this profile', Object.keys(stored().cwHidden.p1 || {}).length === 2 && !stored().cwHidden.p2);
      await pick('p2');
      check("another profile's row is unaffected", (await row('home')).includes(ids.night));
      await pick('p1');
      check('still out after switching back', !(await row('home')).includes(ids.coast));

      // Playing again brings it back (any episode of a series).
      const e3 = 'ep:series\\the long coast\\season 01\\the long coast - s01e03.mkv';
      await js(`cb.setProgress('p1', ${JSON.stringify(e3)}, 60, 2400).then(() => cb.getProgress('p1')).then((p) => { S.progress = p; renderContent(); })`);
      await wait(400);
      check('playing any episode again brings the series back', (await row('home')).includes(ids.coast));

      // Follows Fix match's tidy (the film's id changes).
      await hover('cw', ids.mystery);
      await js(`document.querySelector('#hovercard [data-act="cw-hide"]').click()`);
      await wait(400);
      const results = await js(`cb.searchMatches(${JSON.stringify(ids.mystery)}, 'harbour lights', { kind: 'film' })`);
      await js(`cb.fixMatch(${JSON.stringify(ids.mystery)}, ${results[0].id}, { kind: 'film' })`);
      await until(`allItems().some((i) => i.title === 'Harbour Lights')`, 30000);
      await wait(1500);
      const harbour = await js(`allItems().find((i) => i.title === 'Harbour Lights').id`);
      check('after Fix match tidies a file, it stays out of the row', !(await row('home')).includes(harbour) && harbour in (stored().cwHidden.p1 || {}), harbour);

      // The row goes when the last title leaves it.
      for (const id of await row('home')) {
        await hover('cw', id);
        await js(`document.querySelector('#hovercard [data-act="cw-hide"]').click()`);
        await wait(400);
      }
      check('the row disappears when the last title is removed', !(await js(`!!document.querySelector('.row[data-row="cw"]')`)));

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
