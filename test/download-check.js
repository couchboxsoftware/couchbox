// Downloads: fakes the ways a video arrives while Couchbox is open, and checks it shows them as
// Downloading (purple, with a % where it can tell) or Incomplete, never converts them early,
// and treats them normally once they're finished.
//   - a file growing from the start (like a browser download), with a %
//   - a ".crdownload" file that grows, then gets its real name
//   - a full-size file filled in out of order (like a torrent)
//   - a half-finished download that stopped (Incomplete)
//   - a full-size file with a missing middle that stopped (Incomplete)
//   - a finished file that starts changing while it's being converted (the conversion stops)
//   - an episode downloading inside a series
// Usage: npx electron test/download-check.js   (screenshots go to COUCHBOX_SNAP_OUT, or a temp folder)
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');
const { app } = require('electron');
const { TEST_SETTINGS } = require('./quiet');
const ffmpeg = require('ffmpeg-static');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'couchbox-dl-'));
const lib = path.join(tmp, 'Videos');
const src = path.join(tmp, 'src');
const dataDir = path.join(tmp, 'data');
const out = process.env.COUCHBOX_SNAP_OUT || path.join(tmp, 'snaps');
for (const d of [lib, src, dataDir, out, path.join(lib, 'Films'), path.join(lib, 'Series', 'Tide Line', 'Season 01')]) fs.mkdirSync(d, { recursive: true });
process.env.COUCHBOX_DATA_DIR = dataDir;
process.env.COUCHBOX_DL_STABLE_MS = '3000';
process.env.COUCHBOX_DL_POLL_MS = '600';
process.env.COUCHBOX_CONV_RATE = '0.3';

// Source videos: H.264 + E-AC3 in MKV (so they need a fast conversion once finished).
// Each title gets its own video: byte-identical files count as copies of each other (copies.js).
function make(name, secs = 20, freq = 300) {
  const file = path.join(src, name);
  const r = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=size=640x360:rate=25:duration=${secs}`, '-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=${secs}`,
    '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', '2500k', '-pix_fmt', 'yuv420p', '-c:a', 'eac3', file]);
  if (r.status !== 0) throw new Error(String(r.stderr));
  return fs.readFileSync(file);
}
const A = make('a.mkv');
const B = make('b.mkv', 12);
const B2 = make('b2.mkv', 12, 500); // Tide Line S01E01 (B is Fine)
const G = make('g.mkv', 20, 350); // Grow
const P = make('p.mkv', 20, 400); // Prealloc
const E2 = make('e2.mkv', 20, 450); // Tide Line S01E02
const C = make('c.mkv', 20, 550); // Cancelled
const old = new Date(Date.now() - 864e5);
const put = (rel, buf, t = old) => {
  const f = path.join(lib, rel);
  fs.writeFileSync(f, buf);
  fs.utimesSync(f, t, t);
  return f;
};
// Already there when Couchbox starts:
put('Films/Fine (2014).mkv', B); // finished: should just be queued for conversion
put('Films/Cancelled (2013).mkv', C.subarray(0, Math.floor(C.length * 0.5))); // half, then stopped
const holes = Buffer.from(A);
holes.fill(0, Math.floor(A.length * 0.35), Math.floor(A.length * 0.65));
put('Films/Holes (2016).mkv', holes); // full size, middle never arrived
put('Series/Tide Line/Season 01/Tide Line - S01E01.mkv', B2);
put('Films/Changes (2015).mkv', A); // finished; will change while converting

const ids = {
  grow: 'film:films\\grow (2010).mkv',
  temp: 'film:films\\temp name (2011).mkv',
  pre: 'film:films\\prealloc (2012).mkv',
  cancelled: 'film:films\\cancelled (2013).mkv',
  holes: 'film:films\\holes (2016).mkv',
  fine: 'film:films\\fine (2014).mkv',
  changes: 'film:films\\changes (2015).mkv',
  ep2: 'ep:series\\tide line\\season 01\\tide line - s01e02.mkv',
};
fs.writeFileSync(path.join(dataDir, 'couchbox-data.json'), JSON.stringify({
  settings: { libraryPath: lib, previews: false, ...TEST_SETTINGS, autoConvert: true },
  profiles: [{ id: 'p1', name: 'Sam', color: '#2E9E6B', kids: false }],
}));

