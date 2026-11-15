// Automatic conversion: makes a small library of test videos with FFmpeg (some play as they are,
// some need the audio converted ("fast"), one needs the video converted ("slow"), one is broken),
// runs the real app, and checks the queue order, the 5 fast + 1 slow limit, Queue next, the safe
// swap and the bin, progress moving to a renamed file, the space warning in all four places,
// kids, Restore, Empty now, the 7-day rule and clearing the old converted copies.
// Saves screenshots of the cards, the episode list, Settings and the warning.
// Usage: npx electron test/conversion-check.js   (screenshots go to COUCHBOX_SNAP_OUT, or a temp folder)
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');
const { app } = require('electron');
const { TEST_SETTINGS } = require('./quiet');
const ffmpeg = require('ffmpeg-static');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'couchbox-conv-'));
const lib = path.join(tmp, 'Videos');
const dataDir = path.join(tmp, 'data');
const out = process.env.COUCHBOX_SNAP_OUT || path.join(tmp, 'snaps');
const freeFile = path.join(tmp, 'free.txt');
for (const d of [lib, dataDir, out]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(freeFile, String(500 * 1024 ** 3));
process.env.COUCHBOX_DATA_DIR = dataDir;
process.env.COUCHBOX_FAKE_FREE_FILE = freeFile;
process.env.COUCHBOX_CONV_RATE = '0.5'; // each 8-second video takes about 16 seconds to convert
process.env.COUCHBOX_SPACE_RECHECK_MS = '1500';

// kind: 'fast' = H.264 + E-AC3 5.1 in MKV (the audio needs converting); 'slow' = MPEG-4 Part 2 +
// MP3 in AVI (the video needs converting, and it becomes .mp4); 'ok' = H.264 + AAC in MP4.
function make(rel, kind, secs = 8) {
  const file = path.join(lib, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const src = ['-f', 'lavfi', '-i', `testsrc2=size=640x360:rate=25:duration=${secs}`, '-f', 'lavfi', '-i', `sine=frequency=330:duration=${secs}`];
  const enc = {
    fast: ['-filter_complex', '[1:a]pan=5.1|c0=c0|c1=c0|c2=c0|c3=c0|c4=c0|c5=c0[a]', '-map', '0:v', '-map', '[a]', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'eac3'],
    slow: ['-map', '0:v', '-map', '1:a', '-c:v', 'mpeg4', '-q:v', '5', '-c:a', 'libmp3lame'],
    ok: ['-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac'],
  }[kind];
  const r = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...src, ...enc, file]);
  if (r.status !== 0) throw new Error('making ' + rel + ': ' + r.stderr);
  // Files are queued in the order they were added: space them out.
  const t = new Date(Date.now() - 1e9 + made++ * 60000);
  fs.utimesSync(file, t, t);
  return file;
}
let made = 0;

const FAST = 'Films/Fast One (2001).mkv';
const BROKEN = 'Films/Broken (2002).mkv';
const SLOW = 'Films/Slow One (2003).avi';
const EPS = [1, 2, 3, 4, 5, 6].map((n) => `Series/Harbour Lights/Season 01/Harbour Lights - S01E0${n}.mkv`);
const LATE = 'Films/Late Arrival (2005).mkv';
const OK = 'Films/Plays Fine (2000).mp4';
make(OK, 'ok');
make(FAST, 'fast');
make(BROKEN, 'fast');
make(SLOW, 'slow');
EPS.forEach((e) => make(e, 'fast'));
make(LATE, 'fast');
// "Broken": a whole file whose conversion check is made to fail (a test switch), so the original
// must stay untouched and it shows "Couldn't convert".
process.env.COUCHBOX_TEST_FAIL_VERIFY = 'Broken (2002)';
const bf = path.join(lib, BROKEN);
const brokenSize = fs.statSync(bf).size;
// "Cut Off": half a file, as from a cancelled download. It's marked Incomplete and never converted.
const CUT = 'Films/Cut Off (2009).mkv';
make(CUT, 'fast');
fs.truncateSync(path.join(lib, CUT), Math.floor(fs.statSync(path.join(lib, CUT)).size * 0.45));
const cutTime = new Date(Date.now() - 3 * 3600e3); // stopped hours ago (cutting it updated the time)
fs.utimesSync(path.join(lib, CUT), cutTime, cutTime);
let slowAdded = 0;
// Set the "added" times again, newest last (birth times are all "now", so mtime decides).
[OK, FAST, BROKEN, SLOW, ...EPS, LATE].forEach((rel, i) => {
  const t = new Date(Date.now() - 2 * 3600e3 + i * 60000); // in the past: not "still downloading"
  fs.utimesSync(path.join(lib, rel), t, t);
  if (rel === SLOW) {
    const st = fs.statSync(path.join(lib, rel));
    slowAdded = Math.max(st.birthtimeMs, st.mtimeMs); // how the scanner works out "added"
  }
});
// Downloaded videos are often read-only: the bin must still be able to delete them.
fs.chmodSync(path.join(lib, FAST), 0o444);

