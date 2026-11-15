// "Find videos" test: drives the real app against a throwaway test computer folder and test
// library (see the README), with the stand-in TMDB. Saves screenshots and prints what happened.
// Usage: set FINDER_TEST (folder with library\ and pc\), COUCHBOX_SNAP_OUT and COUCHBOX_FAKE_IMAGES,
// then: npx electron test/finder-check.js
const path = require('path');
const fs = require('fs');
const os = require('os');
const { app } = require('electron');

const T = process.env.FINDER_TEST;
const out = process.env.COUCHBOX_SNAP_OUT;
const lib = path.join(T, 'library');
const pc = path.join(T, 'pc');
fs.mkdirSync(out, { recursive: true });
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'couchbox-finder-'));
process.env.COUCHBOX_DATA_DIR = dataDir;
fs.writeFileSync(path.join(dataDir, 'couchbox-data.json'), JSON.stringify({
  settings: { libraryPath: lib, tmdbKey: 'test-key', previews: false, finderWhere: { whole: false, quick: [], folders: [pc] }, ...require('./quiet').TEST_SETTINGS },
  profiles: [{ id: 'p1', name: 'Sam', color: '#2E9E6B', kids: false }, { id: 'p3', name: 'Kids', color: '#C9A227', kids: true }],
}));
require('./fake-tmdb');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`);
};

app.on('browser-window-created', (_e, win) => {
  win.webContents.once('did-finish-load', async () => {
    if (win.webContents.getURL().includes('splash.html')) return;
    win.setSize(1400, 900);
    win.webContents.on('console-message', (e) => {
      if (e.level === 'error' || e.level === 'warning' || e.level === 3 || e.level === 2) errors.push(e.message);
    });
    const js = (code) => win.webContents.executeJavaScript(code);
    const snap = async (name) => {
      await wait(450);
      fs.writeFileSync(path.join(out, name + '.png'), (await win.webContents.capturePage()).toPNG());
      console.log('snap', name);
    };
    const until = async (label, code, ms = 60000) => {
      for (let t = 0; t < ms; t += 250) {
        if (await js(code)) return;
        await wait(250);
      }
      throw new Error('timed out waiting for ' + label);
    };
    const state = () => js('cb.finderState()');
    const row = (st, name) => st.results.find((r) => r.name === name);
    try {
      for (let i = 0; i < 100 && !win.isVisible(); i++) await wait(100);
      await js(`document.querySelector('[data-pid="p1"]').click()`);
      await until('library scan', `document.getElementById('statuspill').hidden && S.model.films.length > 0`, 90000);
      await wait(1000);

      // --- search ---
      await js(`openSettings(null, 'find')`);
      await until('find tab', `!!document.getElementById('finder-root')`);
      await js(`(() => { const i = document.getElementById('f-min'); i.value = '0.5'; i.dispatchEvent(new Event('input')); })()`);
      await snap('30-find-tab');
      await js(`document.querySelector('[data-f="search"]').click()`);
      await until('search done', `cb.finderState().then(s => s.status.phase === 'done')`, 120000);
      await wait(800);
      await snap('31-find-results');
      let st = await state();
      console.log('\nResults:');
      for (const r of st.results) console.log(`  ${r.state.padEnd(9)} ${r.selected ? '[x]' : '[ ]'} ${r.name.padEnd(40)} ${r.label}${r.note ? ' | ' + r.note : ''}`);
      console.log('');
      const names = st.results.map((r) => r.name);
      check('too-short video left out (tiny.mp4)', !names.includes('tiny.mp4'));
      check('unticked file type left out (other.flv)', !names.includes('other.flv'));
      check('best copy of a new film is ticked', row(st, 'Harbour.Lights.2020.1080p.mkv')?.selected === true);
      check('lower-quality copy is greyed as a copy', row(st, 'harbour lights 2020.mp4')?.state === 'copy');
      check('main length of a new film is green, not yellow', row(st, 'Harbour.Lights.2020.1080p.mkv')?.state === 'match');
      check('exact copies: the one without "(copy)" in its name is kept', row(st, 'holiday clip.mp4')?.state === 'nomatch' && row(st, 'holiday clip (copy).mp4')?.state === 'copy');
      check('version note says what Couchbox has', /Couchbox has/.test(row(st, 'Night Train 2019 Directors Cut.mp4')?.note || ''));
      check('30+ s longer cut is a yellow version, ticked', row(st, 'Harbour Lights (2020) Extended.mp4')?.state === 'version' && row(st, 'Harbour Lights (2020) Extended.mp4')?.selected);
      check('same film, same length as library = already in Couchbox', row(st, 'Night.Train.2019.mkv')?.state === 'inLibrary');
      check('same film, 90 s longer than library = yellow version', row(st, 'Night Train 2019 Directors Cut.mp4')?.state === 'version', row(st, 'Night Train 2019 Directors Cut.mp4')?.note);
      check('new episode recognised and ticked', row(st, 'The.Long.Coast.S01E03.Salt.mp4')?.state === 'match' && row(st, 'The.Long.Coast.S01E03.Salt.mp4')?.selected);
      check('exact copy of a library file = already in Couchbox', row(st, 'Pilot copy.mp4')?.state === 'inLibrary');
      const hol = [row(st, 'holiday clip.mp4'), row(st, 'holiday clip (copy).mp4')];
      check('unrecognised video and its exact copy: one listed, one greyed', hol.filter((r) => r?.state === 'nomatch').length === 1 && hol.filter((r) => r?.state === 'copy').length === 1);
      check('unrecognised videos are not pre-ticked', row(st, 'beach day.mp4')?.state === 'nomatch' && !row(st, 'beach day.mp4')?.selected);

      // --- "Use this copy" swaps which copy gets added ---
      const lowId = row(st, 'harbour lights 2020.mp4').id;
      await js(`document.querySelector('[data-f="use-copy"][data-id="${lowId}"]').click()`);
      await wait(800);
      st = await state();
      check('"Use this copy" makes the other copy the one to add', row(st, 'harbour lights 2020.mp4')?.state !== 'copy' && row(st, 'Harbour.Lights.2020.1080p.mkv')?.state === 'copy');
      const hiId = row(st, 'Harbour.Lights.2020.1080p.mkv').id;
      await js(`document.querySelector('[data-f="use-copy"][data-id="${hiId}"]').click()`);
      await wait(800);

      // --- add with Copy (also tick the unrecognised holiday clip to hit the name clash) ---
      st = await state();
      const holId = hol.find((r) => r.state === 'nomatch').id;
      await js(`document.querySelector('[data-sel="${holId}"]').click()`);
      await wait(500);
      await js(`document.getElementById('f-add').click()`);
      await until('pop-up', `!!document.querySelector('#finder-pop [data-p="copy"]')`);
      await snap('32-add-popup');
      await js(`document.querySelector('#finder-pop [data-p="copy"]').click()`);
      await until('copy finished', `!!document.querySelector('#finder-pop [data-p="done"]')`, 120000);
      await snap('33-add-done');
      const sumText = await js(`document.querySelector('#finder-pop').innerText`);
      console.log('Summary:', sumText.replace(/\s+/g, ' '));
      const exists = (p) => fs.existsSync(path.join(lib, p));
      check('new film copied with a tidy name', exists('Films\\Harbour Lights (2020).mkv'));
      check('version copied with its length in the name', fs.readdirSync(path.join(lib, 'Films')).some((n) => /^Harbour Lights \(2020\) - \d+m\.mp4$/.test(n)));
      check('Night Train version copied with its length in the name', fs.readdirSync(path.join(lib, 'Films')).some((n) => /^Night Train \(2019\) - \d+m\.mp4$/.test(n)));
      check('episode copied into Series\\Show\\Season 01', exists('Series\\The Long Coast\\Season 01\\The Long Coast - S01E03.mp4'));
      check('subtitle travelled with the episode', exists('Series\\The Long Coast\\Season 01\\The Long Coast - S01E03.srt'));
      check('name clash skipped, existing file untouched', fs.statSync(path.join(lib, 'Imported', 'holiday clip.mp4')).size === 1259181 && /name is already there/.test(sumText));
      check('originals still in place after Copy', fs.existsSync(path.join(pc, 'Downloads', 'Harbour.Lights.2020.1080p.mkv')));
      check('no half-copied files left', !fs.readdirSync(lib, { recursive: true }).some((n) => String(n).endsWith('.part')));
      await js(`document.querySelector('#finder-pop [data-p="done"]').click()`);
      await wait(600);

      // --- add with Move: only "beach day" ---
      await js(`document.querySelector('[data-f="none"]').click()`);
      await wait(500);
      st = await state();
      await js(`document.querySelector('[data-sel="${row(st, 'beach day.mp4').id}"]').click()`);
      await wait(500);
      await js(`document.getElementById('f-add').click()`);
      await until('pop-up', `!!document.querySelector('#finder-pop [data-p="move"]')`);
      await js(`document.querySelector('#finder-pop [data-p="move"]').click()`);
      await until('move finished', `!!document.querySelector('#finder-pop [data-p="done"]')`, 60000);
      check('Move: file now in Imported\\', exists('Imported\\beach day.mp4'));
      check('Move: original removed', !fs.existsSync(path.join(pc, 'Downloads', 'beach day.mp4')));
      await js(`document.querySelector('#finder-pop [data-p="done"]').click()`);

      // --- searching again: what was added now counts as already in Couchbox ---
      await until('library rescan', `document.getElementById('statuspill').hidden`, 90000);
      await wait(3000);
      await until('library rescan', `document.getElementById('statuspill').hidden`, 90000);
      await js(`document.querySelector('[data-f="search"]').click()`);
      await wait(500);
      await until('search done', `cb.finderState().then(s => s.status.phase === 'done')`, 120000);
      st = await state();
      check('second search: added film is already in Couchbox', row(st, 'Harbour.Lights.2020.1080p.mkv')?.state === 'inLibrary', row(st, 'Harbour.Lights.2020.1080p.mkv')?.state);
      check('second search: added episode is already in Couchbox', row(st, 'The.Long.Coast.S01E03.Salt.mp4')?.state === 'inLibrary', row(st, 'The.Long.Coast.S01E03.Salt.mp4')?.state);
      check('second search: nothing pre-ticked that was already added', !st.results.some((r) => r.selected && /Harbour|Salt|Night/.test(r.name)));
      await snap('34-find-again');

      // --- Stop during a copy removes the half-copied file ---
      const { Finder } = require('../src/main/finder');
      const f = new Finder({ getLibrary: () => null, send: () => {}, getExcluded: () => [] });
      const big = path.join(pc, 'Videos', 'Night.Train.2019.mkv');
      const dest = path.join(T, 'stop-test.mkv');
      const job = { stop: false, current: null };
      let stoppedOk = false;
      await f.transfer(big, dest, 'copy', job, (b) => { if (b > 3e6 && job.current) { job.stop = true; job.current.destroy(new Error('stopped')); } }).catch(() => (stoppedOk = true));
      check('Stop mid-copy: no file and no .part left', stoppedOk && !fs.existsSync(dest) && !fs.existsSync(dest + '.part'));

      // --- home screen Imported row, and kids profiles don't get the tab ---
      await js(`closeModal()`);
      await wait(800);
      check('home screen has an Imported row', await js(`!!document.querySelector('[data-row="imported"]')`));
      await js(`document.querySelector('[data-row="imported"]').scrollIntoView()`);
      await snap('35-home-imported');
      await js(`S.profile = null; render()`);
      await wait(300);
      await js(`document.querySelector('[data-pid="p3"]').click()`);
      await wait(800);
      await js(`openSettings()`);
      check('kids profile: no Find videos tab', !(await js(`!!document.querySelector('.stabs [data-tab="find"]')`)));
      await js(`closeModal()`);
    } catch (e) {
      console.error('TEST FAILED', e.message);
      results.push({ name: e.message, ok: false });
    }
    const failed = results.filter((r) => !r.ok).length;
    console.log(`\n${results.length - failed} passed, ${failed} failed`);
    console.log('console errors/warnings:', errors.length ? '\n' + errors.join('\n') : 'none');
    app.exit(0);
  });
});

require('../main.js');
