// Copies and versions put in the folder by hand: spare copies show as one card (the best copy,
// under the id of the one there first, with shared progress), only the best is converted, an
// exact copy under another name counts, Move to bin / Keep both / Restore, the spare taking over
// when the shown copy goes, the warning in all four places, and different versions with the
// comparison and its three choices.
// Usage: npx electron test/copies-check.js   (screenshots go to COUCHBOX_SNAP_OUT, or a temp folder)
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');
const { app } = require('electron');
const { TEST_SETTINGS } = require('./quiet');
const ffmpeg = require('ffmpeg-static');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'couchbox-cp-'));
const lib = path.join(tmp, 'Videos');
const out = process.env.COUCHBOX_SNAP_OUT || path.join(tmp, 'snaps');
fs.mkdirSync(out, { recursive: true });
process.env.COUCHBOX_DATA_DIR = path.join(tmp, 'data');
fs.mkdirSync(process.env.COUCHBOX_DATA_DIR, { recursive: true });

let n = 0;
function video(rel, { secs = 10, size = '320x180', audio = 'aac' } = {}) {
  const f = path.join(lib, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const r = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=25:duration=${secs}`, '-f', 'lavfi', '-i', `sine=duration=${secs}`,
    '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', audio, f]);
  if (r.status !== 0) throw new Error(String(r.stderr));
  stamp(f);
  return f;
}
// Added in this order (older first).
function stamp(f) {
  const t = new Date(Date.now() - 10 * 3600e3 + n++ * 60000);
  fs.utimesSync(f, t, t);
}
// Spare copies: the second is better (higher resolution). Both need converting (E-AC3 sound).
video('Films/Night Train (2019).mkv', { audio: 'eac3' });
video('Films/Night Train (2019) copy.mkv', { size: '640x360', audio: 'eac3' });
// An exact copy under another name.
const fern = video('Films/Fernhill (2018).mkv');
fs.mkdirSync(path.join(lib, 'Imported'), { recursive: true });
fs.copyFileSync(fern, path.join(lib, 'Imported', 'holiday backup.mkv'));
stamp(path.join(lib, 'Imported', 'holiday backup.mkv'));
// A spare episode.
video('Series/Tide Line/Season 01/Tide Line - S01E01.mkv');
video('Series/Tide Line/Season 01/Tide Line - S01E01 copy.mkv');
// Different versions (more than 30 seconds apart): one for each choice.
video('Films/Paper Moons (2021).mkv', { secs: 10 });
video('Films/Paper Moons Extended (2021).mkv', { secs: 50 });
video('Films/Low Tide (2012).mkv', { secs: 10 });
video('Films/Low Tide Directors Cut (2012).mkv', { secs: 50 });
video('Films/Glass Coast (2010).mkv', { secs: 10 });
video('Films/Glass Coast Extended (2010).mkv', { secs: 50 });

const ntCard = 'film:films\\night train (2019).mkv';
const pmCard = 'film:films\\paper moons (2021).mkv';
fs.writeFileSync(path.join(process.env.COUCHBOX_DATA_DIR, 'couchbox-data.json'), JSON.stringify({
  settings: { libraryPath: lib, previews: false, ...TEST_SETTINGS },
  profiles: [{ id: 'p1', name: 'Sam', color: '#2E9E6B', kids: false }],
  progress: { p1: { [ntCard]: { t: 4, d: 10, u: Date.now() }, [pmCard]: { t: 5, d: 10, u: Date.now() } } },
  lists: { p1: [pmCard] },
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
    const titles = (t) => js(`S.model.films.filter(f => f.title === ${JSON.stringify(t)}).map(f => f.id)`);
    try {
      win.setSize(1400, 900);
      for (let i = 0; i < 100 && !win.isVisible(); i++) await wait(100);
      await js(`document.querySelector('[data-pid="p1"]').click()`);
      await until(`!!S.copies && S.copies.spares.length >= 3 && S.copies.versions.length >= 3`, 60000);

      // Spare copies: one card, the best copy, the first one's id, shared progress.
      const nt = await titles('Night Train');
      check('spare copies show as one card, under the id of the one there first', nt.length === 1 && nt[0] === ntCard, JSON.stringify(nt));
      check('...playing the best copy (higher resolution)', /copy\.mkv$/.test(decodeURIComponent(await js(`byId(${JSON.stringify(ntCard)}).video`))));
      check('...with the progress it had', (await js(`S.progress[${JSON.stringify(ntCard)}]`))?.t === 4);
      const jobs = global.__couchbox.converter.jobs().map((j) => path.basename(j.f.file));
      check('only the best copy is converted', jobs.includes('Night Train (2019) copy.mkv') && !jobs.includes('Night Train (2019).mkv'), jobs.join(', '));
      check('an exact copy under another name counts as a spare', (await js(`S.copies.spares.some(s => s.fileName === 'holiday backup.mkv' || s.fileName === 'Fernhill (2018).mkv')`)) && (await titles('Fernhill')).length + (await js(`S.model.films.filter(f => f.title === 'holiday backup').length`)) === 1);
      check('a spare episode: one row', await js(`allEpisodes(byId('series:tide line')).length === 1`));

      // The warning, in all four places.
      check('warning: "!" on the menu button', await js(`!!document.querySelector('.profile-menu-btn .warn-dot')`));
      await js(`openSettings(null, 'library')`);
      await wait(500);
      check('warning: "!" on the Library tab', await js(`!!document.querySelector('.stabs [data-tab="library"] .warn-dot')`));
      check('warning: the Copies and versions section, with the message', await js(`!!document.querySelector('#copies-section h3 .warn-dot') && /spare cop/.test(document.querySelector('#copies-section .warnbox').innerText)`));
      check('each spare lists file name, folder, resolution, size and length', await js(`/Night Train \\(2019\\)\\.mkv[\\s\\S]*Films · 320×180 · \\d+ MB · \\d+m/.test(document.querySelector('#copies-section').innerText)`));
      await snap('110-copies-settings');
      await js(`closeModal(); document.querySelector('[data-act="profile-menu"]').click()`);
      await wait(300);
      check('warning: "!" on Settings in the menu', await js(`!!document.querySelector('#pmenu [data-act="settings"] .warn-dot')`));
      await js(`document.querySelector('#pmenu')?.remove()`);

      // Move to bin, then Restore.
      const spareNt = await js(`S.copies.spares.find(s => s.fileName === 'Night Train (2019).mkv').path`);
      check('Move to bin', !(await js(`cb.copiesBin(${JSON.stringify(spareNt)})`)) && !exists('Films/Night Train (2019).mkv'));
      await until(`!S.copies.spares.some(s => s.fileName === 'Night Train (2019).mkv')`, 15000);
      await until(`S.conv.bin.some(b => b.kind === 'copy')`, 5000);
      const binKey = await js(`(S.conv.bin.find(b => b.kind === 'copy') || {}).key`);
      const after = { binKey, cards: await titles('Night Train'), progress: await js(`S.progress[${JSON.stringify(ntCard)}]`) };
      check('...it\'s in the bin (7 days), the card stays with its progress', !!binKey && after.cards.length === 1 && after.cards[0] === ntCard && after.progress?.t === 4, JSON.stringify(after));
      check('Restore puts it back', !(await js(`cb.convRestore(${JSON.stringify(binKey)}, 'copy')`)) && exists('Films/Night Train (2019).mkv'));
      await until(`S.copies.spares.some(s => s.fileName === 'Night Train (2019).mkv')`, 15000);
      // Keep both.
      const ntKey = await js(`S.copies.spares.find(s => s.fileName === 'Night Train (2019).mkv').key`);
      await js(`cb.copiesKeep(${JSON.stringify(ntKey)})`);
      await js('cb.refresh()');
      await wait(3000);
      check('Keep both: not flagged again, still one card', !(await js(`S.copies.spares.some(s => s.key === ${JSON.stringify(ntKey)})`)) && (await titles('Night Train')).length === 1);
      // The shown copy goes: the spare takes over, same card, same progress.
      fs.rmSync(path.join(lib, 'Films', 'Night Train (2019) copy.mkv'));
      await js('cb.refresh()');
      await until(`/Night Train \\(2019\\)\\.mkv$/.test(decodeURIComponent((byId(${JSON.stringify(ntCard)}) || {}).video || ''))`, 15000);
      check('the shown copy deleted: the other takes over, same card and progress', (await titles('Night Train')).length === 1 && (await js(`S.progress[${JSON.stringify(ntCard)}]`))?.t === 4);

      // Different versions: both cards; the new one marked.
      const pm = await titles('Paper Moons');
      check('different versions: two cards', pm.length === 2, JSON.stringify(pm));
      await js(`S.tab = 'films'; renderContent(true)`);
      await wait(500);
      const newPm = pm.find((id) => id !== pmCard);
      check('the new one carries a yellow "!"', await js(`!!document.querySelector('.card[data-id="' + CSS.escape(${JSON.stringify(newPm)}) + '"] .ver-dot') && !document.querySelector('.card[data-id="' + CSS.escape(${JSON.stringify(pmCard)}) + '"] .ver-dot')`));
      await snap('111-version-card');
      await js(`document.querySelector('.card[data-id="' + CSS.escape(${JSON.stringify(newPm)}) + '"] .ver-dot').click()`);
      await wait(600);
      check('the "!" opens the comparison (file, folder, length with difference, picture, size, added)', await js(`(() => { const t = document.querySelector('.cmp').innerText; return /The one you have/i.test(t) && /The new one/i.test(t) && /\\+1 min/.test(t) && /320×180/.test(t) && /Added/i.test(t); })()`));
      await snap('112-version-compare');
      // Replace: the new one takes the card; the old goes to the bin; My list stays; resume cleared.
      await js(`document.querySelector('.cmp [data-choice="replace"]').click()`);
      await until(`S.model.films.filter(f => f.title === 'Paper Moons').length === 1`, 15000);
      check('Replace: one card, playing the new one', /Extended/.test(decodeURIComponent(await js(`byId(${JSON.stringify(pmCard)}).video`))) && !exists('Films/Paper Moons (2021).mkv'));
      check('...My list carried over, resume point cleared', (await js(`S.list`)).includes(pmCard) && !(await js(`S.progress[${JSON.stringify(pmCard)}]`)));
      // Keep the one I have.
      const lt = await js(`S.copies.versions.find(v => v.label.startsWith('Low Tide')).key`);
      await js(`cb.copiesDecide(${JSON.stringify(lt)}, 'keepMine')`);
      await until(`S.model.films.filter(f => f.title === 'Low Tide').length === 1`, 15000);
      check('Keep the one I have: the new one goes to the bin', !exists('Films/Low Tide Directors Cut (2012).mkv') && exists('Films/Low Tide (2012).mkv'));
      // Keep both as separate versions: labelled with their lengths.
      const gc = await js(`S.copies.versions.find(v => v.label.startsWith('Glass Coast')).key`);
      await js(`cb.copiesDecide(${JSON.stringify(gc)}, 'both')`);
      await until(`Object.keys(S.copies.labels).length >= 2`, 15000);
      check('Keep both: two cards labelled with their lengths, no more "!"', (await titles('Glass Coast')).length === 2 && (await js(`Object.values(S.copies.labels).sort().join(',')`)) === '0m,1m' && !(await js(`S.copies.versions.length`)));
      await js(`renderContent(true)`);
      await wait(400);
      await snap('113-versions-labelled');
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