// Seeded: a binned original from 8 days ago (the 7-day rule), and an old-style converted copy.
const oldBin = path.join(lib, '.couchbox-bin', 'Films', 'Long Gone (1999).mkv');
fs.mkdirSync(path.dirname(oldBin), { recursive: true });
fs.writeFileSync(oldBin, 'old original');
fs.writeFileSync(path.join(dataDir, 'conversions.json'), JSON.stringify({
  paused: true, // until every new file has been checked, so the queue order can be read in full
  bin: [{ orig: path.join(lib, 'Films', 'Long Gone (1999).mkv'), binPath: oldBin, newPath: path.join(lib, 'Films', 'Long Gone (1999).mkv'), oldId: 'film:films\\long gone (1999).mkv', newId: 'film:films\\long gone (1999).mkv', label: 'Long Gone (1999)', size: 12, binnedAt: Date.now() - 8 * 864e5 }],
}));
fs.mkdirSync(path.join(dataDir, 'converted'), { recursive: true });
fs.writeFileSync(path.join(dataDir, 'converted', 'abc123.mp4'), 'old copy');

const slowId = 'film:' + SLOW.replace(/\//g, '\\').toLowerCase();
const slowNewId = slowId.replace(/\.avi$/, '.mp4');
const fastId = 'film:' + FAST.replace(/\//g, '\\').toLowerCase();
const lateId = 'film:' + LATE.replace(/\//g, '\\').toLowerCase();
const epId = (n) => 'ep:' + EPS[n - 1].replace(/\//g, '\\').toLowerCase();
fs.writeFileSync(path.join(dataDir, 'couchbox-data.json'), JSON.stringify({
  settings: { libraryPath: lib, previews: false, ...TEST_SETTINGS, autoConvert: true },
  profiles: [{ id: 'p1', name: 'Sam', color: '#2E9E6B', kids: false }, { id: 'p3', name: 'Kids', color: '#D9A21B', kids: true }],
  progress: { p1: { [slowId]: { t: 3, d: 8, u: Date.now() } } },
  lists: { p1: [slowId] },
  kidsAllow: { [slowId]: true, [fastId]: true },
}));

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
    const snap = async (name) => {
      await wait(400);
      fs.writeFileSync(path.join(out, name + '.png'), (await win.webContents.capturePage()).toPNG());
      console.log('snap', path.join(out, name + '.png'));
    };
    const conv = () => js('S.conv');
    const until = async (label, fn, ms = 60000) => {
      for (let t = 0; t < ms; t += 300) {
        if (await fn()) return true;
        await wait(300);
      }
      console.log('timed out waiting for ' + label);
      return false;
    };
    try {
      win.setSize(1400, 900);
      for (let i = 0; i < 100 && !win.isVisible(); i++) await wait(100);
      check('old converted copies were deleted at start-up', !fs.existsSync(path.join(dataDir, 'converted')));
      check('a binned original older than 7 days was deleted at start-up', !fs.existsSync(oldBin));
      await js(`document.querySelector('[data-pid="p1"]').click()`);
      // New files are checked (are they finished downloading?) before they're queued: wait for all
      // ten (and the cut-off one to be found Incomplete), then read the order and start.
      await until('the queue', async () => (await conv()).queue.length >= 10 && (await js(`(S.dl.files['film:films\\\\cut off (2009).mkv'] || {}).s`)) === 'incomplete', 60000);
      const firstOrder = (await conv()).queue.map((r) => r.label);
      await js('cb.convPause(false)');
      await until('converting', async () => (await conv()).converting > 0, 10000);

      // The queue: in the order added, a series from its first episode; at most 5 fast + 1 slow.
      let peak = { fast: 0, slow: 0 };
      const sample = async () => {
        const c = await conv();
        for (const lane of ['fast', 'slow']) peak[lane] = Math.max(peak[lane], c.queue.filter((r) => r.lane === lane && r.s === 'converting').length);
        return c;
      };
      let c = await sample();
      const order = firstOrder;
      check('queue order: as added, episodes in order', JSON.stringify(order) === JSON.stringify(['Fast One (2001)', 'Broken (2002)', 'Slow One (2003)', 'Harbour Lights S1:E1', 'Harbour Lights S1:E2', 'Harbour Lights S1:E3', 'Harbour Lights S1:E4', 'Harbour Lights S1:E5', 'Harbour Lights S1:E6', 'Late Arrival (2005)']), order.join(' | '));
      check('the file that plays as it is is not queued', !c.files['film:films\\plays fine (2000).mp4']);
      const cutState = await js(`(S.dl.files['film:films\\\\cut off (2009).mkv'] || {}).s`);
      check('a cut-off file is Incomplete, not queued', cutState === 'incomplete' && !c.files['film:films\\cut off (2009).mkv'], JSON.stringify({ cutState, conv: c.files['film:films\\cut off (2009).mkv'] }));
      check('fast and slow sorted right', c.files[fastId].lane === 'fast' && c.files[slowId].lane === 'slow');

      // Screens while converting: the home row, the series' episode list, Settings.
      await wait(2500);
      await sample();
      await js(`S.tab = 'films'; renderContent(true)`);
      await snap('70-cards-converting');
      const cardSel = (id, rest) => `document.querySelector('.card[data-id="' + CSS.escape(${JSON.stringify(id)}) + '"] ${rest}')`;
      check('a converting film card is grey with the line', await js(`!!${cardSel(fastId, '.convov:not(.wait) .cv-line')}`));
      check('a waiting film card is grey with "Waiting"', await js(`(() => { const o = ${cardSel(lateId, '.convov.wait')}; return !!o && /Waiting/.test(o.textContent); })()`));
      await js(`S.tab = 'series'; renderContent(true)`);
      await wait(300);
      check('the series card stays as it is', await js(`!document.querySelector('.card[data-id="series:harbour lights"] .convov')`));
      await js(`openDetails('series:harbour lights')`);
      await wait(500);
      await snap('71-episodes-converting');
      const tags = await js(`[...document.querySelectorAll('.ep .ep-conv')].map(t => t.textContent)`);
      check('episodes show Converting and Waiting', tags.slice(0, 3).every((t) => /^Converting \d+%$/.test(t)) && tags.slice(3).every((t) => /^(Converting \d+%|Waiting to convert)$/.test(t)) && tags.includes('Waiting to convert'), JSON.stringify(tags));
      // Queue next from the details page: the series' waiting episodes go first.
      await js(`document.querySelector('.details [data-act="conv-next"]').click()`);
      await wait(600);
      c = await sample();
      const waitingNow = c.queue.filter((r) => r.s === 'waiting').map((r) => r.label);
      check('Queue next on the series page: its episodes go first', /^Harbour Lights/.test(waitingNow[0]) && waitingNow.indexOf('Late Arrival (2005)') > waitingNow.indexOf('Harbour Lights S1:E6'), waitingNow.join(' | '));
      await js(`closeModal()`);

      // The player on a waiting film: "Waiting to convert" with Queue next.
      await js(`playFile(${JSON.stringify(lateId)})`);
      await wait(700);
      check('player: a waiting film shows "Waiting to convert"', /Waiting to convert/.test(await js(`document.querySelector('.p-overlay').innerText`)));
      await snap('72-player-waiting');
      await js(`document.querySelector('.p-overlay [data-p="conv-next"]').click()`);
      await wait(600);
      c = await sample();
      check('Queue next in the player puts it first', c.queue.filter((r) => r.s === 'waiting')[0]?.label === 'Late Arrival (2005)', c.queue.filter((r) => r.s === 'waiting').map((r) => r.label).join(' | '));
      await js(`Player.close()`);

      await js(`openSettings(null, 'playback')`);
      await wait(500);
      await snap('73-settings-conversions');
      check('Settings: the queue list with Fast and Slow tags', await js(`document.querySelectorAll('#conv-section .conv-row .cr-tag').length >= 5`));
      await wait(1500);
      check('the queue keeps up with progress (not stuck at 0%)', (await conv()).queue.some((r) => r.s === 'converting' && r.p > 0.05));

      // Wait for everything to finish, watching the limits.
      await until('all done', async () => {
        const x = await sample();
        return x.converting === 0 && x.waiting === 0 && !x.queue.some((r) => r.s === 'finishing');
      }, 90000);
      check('never more than 5 fast at once', peak.fast === 5, JSON.stringify(peak));
      check('never more than 1 slow at once', peak.slow === 1, JSON.stringify(peak));
      await js(`closeModal()`);
      await wait(1500);
      c = await conv();

      // Results.
      const fastFile = path.join(lib, FAST);
      const probe = (f) => (spawnSync(ffmpeg, ['-hide_banner', '-i', f]).stderr || '').toString();
      check('fast: same name, audio now AAC 5.1, video untouched', /Audio: aac.*(5\.1|6 channels)/.test(probe(fastFile)) && /Video: h264/.test(probe(fastFile)));
      check('fast: the original is in the hidden bin', fs.existsSync(path.join(lib, '.couchbox-bin', FAST)));
      const slowNew = path.join(lib, SLOW.replace(/\.avi$/, '.mp4'));
      check('slow: now an MP4 with H.264 and AAC', fs.existsSync(slowNew) && /Video: h264/.test(probe(slowNew)) && /Audio: (aac|mp3)/.test(probe(slowNew)), probe(slowNew).match(/Stream.*$/gm)?.join(' / '));
      check('slow: the .avi is gone from the folder (in the bin)', !fs.existsSync(path.join(lib, SLOW)) && fs.existsSync(path.join(lib, '.couchbox-bin', SLOW)));
      const p1 = await js(`cb.getProgress('p1')`);
      check('slow: progress moved to the new name', !!p1[slowNewId] && !p1[slowId], Object.keys(p1).join(', '));
      check('slow: My list moved to the new name', (await js(`cb.getList('p1')`)).includes(slowNewId));
      check('slow: shows on kids profiles still', (await js('S.kidsAllow'))[slowNewId] === true);
      check('broken: original untouched', fs.existsSync(bf) && fs.statSync(bf).size === brokenSize);
      check('broken: listed as "Couldn\'t convert" with a reason', c.failed.some((r) => r.label === 'Broken (2002)' && r.reason), JSON.stringify(c.failed));
      check('cut off: still Incomplete and untouched', (await js(`(S.dl.files['film:films\\\\cut off (2009).mkv'] || {}).s`)) === 'incomplete' && !fs.existsSync(path.join(lib, '.couchbox-bin', CUT)));
      check('no ".converting" files left behind', !fs.readdirSync(path.join(lib, 'Films')).some((n) => /\.converting\./.test(n)));
      const film = await js(`byId(${JSON.stringify(slowNewId)})`);
      check('the new file is playable and keeps the original\'s "added" time', film && film.playable && Math.abs(film.added - slowAdded) < 2, film && `${film.added} vs ${slowAdded}`);
      check('every episode plays now', await js(`allEpisodes(byId('series:harbour lights')).every(e => e.playable)`));

      // The new file really plays in the app.
      await js(`playFile(${JSON.stringify(fastId)})`);
      await until('playing', () => js(`(() => { const v = document.querySelector('#player video.main'); return v && v.currentTime > 1; })()`), 15000);
      check('the converted file plays (with sound)', await js(`(() => { const v = document.querySelector('#player video.main'); return v.currentTime > 1 && !v.error && v.webkitAudioDecodedByteCount > 0; })()`));
      await js(`Player.close()`);
      await wait(400);

      // The bin: watched to 90% deletes the original.
      await js(`cb.setProgress('p1', ${JSON.stringify(fastId)}, 7.5, 8)`);
      await wait(800);
      check('watched to 90%: the original is deleted (it was read-only)', !fs.existsSync(path.join(lib, '.couchbox-bin', FAST)));
      // Restore and skip / Restore and retry.
      c = await conv();
      const e1 = c.bin.find((b) => b.label === 'Harbour Lights S1:E1');
      const e2 = c.bin.find((b) => b.label === 'Harbour Lights S1:E2');
      check('Restore and skip: the original is back', !(await js(`cb.convRestore(${JSON.stringify(e1.key)}, 'skip')`)) && /eac3/.test(probe(path.join(lib, EPS[0]))));
      await wait(1200);
      c = await conv();
      check('Restore and skip: listed under Skipped, not queued', c.skipped.some((r) => r.label === 'Harbour Lights S1:E1') && !c.queue.some((r) => r.label === 'Harbour Lights S1:E1'));
      check('Restore and retry: queued again', !(await js(`cb.convRestore(${JSON.stringify(e2.key)}, 'retry')`)));
      await until('E2 again', async () => (await conv()).queue.some((r) => r.label === 'Harbour Lights S1:E2'), 8000);
      check('Restore and retry: E2 is in the queue again', (await conv()).queue.some((r) => r.label === 'Harbour Lights S1:E2'));
      await until('E2 done', async () => !(await conv()).queue.length, 30000);

      // Disk space: too little for the next file stops everything upcoming and warns.
      fs.writeFileSync(freeFile, String(1000));
      make('Films/Space Test (2006).mkv', 'fast');
      await until('the space warning', () => js('S.warnings.length > 0'), 20000);
      // The warning and the queue arrive separately: wait for the queue to show it too.
      await until('the queue shows the stop', async () => !!(await conv()).blocked, 5000);
      c = await conv();
      check('not enough space: nothing starts', c.converting === 0 && c.waiting === 1 && !!c.blocked, JSON.stringify({ converting: c.converting, waiting: c.waiting, blocked: c.blocked, queue: c.queue.map((r) => r.label + ':' + r.s) }));
      check('the message gives sizes in MB for small files', /needs \d+ MB free/.test((await js('S.warnings[0].text'))), await js('S.warnings[0].text'));
      await js(`openSettings(null, 'playback')`);
      await wait(500);
      check('warning: "!" on the menu button', await js(`!!document.querySelector('.profile-menu-btn .warn-dot')`));
      check('warning: "!" on the Playback tab', await js(`!!document.querySelector('.stabs [data-tab="playback"] .warn-dot')`));
      check('warning: "!" and the message on Conversions', await js(`!!document.querySelector('#conv-section h3 .warn-dot') && /Not enough space for Space Test \\(2006\\)/.test(document.querySelector('#conv-section .warnbox').innerText)`));
      check('warning: has "Empty the bin"', await js(`!!document.querySelector('#conv-section .warnbox [data-act="conv-empty-bin"]')`));
      await snap('74-space-warning');
      await js(`closeModal(); document.querySelector('[data-act="profile-menu"]').click()`);
      await wait(300);
      check('warning: "!" on Settings in the menu', await js(`!!document.querySelector('#pmenu [data-act="settings"] .warn-dot')`));
      await snap('75-menu-warning');
      await js(`document.querySelector('#pmenu')?.remove()`);
      // Kids see the warning, and only "ask a grown-up".
      await js(`pickProfile('p3')`);
      await wait(1000);
      await js(`openSettings()`);
      await wait(400);
      check('kids: the warning shows', await js(`!!document.querySelector('.stabs [data-tab="playback"] .warn-dot') && /Ask a grown-up/.test(document.querySelector('#conv-section').innerText)`));
      check('kids: no queue, bin or switch', await js(`!document.querySelector('#set-autoconvert') && !document.querySelector('[data-act="conv-empty-bin"]') && !document.querySelector('.conv-row')`));
      await snap('76-kids-warning');
      await js(`closeModal(); pickProfile('p1')`);
      await wait(1000);
      // Room again: it starts by itself and the warning clears.
      fs.writeFileSync(freeFile, String(500 * 1024 ** 3));
      await until('space again', async () => !(await js('S.warnings.length')) && (await conv()).converting === 1, 15000);
      check('space again: the warning clears and it starts', !(await js('S.warnings.length')));
      await until('space test done', async () => !(await conv()).queue.length, 30000);

      // Empty now.
      c = await conv();
      const binned = c.bin.length;
      await js(`cb.convEmptyBin()`);
      await wait(600);
      c = await conv();
      check('Empty now: the bin is empty', binned > 0 && c.bin.length === 0 && !fs.existsSync(path.join(lib, '.couchbox-bin')), `${binned} before`);

      // Pause all stops what's running (no half-made files left); Resume starts it again.
      make('Films/Pause Test (2007).mkv', 'fast');
      await until('pause test converting', async () => (await conv()).converting === 1, 20000);
      await wait(1000);
      await js(`cb.convPause(true)`);
      await wait(1200);
      c = await conv();
      check('Pause all: nothing converting, no half-made file', c.paused && c.converting === 0 && !fs.readdirSync(path.join(lib, 'Films')).some((n) => /\.converting\./.test(n)));
      await js(`cb.convPause(false)`);
      await until('resumed', async () => (await conv()).converting === 1, 10000);
      check('Resume: it starts again', !(await conv()).paused && (await conv()).converting === 1);
      await until('pause test done', async () => !(await conv()).queue.length, 40000);

      // Turning conversions off: nothing is queued or started.
      await js(`openSettings(null, 'playback')`);
      await wait(300);
      await js(`document.querySelector('#set-autoconvert').click()`);
      await wait(600);
      c = await conv();
      check('the switch turns conversions off', !c.enabled && /Conversions are off/.test(await js(`document.querySelector('#conv-section').innerText`)));
      // Switched off, a file that needs converting isn't shown as waiting.
      make('Films/Switched Off (2008).mkv', 'fast');
      await until('switched-off file scanned', () => js(`!!S.model.films.find(f => f.title === 'Switched Off')`), 20000);
      await wait(800);
      c = await conv();
      const offId = await js(`S.model.films.find(f => f.title === 'Switched Off').id`);
      check('switched off: nothing waiting or grey', !c.files[offId] && c.queue.length === 0);
      await js(`closeModal(); playFile(${JSON.stringify(offId)})`);
      await wait(700);
      check('switched off: the player says it needs converting', /needs converting/.test(await js(`document.querySelector('.p-overlay').innerText`)) && !(await js(`!!document.querySelector('.p-overlay [data-p="conv-next"]')`)));
      await js(`Player.close(); openSettings(null, 'playback')`);
      await wait(300);
      await js(`document.querySelector('#set-autoconvert').click(); closeModal()`);
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
