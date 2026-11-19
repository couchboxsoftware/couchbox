// The + menu and the cog menu (menus.js), with a stand-in TMDB: My list and collections ticked
// on and off, New collection, a series' "a season or some episodes", episode rows; what the cog
// offers (films, series, episodes, kids); Reset intro skips for one season and the whole series;
// Delete from Couchbox for a film (with its subtitles), a season and an episode, typing DELETE,
// the bin entry and Restore (files, subtitles and progress back); refused while playing, and for
// kids.
// Usage: npx electron test/title-menu-check.js   (screenshots go to COUCHBOX_SNAP_OUT, or a temp folder)
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');
const { app } = require('electron');
const { TEST_SETTINGS } = require('./quiet');
const ffmpeg = require('ffmpeg-static');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'couchbox-menu-'));
const lib = path.join(tmp, 'Videos');
const imgs = path.join(tmp, 'img');
const out = process.env.COUCHBOX_SNAP_OUT || path.join(tmp, 'snaps');
for (const d of [lib, imgs, out]) fs.mkdirSync(d, { recursive: true });
process.env.COUCHBOX_FAKE_IMAGES = imgs;
process.env.COUCHBOX_DATA_DIR = path.join(tmp, 'data');
process.env.COUCHBOX_NO_LOGIN_ITEM = '1';
fs.mkdirSync(process.env.COUCHBOX_DATA_DIR);
require('./fake-tmdb');