// Writes `buf` into `file` a piece at a time, from the start (like a browser download).
function trickle(file, buf, ms, steps) {
  const fd = fs.openSync(file, 'w');
  let i = 0;
  return new Promise((resolve) => {
    const t = setInterval(() => {
      const from = Math.floor((buf.length * i) / steps);
      const to = Math.floor((buf.length * (i + 1)) / steps);
      fs.writeSync(fd, buf, from, to - from, from);
      if (++i >= steps) {
        clearInterval(t);
        fs.closeSync(fd);
        resolve();
      }
    }, ms / steps);
  });
}
// Creates the full-size file first, then fills pieces in out of order (like a torrent).
function torrent(file, buf, ms, pieces) {
  fs.writeFileSync(file, Buffer.alloc(buf.length));
  const order = [...Array(pieces).keys()].sort((a, b) => ((a * 7) % pieces) - ((b * 7) % pieces));
  let i = 0;
  return new Promise((resolve) => {
    const t = setInterval(() => {
      const k = order[i];
      const from = Math.floor((buf.length * k) / pieces);
      const to = Math.floor((buf.length * (k + 1)) / pieces);
      const fd = fs.openSync(file, 'r+');
      fs.writeSync(fd, buf, from, to - from, from);
      fs.closeSync(fd);
      if (++i >= pieces) {
        clearInterval(t);
        resolve();
      }
    }, ms / pieces);
  });
}

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
    const dl = (id) => js(`S.dl.files[${JSON.stringify(id)}] || null`);
    const conv = () => js('S.conv');
    const until = async (label, fn, ms = 30000) => {
      for (let t = 0; t < ms; t += 300) {
        if (await fn()) return true;
        await wait(300);
      }
      console.log('  (timed out waiting for ' + label + ')');
      return false;
    };
    const sel = (id, rest) => `document.querySelector('.card[data-id="' + CSS.escape(${JSON.stringify(id)}) + '"] ${rest}')`;
    try {
      win.setSize(1400, 900);
      for (let i = 0; i < 100 && !win.isVisible(); i++) await wait(100);
      await js(`document.querySelector('[data-pid="p1"]').click()`);
      await wait(1500);

      // Downloads start while Couchbox is open.
      // Slow enough to look at: 40-45 seconds each.
      const grow = trickle(path.join(lib, 'Films', 'Grow (2010).mkv'), G, 45000, 90);
      const tempFile = path.join(lib, 'Films', 'Temp Name (2011).mkv.crdownload');
      const temp = trickle(tempFile, B, 40000, 80);
      const pre = torrent(path.join(lib, 'Films', 'Prealloc (2012).mkv'), P, 40000, 40);
      const ep2 = trickle(path.join(lib, 'Series', 'Tide Line', 'Season 01', 'Tide Line - S01E02.mkv'), E2, 45000, 90);

      await until('grow shows', async () => (await dl(ids.grow))?.s === 'downloading');
      await until('a %', async () => (await dl(ids.grow))?.p > 0.1, 12000);
      const g1 = await dl(ids.grow);
      check('growing file: Downloading, with a %', g1 && g1.s === 'downloading' && g1.p > 0, JSON.stringify(g1));
      check('temporary name: shows under its real name, Downloading', (await dl(ids.temp))?.s === 'downloading' && (await js(`!!byId(${JSON.stringify(ids.temp)})`)));
      check('torrent-style file: Downloading, with no % (it can\'t be told)', (await dl(ids.pre))?.s === 'downloading' && (await dl(ids.pre))?.p == null, JSON.stringify(await dl(ids.pre)));
      check('episode: Downloading', (await dl(ids.ep2))?.s === 'downloading');
      check('nothing downloading is in the conversion queue', !(await conv()).queue.some((r) => [ids.grow, ids.temp, ids.pre, ids.ep2].includes(r.id)));

      // The screens.
      await js(`S.tab = 'films'; renderContent(true)`);
      await wait(1500);
      check('card: purple line and "Downloading N%"', await js(`(() => { const o = ${sel(ids.grow, '.convov.dl')}; return !!o && /^Downloading \\d+%$/.test(o.textContent.trim()); })()`));
      await snap('90-cards-downloading');
      const g2 = await dl(ids.grow);
      check('the % goes up', g2.p > g1.p, `${g1.p} -> ${g2.p}`);
      // Play on a downloading film opens its page with the pie, not the player.
      await js(`play(byId(${JSON.stringify(ids.grow)}))`);
      await wait(600);
      check('Play while downloading: the details page, not the player', (await js('!!S.details && !Player.isOpen()')));
      check('the Play button is a purple pie', await js(`(() => { const p = document.querySelector('.details .pie-play'); return !!p && /\\d+%/.test(p.style.getPropertyValue('--pp')); })()`));
      check('next to it: "Downloading N%" and the sizes', /Downloading \d+%/.test(await js(`document.querySelector('.details .d-dl').innerText`)));
      await snap('91-details-pie');
      await js(`closeModal(); openDetails(${JSON.stringify(ids.pre)})`);
      await wait(500);
      check('no %: the pie is a turning arc', await js(`!!document.querySelector('.details .pie-play.spin .pie-arc')`));
      await snap('92-details-pie-no-percent');
      await js(`closeModal(); openDetails('series:tide line')`);
      await wait(600);
      check('episode list: "Downloading" on the episode', /Downloading/.test(await js(`[...document.querySelectorAll('.ep .ep-conv')].map(x=>x.textContent).join(' ')`)));
      await snap('93-episode-downloading');
      await js(`closeModal()`);
      // The pie plays what's there.
      await js(`openDetails(${JSON.stringify(ids.grow)})`);
      await wait(400);
      await js(`document.querySelector('.details .pie-play').click()`);
      await wait(1500);
      check('clicking the pie opens the player', await js('Player.isOpen()'));
      await js('Player.close(); closeModal()');

      // Already-there files: the cancelled download and the one with a missing middle.
      await until('incomplete', async () => (await dl(ids.cancelled))?.s === 'incomplete' && (await dl(ids.holes))?.s === 'incomplete', 20000);
      const c1 = await dl(ids.cancelled);
      const h1 = await dl(ids.holes);
      check('cancelled half download: Incomplete, with a reason', c1?.s === 'incomplete' && !!c1.reason, JSON.stringify(c1));
      check('missing middle (torrent stopped): Incomplete', h1?.s === 'incomplete', JSON.stringify(h1));
      check('a finished file is never shown as downloading', !(await dl(ids.fine)));
      await js(`renderContent(true)`);
      await wait(400);
      check('card: grey Incomplete tag', await js(`!!${sel(ids.cancelled, '.inctag')}`));

      // The finished file that starts changing while it converts.
      await until('changes converting', async () => (await conv()).queue.some((r) => r.id === ids.changes && r.s === 'converting'), 30000);
      check('a finished file is converted', (await conv()).queue.some((r) => r.id === ids.changes && r.s === 'converting'));
      fs.appendFileSync(path.join(lib, 'Films', 'Changes (2015).mkv'), Buffer.alloc(200000, 1));
      await until('changes downloading', async () => (await dl(ids.changes))?.s === 'downloading', 15000);
      await wait(800);
      const cv = await conv();
      const leftovers = fs.readdirSync(path.join(lib, 'Films')).filter((n) => /^Changes.*\.converting\./.test(n));
      const binned = fs.existsSync(path.join(lib, '.couchbox-bin', 'Films', 'Changes (2015).mkv'));
      const still = cv.queue.find((r) => r.id === ids.changes);
      check('it changes: the conversion stops, nothing replaced', !(still && still.s === 'converting') && !leftovers.length && !binned, JSON.stringify({ still, leftovers, binned }));

      // Finish everything.
      await Promise.all([grow, temp, pre, ep2]);
      fs.renameSync(tempFile, tempFile.replace(/\.crdownload$/, ''));
      await until('all done', async () => {
        const f = await js('S.dl.files');
        return ![ids.grow, ids.temp, ids.pre, ids.ep2].some((id) => f[id]);
      }, 40000);
      const f = await js('S.dl.files');
      check('growing file: finished', !f[ids.grow]);
      check('renamed download: finished, same id (and title)', !f[ids.temp] && (await js(`!!byId(${JSON.stringify(ids.temp)})`)));
      check('torrent-style file: finished once filled in', !f[ids.pre]);
      check('episode: finished', !f[ids.ep2]);
      check('the incomplete ones stay Incomplete', f[ids.cancelled]?.s === 'incomplete' && f[ids.holes]?.s === 'incomplete');
      const want = [ids.grow, ids.temp, ids.pre];
      await until('queued', async () => {
        const ids2 = (await conv()).queue.map((r) => r.id);
        return want.every((id) => ids2.includes(id));
      }, 15000);
      const q = (await conv()).queue.map((r) => r.id);
      check('finished downloads join the conversion queue', want.every((id) => q.includes(id)), q.join(' | '));
      check('incomplete ones are not queued', !q.includes(ids.cancelled) && !q.includes(ids.holes));
      // A stopped download that resumes and finishes clears its Incomplete tag.
      fs.writeFileSync(path.join(lib, 'Films', 'Cancelled (2013).mkv'), C);
      await until('cancelled finished', async () => !(await dl(ids.cancelled)), 20000);
      check('an Incomplete file that finishes clears by itself', !(await dl(ids.cancelled)));
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
