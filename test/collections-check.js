// Your own collections, with a stand-in TMDB (test/fake-tmdb.js): making one (Collections tab,
// New collection), adding from Edit's search, a title's page (whole series, a season), the hover
// card and an episode row; the poster wall (no Play button), the three orders and dragging;
// rename, remove, delete; the rows on Home / Films / Series (the 50% rule) and the title page
// line; sharing (everyone, grown-ups, not shared) and only the maker editing; kids seeing only
// kids-safe titles and making their own; a deleted file hidden and coming back; an item
// following Fix match's tidy; a deleted profile's collections going with it.
// Usage: npx electron test/collections-check.js   (screenshots go to COUCHBOX_SNAP_OUT, or a temp folder)
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');
const { app } = require('electron');
const { TEST_SETTINGS } = require('./quiet');
const ffmpeg = require('ffmpeg-static');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'couchbox-coll-'));
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
  tone += 40; // each different: identical files count as copies of one
  run(['-f', 'lavfi', '-i', `testsrc2=size=160x90:rate=10:duration=${secs}`, '-f', 'lavfi', '-i', `sine=frequency=${tone}:duration=${secs}`, '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', f]);
  const t = new Date(Date.now() - 3600e3);
  fs.utimesSync(f, t, t);
  return f;
}
video('Films/Night Train (2019).mkv');
video('Films/Fernhill (2018).mkv');
const paperFile = video('Films/Paper Moons (2021).mkv');
video('Imported/mystery clip.mkv');
for (const [s, e] of [[1, 1], [1, 2], [1, 3], [2, 1]]) video(`Series/The Long Coast/Season 0${s}/The Long Coast - S0${s}E0${e}.mkv`);
const dataDir = process.env.COUCHBOX_DATA_DIR;
fs.writeFileSync(path.join(dataDir, 'couchbox-data.json'), JSON.stringify({
  settings: { libraryPath: lib, previews: false, tmdbKey: 'test-key', ...TEST_SETTINGS },
  profiles: [
    { id: 'p1', name: 'Sam', color: '#2E9E6B', kids: false },
    { id: 'p2', name: 'Alex', color: '#3B82C4', kids: false },
    { id: 'p3', name: 'Kim', color: '#D9A21B', kids: true },
  ],
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
      await wait(500);
      fs.writeFileSync(path.join(out, name + '.png'), (await win.webContents.capturePage()).toPNG());
      console.log('snap', path.join(out, name + '.png'));
    };
    const click = async (sel, ms = 350) => {
      const ok = await js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.click(); return true; })()`);
      await wait(ms);
      return ok;
    };
    const has = (sel) => js(`!!document.querySelector(${JSON.stringify(sel)})`);
    // Elements by a data- value (ids have backslashes, which CSS selectors would read as escapes).
    const findData = (sel, attr, val) => `[...document.querySelectorAll(${JSON.stringify(sel)})].find((e) => e.dataset[${JSON.stringify(attr)}] === ${JSON.stringify(val)})`;
    const hasData = (sel, attr, val) => js(`!!${findData(sel, attr, val)}`);
    const clickData = async (sel, attr, val, ms = 400) => {
      const ok = await js(`(() => { const e = ${findData(sel, attr, val)}; if (!e) return false; e.click(); return true; })()`);
      await wait(ms);
      return ok;
    };
    const cid = (name) => js(`(S.collections.find((c) => c.name === ${JSON.stringify(name)}) || {}).id || null`);
    const id = (title) => js(`(allItems().find((i) => i.title === ${JSON.stringify(title)}) || {}).id || null`);
    const epId = (s, e) => js(`(() => { const sr = S.model.series[0]; const se = sr.seasons.find((x) => x.number === ${s}); return se.episodes.find((x) => x.episode === ${e}).id; })()`);
    const keys = () => js(`[...document.querySelectorAll('#modal-root .cp-tile')].map((t) => t.dataset.key)`);
    const pickCid = (name) => js(`(() => { const c = S.collections.find((c) => c.name === ${JSON.stringify(name)}); return c ? c.id : ''; })()`);
    const tick = async (name) => click(`#coll-layer [data-cid="${await pickCid(name)}"]`, 600);
    const pick = async (pid) => {
      await js(`pickProfile(${JSON.stringify(pid)})`);
      await wait(600);
    };
    const tabRow = async (tab) => {
      await js(`(() => { S.tab = ${JSON.stringify(tab)}; S.query = ''; renderContent(); })()`);
      await wait(300);
      return js(`[...document.querySelectorAll('.row[data-row="coll"] .coll .coll-name')].map((x) => x.textContent)`);
    };
    try {
      for (let i = 0; i < 100 && !win.isVisible(); i++) await wait(100);
      await pick('p1');
      await until(`S.model.status && S.model.status.phase === 'idle' && allItems().length === 5 && allItems().every((i) => i.noMatch || i.poster)`, 60000);
      await wait(800);
      const ids = { night: await id('Night Train'), fern: await id('Fernhill'), paper: await id('Paper Moons'), coast: await id('The Long Coast'), mystery: await id('mystery clip') };
      check('the library is ready', Object.values(ids).every(Boolean), JSON.stringify(ids));

      // The Collections tab and New collection.
      await click('[data-act="tab"][data-tab="collections"]');
      check('Collections tab: empty, with a New collection card', (await has('.coll-wall .coll-new')) && !(await has('.coll-wall [data-act="coll-open"]')));
      await click('[data-act="coll-new"]');
      check('New collection asks for a name', await has('#coll-layer #cpk-name'));
      await click('#cpk-make');
      check('...a name is needed', !(await has('#coll-layer [hidden]#cpk-err')) && (await has('#coll-layer #cpk-err')));
      await js(`document.querySelector('#cpk-name').value = 'Weekend'`);
      await click('#cpk-make', 600);
      check('...it opens the new collection, ready to edit', (await has('#modal-root .coll-page #cp-name')) && (await has('#cp-q')));

      // Edit's search adds titles.
      const search = async (text) => {
        await js(`(() => { const q = document.getElementById('cp-q'); document.getElementById('cp-results').innerHTML = ''; q.value = ${JSON.stringify(text)}; q.dispatchEvent(new Event('input')); })()`);
        await until(`!!document.querySelector('#cp-results').children.length`, 5000); // the search waits until typing stops
        await wait(150);
      };
      await search('night');
      check('Edit: searching finds a title', await hasData('#cp-results [data-act="coll-search-add"]', 'id', ids.night));
      await clickData('#cp-results [data-act="coll-search-add"]', 'id', ids.night, 600);
      check('...Add puts it in, and the search stays', (await keys()).includes(`film:${ids.night}`) && (await has('#cp-results .cp-added')));
      await search('fern');
      await clickData('#cp-results [data-act="coll-search-add"]', 'id', ids.fern, 600);
      await click('[data-act="coll-edit"]');
      await js(`closeModal()`);
      await wait(300);

      // A title's page: Add to collection.
      await js(`openDetails(${JSON.stringify(ids.paper)})`);
      await wait(500);
      check("a title's page has the + menu", await has('#modal-root .details [data-act="menu-plus"]'));
      await js(`Coll.pick({ kind: 'film', id: ${JSON.stringify(ids.paper)} })`); // the collections window (as before)
      await wait(350);
      check('...it lists your collections, unticked', (await has('#coll-layer .cpk-row')) && !(await js(`document.querySelector('#coll-layer [data-cid]').checked`)));
      check("...a film has no whole/season/episodes choice", !(await has('#coll-layer .cpk-scope')));
      await tick('Weekend');
      check('...ticking one adds it', (await js(`S.collections.find((c) => c.name === 'Weekend').items.length`)) === 3);
      // New collection from the window: made with the title in it.
      await js(`document.querySelector('#cpk-name').value = 'Coast'`);
      await click('#cpk-create', 800);
      const coast = await cid('Coast');
      check('...a new collection made there has the title in it', !!coast && (await js(`S.collections.find((c) => c.name === 'Coast').items.map((i) => i.id)`)).includes(ids.paper));
      await click('#cpk-done');
      check("...the title's page says which collections it's in", /In your collections:.*Weekend|In your collections:.*Coast/.test(await js(`document.querySelector('#modal-root .d-side').textContent`)));
      await snap('150-add-to-collection-done');

      // A series' page: the whole series, or one season.
      await js(`closeModal(); openDetails(${JSON.stringify(ids.coast)}, 2)`);
      await wait(500);
      await click('#modal-root .details [data-act="menu-plus"]');
      await js(`[...document.querySelectorAll('.tmenu .tm-item')].find((x) => x.textContent.startsWith('A season or some episodes')).click()`);
      await wait(400);
      check("a series' page: whole series, one season or some episodes", (await js(`document.querySelectorAll('#coll-layer input[name="cpk-scope"]').length`)) === 3);
      await tick('Coast');
      await js(`(() => { const r = document.querySelector('#coll-layer input[name="cpk-scope"][value="season"]'); r.checked = true; r.dispatchEvent(new Event('change')); })()`);
      await wait(300);
      check('...choosing One season shows the seasons', await has('#coll-layer #cpk-season'));
      await snap('151-add-season');
      await tick('Coast');
      const coastItems = await js(`S.collections.find((c) => c.name === 'Coast').items.map((i) => i.kind + (i.season || ''))`);
      check('...the whole series and season 2 are in Coast', coastItems.includes('series') && coastItems.includes('season2'), JSON.stringify(coastItems));
      await click('#cpk-done');

      // An episode row's +.
      await js(`closeModal(); openDetails(${JSON.stringify(ids.coast)}, 1)`);
      await wait(500);
      const e2 = await epId(1, 2);
      check('each episode row has a + button', await hasData('#modal-root .ep [data-act="menu-plus-ep"]', 'file', e2));
      await clickData('#modal-root .ep [data-act="menu-plus-ep"]', 'file', e2, 0);
      await wait(400);
      check("...it doesn't start the episode", !(await js(`Player.isOpen()`)) && (await has('.tmenu')));
      await js(`[...document.querySelectorAll('.tmenu .tm-item')].find((x) => x.textContent.trim() === 'Weekend').click()`);
      await wait(500);
      await js(`Menus.close()`);
      await js(`closeModal()`);

      // The hover card's +.
      await js(`(() => { S.tab = 'home'; renderContent(); })()`);
      await wait(400);
      await js(`showHover(${findData('.row[data-row="films"] .card', 'id', ids.night)})`);
      await wait(300);
      check('the hover card has the + menu', await has('#hovercard [data-act="menu-plus"]'));
      await click('#hovercard [data-act="menu-plus"]');
      await js(`[...document.querySelectorAll('.tmenu .tm-item')].find((x) => x.textContent.trim() === 'New collection').click()`);
      await wait(300);
      await js(`document.querySelector('#cpk-name').value = 'Half'`);
      await click('#cpk-make', 800);
      const e1 = await epId(1, 1);
      await js(`openDetails(${JSON.stringify(ids.coast)}, 1)`);
      await wait(400);
      await clickData('#modal-root .ep [data-act="menu-plus-ep"]', 'file', e1, 0);
      await wait(400);
      await js(`[...document.querySelectorAll('.tmenu .tm-item')].find((x) => x.textContent.trim() === 'Half').click()`);
      await wait(500);
      await js(`Menus.close()`);
      await js(`closeModal()`);

      // The rows: Home all; Films / Series by the 50% rule.
      const home = await tabRow('home');
      check('Home: a "Your collections" row with all three', ['Weekend', 'Coast', 'Half'].every((n) => home.includes(n)), JSON.stringify(home));
      await snap('152-home-collections-row');
      const films = await tabRow('films');
      check('Films: collections at least half films (Weekend 3/4, Half 1/2)', films.includes('Weekend') && films.includes('Half') && !films.includes('Coast'), JSON.stringify(films));
      const series = await tabRow('series');
      check('Series: collections at least half series/seasons/episodes (Coast 2/3, Half 1/2)', series.includes('Coast') && series.includes('Half') && !series.includes('Weekend'), JSON.stringify(series));
      await tabRow('collections');
      check('the Collections tab shows them all', (await js(`document.querySelectorAll('.coll-wall [data-act="coll-open"]').length`)) === 3);
      check('a card is a 2x2 poster grid with name and count', (await js(`document.querySelectorAll('.coll-wall .coll-grid i').length`)) === 12 && /4 titles/.test(await js(`document.querySelector('.coll-wall').textContent`)));
      await snap('153-collections-tab');

      // The collection page: poster wall, no Play button, orders, dragging, rename, remove.
      const weekend = await cid('Weekend');
      await js(`Coll.openPage(${JSON.stringify(weekend)})`);
      await wait(500);
      check('the page is a poster wall (an episode as a wide still)', (await js(`document.querySelectorAll('#modal-root .cp-tile').length`)) === 4 && (await has('#modal-root .cp-tile.wide')));
      check('...with no Play button', !(await has('#modal-root .coll-page [data-act="play"]')));
      await snap('154-collection-page');
      const manual = await keys();
      check('...in your order (as added)', manual[0] === `film:${ids.night}` && manual[3] === `episode:${e2}`, JSON.stringify(manual));
      await click('[data-act="coll-order"][data-order="az"]', 500);
      const az = await keys();
      check('A to Z', az[0] === `film:${ids.fern}` && az[1] === `film:${ids.night}` && az[2] === `film:${ids.paper}`, JSON.stringify(az));
      await click('[data-act="coll-order"][data-order="release"]', 500);
      const rel = await keys();
      check('Release order (by year)', JSON.stringify(rel) === JSON.stringify([`film:${ids.fern}`, `film:${ids.night}`, `film:${ids.paper}`, `episode:${e2}`]), JSON.stringify(rel));
      await click('[data-act="coll-order"][data-order="manual"]', 500);
      await click('[data-act="coll-edit"]');
      check('Edit: drag handles in your order', await has('#modal-root .cp-tile[draggable="true"] .cp-grip'));
      await snap('155-collection-edit');
      // Drag Paper Moons onto the first tile.
      await js(`(() => {
        const tiles = [...document.querySelectorAll('#modal-root .cp-tile')];
        const from = tiles.find((t) => t.dataset.key === ${JSON.stringify(`film:${ids.paper}`)});
        const dt = new DataTransfer();
        from.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
        tiles[0].dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
        tiles[0].dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
        from.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
      })()`);
      await wait(600);
      check('dragging rearranges (saved)', (await keys())[0] === `film:${ids.paper}` && stored().collections.find((c) => c.id === weekend).items[0].id === ids.paper, JSON.stringify(await keys()));
      await js(`(() => { const n = document.getElementById('cp-name'); n.value = 'Weekend films'; n.dispatchEvent(new Event('change')); })()`);
      await wait(500);
      check('renaming saves', stored().collections.find((c) => c.id === weekend).name === 'Weekend films');
      await clickData('#modal-root [data-act="coll-remove"]', 'key', `film:${ids.fern}`, 500);
      check('× removes a title from the collection (not from the library)', !(await keys()).includes(`film:${ids.fern}`) && !!(await id('Fernhill')));
      await click('[data-act="coll-search-add"]', 100); // nothing there: harmless
      await search('fern');
      await clickData('#cp-results [data-act="coll-search-add"]', 'id', ids.fern, 600);
      // Opening a title from the page, and back.
      await click('[data-act="coll-edit"]');
      await clickData('#modal-root .cp-tile', 'key', `film:${ids.night}`, 500);
      check('clicking a title opens its page', (await js(`S.details && S.details.id`)) === ids.night);
      await js(`closeModal()`);
      await wait(400);
      check('...closing it goes back to the collection', await has('#modal-root .coll-page'));

      // Sharing, and only the maker editing.
      await click('[data-act="coll-edit"]');
      await js(`(() => { const s = document.getElementById('cp-share'); s.value = 'all'; s.dispatchEvent(new Event('change')); })()`);
      await wait(400);
      await js(`closeModal()`);
      await js(`Coll.openPage(${JSON.stringify(coast)}, true)`);
      await wait(400);
      await js(`(() => { const s = document.getElementById('cp-share'); s.value = 'grownups'; s.dispatchEvent(new Event('change')); })()`);
      await wait(400);
      await js(`closeModal()`);
      check('sharing is saved', stored().collections.find((c) => c.id === weekend).share === 'all' && stored().collections.find((c) => c.id === coast).share === 'grownups');
      await pick('p2');
      const alexSees = await js(`S.collections.map((c) => c.name).sort()`);
      check('another grown-up sees what is shared with everyone and with grown-ups, not the rest', JSON.stringify(alexSees) === JSON.stringify(['Coast', 'Weekend films']), JSON.stringify(alexSees));
      await js(`Coll.openPage(${JSON.stringify(weekend)})`);
      await wait(400);
      check('...with no Edit, and the maker named', !(await has('#modal-root [data-act="coll-edit"]')) && /Made by Sam/.test(await js(`document.querySelector('#modal-root .coll-page').textContent`)));
      const refused = await js(`cb.collectionAdd('p2', ${JSON.stringify(weekend)}, { kind: 'film', id: ${JSON.stringify(ids.mystery)} })`);
      check('...and Couchbox refuses changes from anyone but the maker', !!refused.error, JSON.stringify(refused));
      await js(`closeModal()`);

      // Kids: only kids-safe titles, and their own collections.
      await pick('p3');
      const kimSees = await js(`S.collections.filter((c) => Coll.itemsOf(c).length || c.mine).map((c) => c.name)`);
      check("a kids profile doesn't see collections shared only with grown-ups", !kimSees.includes('Coast') && kimSees.includes('Weekend films'), JSON.stringify(kimSees));
      await js(`Coll.openPage(${JSON.stringify(weekend)})`);
      await wait(400);
      const kimKeys = await keys();
      check('...and in one shared with everyone, only kids-safe titles', JSON.stringify(kimKeys) === JSON.stringify([`film:${ids.fern}`]), JSON.stringify(kimKeys));
      await js(`closeModal()`);
      await js(`Coll.act('coll-new')`);
      await wait(300);
      await js(`document.querySelector('#cpk-name').value = 'Kim picks'`);
      await click('#cpk-make', 600);
      await search('n');
      const kidHits = await js(`[...document.querySelectorAll('#cp-results [data-act="coll-search-add"]')].map((b) => b.dataset.id)`);
      check('kids can make their own, and search only finds kids-safe titles', kidHits.length === 1 && kidHits[0] === ids.fern, JSON.stringify(kidHits));
      await js(`closeModal()`);

      // A file deleted, then back.
      await pick('p1');
      const saved = fs.readFileSync(paperFile);
      fs.rmSync(paperFile);
      await js(`cb.refresh()`);
      await until(`!allItems().some((i) => i.title === 'Paper Moons')`, 20000);
      await js(`Coll.openPage(${JSON.stringify(weekend)})`);
      await wait(400);
      check("a title whose file is gone isn't shown", !(await keys()).includes(`film:${ids.paper}`));
      await js(`closeModal()`);
      fs.writeFileSync(paperFile, saved);
      await js(`cb.refresh()`);
      await until(`allItems().some((i) => i.title === 'Paper Moons')`, 20000);
      await wait(800);
      await js(`Coll.openPage(${JSON.stringify(weekend)})`);
      await wait(400);
      check('...and comes back with the file', (await keys()).includes(`film:${ids.paper}`));
      await js(`closeModal()`);

      // An item follows Fix match's tidy (its id changes).
      await js(`cb.collectionAdd('p1', ${JSON.stringify(weekend)}, { kind: 'film', id: ${JSON.stringify(ids.mystery)} }).then((r) => { S.collections = r.collections; })`);
      await wait(300);
      const results = await js(`cb.searchMatches(${JSON.stringify(ids.mystery)}, 'harbour lights', { kind: 'film' })`);
      await js(`cb.fixMatch(${JSON.stringify(ids.mystery)}, ${results[0].id}, { kind: 'film' })`);
      await until(`allItems().some((i) => i.title === 'Harbour Lights')`, 30000);
      await wait(1500);
      const harbour = await id('Harbour Lights');
      const items = stored().collections.find((c) => c.id === weekend).items.map((i) => i.id);
      check('after Fix match tidies a file, its place in the collection follows it', items.includes(harbour) && !items.includes(ids.mystery), JSON.stringify({ harbour, items }));

      // Delete a collection; a deleted profile's collections go with it.
      await js(`window.confirm = () => true; Coll.openPage(${JSON.stringify(await cid('Half'))})`);
      await wait(400);
      await click('[data-act="coll-edit"]');
      await click('[data-act="coll-delete"]', 500);
      check('Delete collection removes it (the titles stay)', !stored().collections.some((c) => c.name === 'Half') && !!(await id('Night Train')));
      await js(`cb.collectionCreate('p2', 'Alex stuff')`);
      await js(`cb.saveProfiles(S.profiles.filter((p) => p.id !== 'p2'))`);
      await wait(300);
      check("a deleted profile's collections go with it", !stored().collections.some((c) => c.owner === 'p2'));

      check('collections are saved in the data file', stored().collections.length === 3, stored().collections.map((c) => c.name).join(', '));
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