const run = (args) => {
  const r = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
  if (r.status !== 0) throw new Error(String(r.stderr));
};
['poster1', 'poster2', 'poster3', 'backdrop1', 'backdrop2', 'still1'].forEach((n, i) => run(['-f', 'lavfi', '-i', `color=c=0x${['8a3b2e', '2e5a8a', '3b8a4f', '6a3b8a', '8a7a2e', '444444'][i]}:size=300x450`, '-frames:v', '1', path.join(imgs, n + '.jpg')]));
let tone = 300;
function video(rel, secs = 8) {
  const f = path.join(lib, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  tone += 40;
  run(['-f', 'lavfi', '-i', `testsrc2=size=160x90:rate=10:duration=${secs}`, '-f', 'lavfi', '-i', `sine=frequency=${tone}:duration=${secs}`, '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', f]);
  const t = new Date(Date.now() - 3600e3);
  fs.utimesSync(f, t, t);
  return f;
}
const nightFile = video('Films/Night Train (2019).mkv');
const nightSrt = path.join(lib, 'Films', 'Night Train (2019).srt');
fs.writeFileSync(nightSrt, '1\n00:00:01,000 --> 00:00:02,000\nHello\n');
video('Films/Fernhill (2018).mkv', 30);
const eps = {};
for (const [s, e] of [[1, 1], [1, 2], [1, 3], [2, 1]]) eps[`${s}.${e}`] = video(`Series/The Long Coast/Season 0${s}/The Long Coast - S0${s}E0${e}.mkv`);
const dataDir = process.env.COUCHBOX_DATA_DIR;
const nightId = 'film:films\\night train (2019).mkv';
fs.writeFileSync(path.join(dataDir, 'couchbox-data.json'), JSON.stringify({
  settings: { libraryPath: lib, previews: false, tmdbKey: 'test-key', ...TEST_SETTINGS },
  profiles: [{ id: 'p1', name: 'Sam', color: '#2E9E6B', kids: false }, { id: 'p3', name: 'Kim', color: '#D9A21B', kids: true }],
  progress: { p1: { [nightId]: { t: 4, d: 8, u: Date.now() } } },
  kidsAllow: { 'series:the long coast': true }, // so Kim sees the series
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
    const snap = async (name) => {
      await wait(400);
      fs.writeFileSync(path.join(out, name + '.png'), (await win.webContents.capturePage()).toPNG());
      console.log('snap', path.join(out, name + '.png'));
    };
    const has = (sel) => js(`!!document.querySelector(${JSON.stringify(sel)})`);
    const click = async (sel, ms = 350) => {
      const ok = await js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.click(); return true; })()`);
      await wait(ms);
      return ok;
    };
    const find = (sel, attr, val) => `[...document.querySelectorAll(${JSON.stringify(sel)})].find((e) => e.dataset[${JSON.stringify(attr)}] === ${JSON.stringify(val)})`;
    const clickData = async (sel, attr, val, ms = 350) => {
      const ok = await js(`(() => { const e = ${find(sel, attr, val)}; if (!e) return false; e.click(); return true; })()`);
      await wait(ms);
      return ok;
    };
    const menuItems = () => js(`[...document.querySelectorAll('.tmenu .tm-item')].map((b) => b.textContent.trim())`);
    const menuTicked = (label) => js(`(() => { const b = [...document.querySelectorAll('.tmenu .tm-item')].find((x) => x.textContent.trim() === ${JSON.stringify(label)}); return b ? b.getAttribute('aria-checked') === 'true' : null; })()`);
    const menuClick = async (label, ms = 450) => {
      await js(`[...document.querySelectorAll('.tmenu .tm-item')].find((x) => x.textContent.trim().startsWith(${JSON.stringify(label)})).click()`);
      await wait(ms);
    };
    const hover = async (id) => {
      await js(`(() => { S.tab = 'home'; S.query = ''; renderContent(); })()`);
      await wait(300);
      await js(`showHover(${find('.row .card', 'id', id)})`);
      await wait(300);
    };
    const pick = async (pid) => {
      await js(`pickProfile(${JSON.stringify(pid)})`);
      await wait(600);
    };
    const epId = (s, e) => js(`S.model.series[0].seasons.find((x) => x.number === ${s}).episodes.find((x) => x.episode === ${e}).id`);
    try {
      for (let i = 0; i < 100 && !win.isVisible(); i++) await wait(100);
      await pick('p1');
      await until(`S.model.status && S.model.status.phase === 'idle' && allItems().length === 3 && allItems().every((i) => i.poster)`, 60000);
      await wait(800);
      const coast = 'series:the long coast';

      /* ---------- the + menu ---------- */
      await hover(nightId);
      check('hover card: a + and a cog (no separate My list or collection buttons)', (await has('#hovercard [data-act="menu-plus"]')) && (await has('#hovercard [data-act="menu-cog"]')) && !(await has('#hovercard [data-act="list"]')) && !(await has('#hovercard [data-act="coll-add"]')));
      await click('#hovercard [data-act="menu-plus"]');
      const plus = await menuItems();
      check('+ menu: My list, then collections, then New collection', plus[0] === 'My list' && plus[plus.length - 1] === 'New collection' && (await has('.tmenu .tm-head')), JSON.stringify(plus));
      await menuClick('My list');
      check('ticking My list adds it, and the menu stays open with a tick', (await js(`S.list.includes(${JSON.stringify(nightId)})`)) && (await menuTicked('My list')) === true);
      await snap('160-plus-menu');
      await menuClick('New collection');
      check('New collection asks for a name', await has('#coll-layer #cpk-name'));
      await js(`document.querySelector('#cpk-name').value = 'Weekend'`);
      await click('#cpk-make', 700);
      check('...and makes it with the title in it', (await js(`(S.collections.find((c) => c.name === 'Weekend') || { items: [] }).items.some((i) => i.id === ${JSON.stringify(nightId)})`)));
      await hover(nightId);
      await click('#hovercard [data-act="menu-plus"]');
      check('the + menu shows the collection ticked', (await menuTicked('Weekend')) === true);
      await menuClick('Weekend');
      check('...unticking takes it out', (await menuTicked('Weekend')) === false && !(await js(`S.collections.find((c) => c.name === 'Weekend').items.length`)));
      await menuClick('Weekend');
      await menuClick('My list');
      check('...and My list unticks too', !(await js(`S.list.includes(${JSON.stringify(nightId)})`)));
      await js(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
      await wait(250);
      check('Esc closes the menu', !(await has('.tmenu')));
      await hover(nightId);
      await click('#hovercard [data-act="menu-plus"]');
      await click('#app', 250);
      check('a click elsewhere closes it', !(await has('.tmenu')));

      // A series' + menu, and episode rows.
      await js(`openDetails(${JSON.stringify(coast)}, 1)`);
      await wait(500);
      check("a title's page: the + and the cog by Play", (await has('#modal-root .details .d-actions [data-act="menu-plus"]')) && (await has('#modal-root .details .d-actions [data-act="menu-cog"]')));
      await click('#modal-root .details .d-actions [data-act="menu-plus"]');
      check("a series' + menu offers a season or some episodes", (await menuItems()).some((x) => x.startsWith('A season or some episodes')));
      await menuClick('A season or some episodes');
      check('...which opens the collections window with the choices', await has('#coll-layer .cpk-scope'));
      await click('#cpk-done');
      const e12 = await epId(1, 2);
      await clickData('#modal-root .ep [data-act="menu-plus-ep"]', 'file', e12);
      const epMenu = await menuItems();
      check("an episode's + menu: collections only (episodes aren't in My list)", !epMenu.includes('My list') && epMenu.includes('Weekend'), JSON.stringify(epMenu));
      await menuClick('Weekend');
      check('...ticking adds the episode', await js(`S.collections.find((c) => c.name === 'Weekend').items.some((i) => i.kind === 'episode' && i.id === ${JSON.stringify(e12)})`));
      await js(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
      await wait(200);

      /* ---------- what the cog offers ---------- */
      await click('#modal-root .details .d-actions [data-act="menu-cog"]');
      check("a series' cog: Reset intro skips and Delete from Couchbox", JSON.stringify(await menuItems()) === JSON.stringify(['Reset intro skips…', 'Delete from Couchbox…']), JSON.stringify(await menuItems()));
      await snap('161-cog-menu');
      await js(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
      await wait(200);
      await clickData('#modal-root .ep [data-act="menu-cog-ep"]', 'file', e12);
      check("an episode's cog: Delete this episode", JSON.stringify(await menuItems()) === JSON.stringify(['Delete this episode…']));
      await js(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
      await js(`closeModal()`);
      await hover(nightId);
      await click('#hovercard [data-act="menu-cog"]');
      check("a film's cog: Delete from Couchbox only", JSON.stringify(await menuItems()) === JSON.stringify(['Delete from Couchbox…']));
      await js(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
      await wait(200);

      /* ---------- Reset intro skips ---------- */
      const I = global.__couchbox.intros;
      const [e11, e13, e21] = [await epId(1, 1), await epId(1, 3), await epId(2, 1)];
      const seed = () => {
        const d = I.store.data;
        d.introSeasons[`${coast}|1`] = { status: 'confirmed', ref: { episodeId: e11, start: 1, end: 5 } };
        d.introSeasons[`${coast}|2`] = { status: 'confirmed', ref: { episodeId: e21, start: 1, end: 5 } };
        for (const id of [e11, e12, e13, e21]) {
          d.introEpisodes[id] = { start: 1, end: 5, source: 'confirmed' };
          d.introRejects[id] = [{ start: 2, end: 6 }];
        }
        I.store.save();
      };
      seed();
      await js(`openDetails(${JSON.stringify(coast)}, 1)`);
      await wait(400);
      await click('#modal-root .details .d-actions [data-act="menu-cog"]');
      await menuClick('Reset intro skips');
      check('Reset asks first: the whole series or a season', (await has('#menu-layer input[name="rs-scope"][value=""]')) && (await js(`document.querySelectorAll('#menu-layer input[name="rs-scope"]').length`)) === 3 && /Reset intro skips for The Long Coast\?/.test(await js(`document.querySelector('#menu-layer').textContent`)));
      await snap('162-reset-intros');
      await click('#rs-cancel');
      check('...Cancel changes nothing', I.store.data.introSeasons[`${coast}|1`].status === 'confirmed');
      await click('#modal-root .details .d-actions [data-act="menu-cog"]');
      await menuClick('Reset intro skips');
      await js(`(() => { const r = document.querySelector('#menu-layer input[name="rs-scope"][value="1"]'); r.checked = true; })()`);
      await click('#rs-go', 500);
      const d1 = I.store.data;
      check('one season: its confirmed intro, Yes/No and marked-wrong stretches are cleared', (!d1.introSeasons[`${coast}|1`] || d1.introSeasons[`${coast}|1`].status !== 'confirmed') && !d1.introRejects[e11] && !d1.introRejects[e13]);
      check('...the other season is left alone', d1.introSeasons[`${coast}|2`].status === 'confirmed' && !!d1.introRejects[e21]);
      seed();
      await click('#modal-root .details .d-actions [data-act="menu-cog"]');
      await menuClick('Reset intro skips');
      await click('#rs-go', 500);
      const d2 = I.store.data;
      check('the whole series: every season starts from scratch', ![1, 2].some((n) => d2.introSeasons[`${coast}|${n}`] && d2.introSeasons[`${coast}|${n}`].status === 'confirmed') && ![e11, e12, e13, e21].some((id) => d2.introRejects[id]));
      await js(`closeModal()`);

      /* ---------- Delete from Couchbox ---------- */
      await hover(nightId);
      await click('#hovercard [data-act="menu-cog"]');
      await menuClick('Delete from Couchbox', 700);
      const what = await js(`document.getElementById('dl-what').textContent`);
      check('Delete says what goes, with its subtitles, its size and the bin', /Delete Night Train \(2019\)\?/.test(what) && /1 video, with 1 subtitle file/.test(what) && /bin for 7 days/.test(what), what);
      check('...Delete only works once DELETE is typed', await js(`document.getElementById('dl-go').disabled`));
      await js(`(() => { const w = document.getElementById('dl-word'); w.value = 'delet'; w.dispatchEvent(new Event('input')); })()`);
      check('...not for something else', await js(`document.getElementById('dl-go').disabled`));
      await js(`(() => { const w = document.getElementById('dl-word'); w.value = 'delete'; w.dispatchEvent(new Event('input')); })()`);
      check('...typing it (any case) enables Delete', !(await js(`document.getElementById('dl-go').disabled`)));
      await snap('163-delete-film');
      await click('#dl-go', 1200);
      await until(`!allItems().some((i) => i.title === 'Night Train')`, 15000);
      check('the film and its subtitles leave the folder', !fs.existsSync(nightFile) && !fs.existsSync(nightSrt));
      check('...and Couchbox', !(await js(`allItems().some((i) => i.title === 'Night Train')`)));
      const bin = await js(`cb.convState()`);
      const entry = (bin.bin || []).find((b) => /Night Train \(2019\) \(deleted\)/.test(b.label));
      check('...they are in the bin as one item, kept 7 days', !!entry && entry.kind === 'deleted' && fs.existsSync(path.join(lib, '.couchbox-bin', 'Films', 'Night Train (2019).srt')), JSON.stringify(entry));
      // Settings, Playback: the bin with Restore.
      await js(`openSettings(null, 'playback')`);
      await wait(500);
      check('Settings, Playback lists it in the bin with Restore', /Night Train \(2019\) \(deleted\)/.test(await js(`document.querySelector('#conv-section').textContent`)) && (await has('#conv-section [data-act="conv-restore"][data-mode="copy"]')));
      await snap('164-bin-settings');
      await click('#conv-section [data-act="conv-restore"][data-mode="copy"]', 800);
      await until(`allItems().some((i) => i.title === 'Night Train')`, 15000);
      check('Restore puts the film and its subtitles back', fs.existsSync(nightFile) && fs.existsSync(nightSrt) && (await js(`allItems().some((i) => i.title === 'Night Train')`)));
      check('...with its progress', (await js(`cb.getProgress('p1')`))[nightId] && (await js(`cb.getProgress('p1')`))[nightId].t === 4);
      await js(`closeModal()`);

      // A season, from the series' cog.
      await js(`openDetails(${JSON.stringify(coast)}, 2)`);
      await wait(400);
      await click('#modal-root .details .d-actions [data-act="menu-cog"]');
      await menuClick('Delete from Couchbox', 600);
      check("a series: delete the whole series or one season", (await js(`document.querySelectorAll('#menu-layer input[name="dl-scope"]').length`)) === 3);
      await js(`(() => { const r = document.querySelector('#menu-layer input[name="dl-scope"][value="2"]'); r.checked = true; r.dispatchEvent(new Event('change')); })()`);
      await wait(500);
      check('...the window updates for the season', /The Long Coast · Season 2 \(1 episode\)/.test(await js(`document.getElementById('dl-what').textContent`)));
      await js(`(() => { const w = document.getElementById('dl-word'); w.value = 'DELETE'; w.dispatchEvent(new Event('input')); })()`);
      await click('#dl-go', 1200);
      await until(`!S.model.series[0].seasons.some((s) => s.number === 2)`, 15000);
      check('deleting a season takes just that season', !fs.existsSync(eps['2.1']) && fs.existsSync(eps['1.1']) && (await js(`S.model.series.length === 1`)));

      // An episode, from its row.
      await js(`closeModal(); openDetails(${JSON.stringify(coast)}, 1)`);
      await wait(500);
      await clickData('#modal-root .ep [data-act="menu-cog-ep"]', 'file', e13);
      await menuClick('Delete this episode', 600);
      check('...one episode', /The Long Coast · S1:E3/.test(await js(`document.getElementById('dl-what').textContent`)));
      await js(`(() => { const w = document.getElementById('dl-word'); w.value = 'DELETE'; w.dispatchEvent(new Event('input')); })()`);
      await click('#dl-go', 1200);
      await until(`S.model.series[0].seasons[0].episodes.length === 2`, 15000);
      check('deleting an episode takes just that episode', !fs.existsSync(eps['1.3']) && fs.existsSync(eps['1.2']));
      await js(`closeModal()`);

      // Refused while playing; kids can't delete.
      const fernId = await js(`allItems().find((i) => i.title === 'Fernhill').id`);
      await js(`playFile(${JSON.stringify(fernId)})`);
      await until(`(() => { const v = document.querySelector('#player video.main'); return v && !v.paused && v.currentTime > 0.3; })()`, 15000);
      await wait(500);
      const playing = await js(`cb.deleteInfo('p1', { kind: 'film', id: ${JSON.stringify(fernId)} })`);
      check('Delete is refused while the video is playing', /playing/i.test(playing.error || ''), JSON.stringify(playing));
      await js('Player.close()');
      await wait(400);
      const kidTry = await js(`cb.deleteTitle('p3', { kind: 'film', id: ${JSON.stringify(fernId)} })`);
      check("kids can't delete (Couchbox refuses)", /grown-up/i.test(kidTry.error || '') && (await js(`allItems().some((i) => i.title === 'Fernhill')`)));
      await pick('p3');
      await hover(fernId);
      check("a kids profile: no cog on a film", !(await has('#hovercard [data-act="menu-cog"]')));
      await js('hideHover()');
      await hover(coast);
      await click('#hovercard [data-act="menu-cog"]');
      check('...and on a series only Reset intro skips', JSON.stringify(await menuItems()) === JSON.stringify(['Reset intro skips…']));
      await js(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);

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
