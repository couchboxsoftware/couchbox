// Intro detection: generated seasons whose episodes share one "theme" sound amid random noise.
// Checks the guesses (theme at the start, after cold opens, 4-5 minutes in; a 3-second shared
// clip ignored; a theme after 10 minutes, an episode without it and a one-episode season give no
// intro; films are never checked), that unchanged files aren't checked again, that detection
// waits for conversions, and the player: Skip only during the intro, the Guessed tag, Enter /
// Space / S, no gear button, the "Was that the intro?" question (kids never asked), Yes
// (confirms the season, a shortened intro, a new episode checked against it) and No (pauses,
// both answers needed, rewinds, searches again in that direction, right + right = Yes).
// Usage: npx electron test/intro-detect-check.js   (screenshots go to COUCHBOX_SNAP_OUT, or a temp folder)
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');
const { app } = require('electron');
const { TEST_SETTINGS } = require('./quiet');
const ffmpeg = require('ffmpeg-static');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'couchbox-intro-'));
const lib = path.join(tmp, 'Videos');
const out = process.env.COUCHBOX_SNAP_OUT || path.join(tmp, 'snaps');
fs.mkdirSync(out, { recursive: true });
process.env.COUCHBOX_DATA_DIR = path.join(tmp, 'data');
fs.mkdirSync(process.env.COUCHBOX_DATA_DIR, { recursive: true });
process.env.COUCHBOX_INTRO_ASK_MS = '2500';

const THEME = "0.4*sin(2*PI*(330+110*floor(mod(t*2,4)))*t)+0.3*sin(2*PI*(523+90*floor(mod(t*3,5)))*t)+0.15*sin(2*PI*1200*t)*sin(2*PI*0.5*t)";
const CLIP = '0.5*sin(2*PI*880*t)*sin(2*PI*3*t)';
let seed = 1;
// parts: [['noise', secs] | ['theme', secs] | ['clip', 3]] -> an episode (H.264 + AAC, plays as is).
function episode(rel, parts) {
  const f = path.join(lib, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const inputs = [];
  let total = 0;
  for (const [kind, secs] of parts) {
    total += secs;
    if (kind === 'noise') inputs.push('-f', 'lavfi', '-i', `anoisesrc=d=${secs}:c=pink:r=22050:a=0.3:seed=${seed++}`);
    else if (kind === 'theme' || kind === 'clip') inputs.push('-f', 'lavfi', '-i', `aevalsrc='${kind === 'theme' ? THEME : CLIP}':s=22050:d=${secs}`);
    else inputs.push('-f', 'lavfi', '-i', `aevalsrc='${THEME.replace(/\bt\b/g, `(t+${kind.split(':')[1]})`)}':s=22050:d=${secs}`); // 'theme:26' = the theme from 26 s in
  }
  const n = parts.length;
  const filter = parts.map((_, i) => `[${i}:a]`).join('') + `concat=n=${n}:v=0:a=1[a]`;
  const r = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...inputs, '-f', 'lavfi', '-i', `color=c=0x335577:s=160x90:r=5:d=${total}`,
    '-filter_complex', filter, '-map', `${n}:v`, '-map', '[a]', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', f]);
  if (r.status !== 0) throw new Error(String(r.stderr));
  const t = new Date(Date.now() - 3600e3);
  fs.utimesSync(f, t, t);
  return f;
}
const S1 = 'Series/Test Show/Season 01/Test Show - S01E0';
episode(S1 + '1.mkv', [['clip', 3], ['theme', 40], ['noise', 60]]); // theme from 3 s
episode(S1 + '2.mkv', [['clip', 3], ['noise', 20], ['theme', 40], ['noise', 50]]); // 23 s
episode(S1 + '3.mkv', [['clip', 3], ['noise', 75], ['theme', 40], ['noise', 30]]); // 78 s
episode(S1 + '4.mkv', [['clip', 3], ['noise', 7], ['theme', 25], ['noise', 60]]); // a shortened theme, 10 s
episode(S1 + '5.mkv', [['clip', 3], ['noise', 100]]); // no theme
const S2 = 'Series/Late Show/Season 01/Late Show - S01E0';
episode(S2 + '1.mkv', [['noise', 250], ['theme', 40], ['noise', 60]]); // 4 min 10 s in
episode(S2 + '2.mkv', [['noise', 280], ['theme', 40], ['noise', 40]]); // 4 min 40 s in
const S3 = 'Series/Very Late/Season 01/Very Late - S01E0';
episode(S3 + '1.mkv', [['noise', 620], ['theme', 40], ['noise', 20]]); // after 10 minutes
episode(S3 + '2.mkv', [['noise', 640], ['theme', 40], ['noise', 10]]);
episode('Series/Only One/Season 01/Only One - S01E01.mkv', [['noise', 10], ['theme', 40], ['noise', 30]]);
// A 12-second studio logo at the very start of every episode, and no theme.
episode('Series/Logo Show/Season 01/Logo Show - S01E01.mkv', [['clip', 12], ['noise', 60]]);
episode('Series/Logo Show/Season 01/Logo Show - S01E02.mkv', [['clip', 12], ['noise', 70]]);
// The theme with 6 seconds of something else over the middle of it in one episode.
episode('Series/Broken Show/Season 01/Broken Show - S01E01.mkv', [['noise', 15], ['theme', 40], ['noise', 30]]);
episode('Series/Broken Show/Season 01/Broken Show - S01E02.mkv', [['noise', 25], ['theme', 20], ['noise', 6], ['theme:26', 14], ['noise', 30]]);
episode('Films/Theme Film (2020).mkv', [['noise', 10], ['theme', 40], ['noise', 30]]);

const id = (rel) => 'ep:' + rel.replace(/\//g, '\\').toLowerCase();
const E = (n) => id(`${S1}${n}.mkv`);
const L = (n) => id(`${S2}${n}.mkv`);
fs.writeFileSync(path.join(process.env.COUCHBOX_DATA_DIR, 'couchbox-data.json'), JSON.stringify({
  settings: { libraryPath: lib, previews: false, ...TEST_SETTINGS, autoplayNext: false },
  profiles: [{ id: 'p1', name: 'Sam', color: '#2E9E6B', kids: false }, { id: 'p3', name: 'Kids', color: '#D9A21B', kids: true }],
  kidsAllow: { 'series:test show': true },
}));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const errors = [];
const check = (name, ok, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== '' ? '  -- ' + detail : ''}`);
};
const near = (a, b, tol = 0.5) => a != null && Math.abs(a - b) <= tol;

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
    const until = async (fn, ms = 120000) => {
      for (let t = 0; t < ms; t += 300) {
        if (await fn()) return true;
        await wait(300);
      }
      return false;
    };
    const intros = () => global.__couchbox.intros;
    const ep = (eid) => intros().store.data.introEpisodes[eid];
    const vid = (code) => js(`(() => { const v = document.querySelector('#player video.main'); ${code} })()`);
    try {
      win.setSize(1400, 900);
      for (let i = 0; i < 100 && !win.isVisible(); i++) await wait(100);
      await js(`document.querySelector('[data-pid="p1"]').click()`);
      // Count the heavy work, to tell whether unchanged files are checked again.
      let asks = 0;
      const orig = intros().ask.bind(intros());
      intros().ask = (m, t) => (asks++, orig(m, t));
      await until(() => ['1', '2', '3', '4', '5'].every((n) => ep(E(n))) && ep(L(1)) && ep(L(2)) && ep(id(S3 + '1.mkv')));
      await wait(1000);

      // The guesses.
      const g = (n) => ep(E(n)) || {};
      check('theme right at the start (after a 3 s shared clip): found within 0.5 s', near(g(1).start, 3) && near(g(1).end, 43), JSON.stringify(g(1)));
      check('after cold opens of different lengths: found', near(g(2).start, 23) && near(g(3).start, 78), `${JSON.stringify(g(2))} ${JSON.stringify(g(3))}`);
      check('the shared 3-second clip is ignored (no intro starting at 0)', ![1, 2, 3].some((n) => g(n).start < 2));
      check('a shortened theme is found on its own', near(g(4).start, 10, 1) && near(g(4).end, 35, 1), JSON.stringify(g(4)));
      check('an episode without the theme: no intro', g(5).none === true, JSON.stringify(g(5)));
      check('theme 4-5 minutes in: found', near((ep(L(1)) || {}).start, 250) && near((ep(L(2)) || {}).start, 280), `${JSON.stringify(ep(L(1)))} ${JSON.stringify(ep(L(2)))}`);
      check('theme after 10 minutes: no intro', (ep(id(S3 + '1.mkv')) || {}).none === true && (ep(id(S3 + '2.mkv')) || {}).none === true);
      check('a one-episode season: no intro', (ep(id('Series/Only One/Season 01/Only One - S01E01.mkv')) || { none: true }).none === true);
      const logoEp = ep(id('Series/Logo Show/Season 01/Logo Show - S01E01.mkv')) || {};
      check('a 12-second studio logo at the very start isn\'t the intro', logoEp.none === true, JSON.stringify(logoEp));
      const b2 = ep(id('Series/Broken Show/Season 01/Broken Show - S01E02.mkv')) || {};
      check('a theme with something else over the middle: found whole', near(b2.start, 25, 1) && near(b2.end, 65, 1), JSON.stringify(b2));
      check('films are never checked', !Object.keys(intros().store.data.introEpisodes).some((k) => k.startsWith('film:')));
      check('seasons start as guessed', intros().store.data.introSeasons['series:test show|1'].status === 'guessed');
      // Unchanged: not checked again.
      const before = asks;
      intros().schedule();
      await wait(3000);
      check('an unchanged file isn\'t checked again', asks === before, `${before} -> ${asks}`);
      // Waits for conversions.
      const conv = global.__couchbox.converter;
      conv.running.set('fake', { lane: 'fast', file: 'x', f: { id: 'fake' } });
      check('detection waits while a conversion runs', intros().idle() === false);
      conv.running.delete('fake');

      // The player: Skip only during the intro, with "Guessed".
      await js(`playFile(${JSON.stringify(E(2))})`);
      await until(() => vid('return v && v.readyState >= 2;'), 15000);
      check('the gear button (manual intro marks) is gone', await js(`!document.querySelector('[data-p="intro-menu"]')`));
      await vid('v.currentTime = 10; v.pause();');
      await wait(500);
      check('Skip is hidden before the intro (cold open)', await js(`document.querySelector('.skip-intro').hidden`));
      await vid('v.currentTime = 30;');
      await wait(500);
      check('Skip shows during the intro, labelled "Skip" with a Guessed tag', await js(`(() => { const b = document.querySelector('.skip-intro'); return !b.hidden && /^Skip/.test(b.innerText) && !b.querySelector('.guess-tag').hidden; })()`));
      await snap('120-skip-guessed');
      await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }))`);
      await wait(300);
      check('Space still plays/pauses while Skip shows', !(await vid('return v.paused;')) && !(await js(`document.querySelector('.skip-intro').hidden`)));
      await vid('v.currentTime = 64;');
      await wait(500);
      check('Skip is hidden after the intro', await js(`document.querySelector('.skip-intro').hidden`));
      // Enter presses Skip; the question shows; the video keeps playing.
      await vid('v.currentTime = 30; v.play();');
      await wait(500);
      await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
      await wait(500);
      check('Enter presses Skip (jumps to the end of the intro)', await vid('return v.currentTime >= 62;'));
      check('the question shows, and the video keeps playing', await js(`!document.querySelector('.intro-ask').hidden && /Was that the intro/.test(document.querySelector('.intro-ask').innerText)`) && !(await vid('return v.paused;')));
      await snap('121-was-that-the-intro');
      await wait(2800);
      check('unanswered, it goes after a while', await js(`document.querySelector('.intro-ask').hidden`));
      // S also skips; unanswered last time, so it asks again.
      await vid('v.currentTime = 30;');
      await wait(500);
      await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 's', bubbles: true }))`);
      await wait(500);
      check('S skips too, and it asks again (unanswered before)', await js(`!document.querySelector('.intro-ask').hidden`));
      // Yes: the season is confirmed, every episode checked against it.
      await js(`document.querySelector('.intro-ask [data-p="ia-yes"]').click()`);
      await until(() => intros().store.data.introSeasons['series:test show|1'].status === 'confirmed' && g(4).source === 'confirmed', 60000);
      await wait(1000);
      check('Yes: the season is confirmed', intros().store.data.introSeasons['series:test show|1'].status === 'confirmed');
      check('...a shortened intro: Skip covers just that part', g(4).partial === true && near(g(4).start, 10, 1) && near(g(4).end, 35, 1), JSON.stringify(g(4)));
      check('...an episode without it: still none', g(5).none === true);
      await vid('v.currentTime = 30;');
      await wait(500);
      check('...the Guessed tag has gone', await js(`document.querySelector('.skip-intro .guess-tag').hidden`));
      await js(`document.querySelector('.skip-intro').click()`);
      await wait(400);
      check('...and it never asks about that season again', await js(`document.querySelector('.intro-ask').hidden`));
      await js('Player.close()');
      // A new episode in a confirmed season is checked against the reference.
      episode(S1 + '6.mkv', [['noise', 33], ['theme', 40], ['noise', 30]]);
      await js('cb.refresh()');
      await until(() => !!ep(E(6)), 60000);
      check('a new episode in a confirmed season is checked against it', near((ep(E(6)) || {}).start, 33) && (ep(E(6)) || {}).source === 'confirmed', JSON.stringify(ep(E(6))));

      // Kids are never asked.
      await js(`pickProfile('p3')`);
      await wait(800);
      intros().store.data.introSeasons['series:test show|1'].status = 'guessed'; // pretend it's still guessed
      intros().announce();
      await wait(300);
      await js(`playFile(${JSON.stringify(E(1))})`);
      await until(() => vid('return v && v.readyState >= 2;'), 15000);
      await vid('v.currentTime = 10;');
      await wait(500);
      await js(`document.querySelector('.skip-intro').click()`);
      await wait(500);
      check('kids see Skip but are never asked', await js(`document.querySelector('.intro-ask').hidden`));
      await js('Player.close()');
      intros().store.data.introSeasons['series:test show|1'].status = 'confirmed';
      intros().announce();
      await js(`pickProfile('p1')`);
      await wait(800);

      // No: pauses, needs both answers, rewinds, searches again in that direction.
      const before1 = { ...ep(L(1)) };
      await js(`playFile(${JSON.stringify(L(1))})`);
      await until(() => vid('return v && v.readyState >= 2;'), 15000);
      await vid(`v.currentTime = ${before1.start + 5}; v.play();`);
      await wait(600);
      await js(`document.querySelector('.skip-intro').click()`);
      await wait(400);
      await js(`document.querySelector('.intro-ask [data-p="ia-no"]').click()`);
      await wait(300);
      check('No: the video pauses straight away and asks what was wrong', (await vid('return v.paused;')) && /What was wrong/.test(await js(`document.querySelector('.p-overlay').innerText`)));
      await snap('122-what-was-wrong');
      await js(`document.querySelector('.p-overlay [data-p="ia-send"]').click()`);
      await wait(200);
      check('Send needs both answers', await js(`!document.querySelector('#ia-err').hidden && !document.querySelector('.p-overlay').hidden`));
      await js(`document.querySelector('input[name="ia-start"][value="soon"]').click(); document.querySelector('input[name="ia-end"][value="ok"]').click(); document.querySelector('.p-overlay [data-p="ia-send"]').click()`);
      await wait(600);
      check('after Send: back to where Skip was pressed, playing', (await vid(`return Math.abs(v.currentTime - ${before1.start + 5}) < 2 && !v.paused;`)));
      await until(() => (intros().store.data.introRejects[L(1)] || []).length > 0, 20000);
      await wait(1500);
      const after1 = ep(L(1)) || {};
      check('"appeared too soon": the start moves later (or no intro); the end stays', (after1.none || (after1.start > before1.start + 1 && Math.abs(after1.end - before1.end) <= 1)), `${JSON.stringify(before1)} -> ${JSON.stringify(after1)}`);
      check('the season stays guessed', intros().store.data.introSeasons['series:late show|1'].status === 'guessed');
      check('a rejected stretch is never offered again', !(after1.start === before1.start && after1.end === before1.end));
      await js('Player.close()');
      // Right + right counts as Yes.
      const l2 = ep(L(2));
      await js(`playFile(${JSON.stringify(L(2))})`);
      await until(() => vid('return v && v.readyState >= 2;'), 15000);
      await vid(`v.currentTime = ${l2.start + 5}; v.play();`);
      await wait(600);
      await js(`document.querySelector('.skip-intro').click()`);
      await wait(400);
      await js(`document.querySelector('.intro-ask [data-p="ia-no"]').click()`);
      await wait(300);
      await js(`document.querySelector('input[name="ia-start"][value="ok"]').click(); document.querySelector('input[name="ia-end"][value="ok"]').click(); document.querySelector('.p-overlay [data-p="ia-send"]').click()`);
      await until(() => intros().store.data.introSeasons['series:late show|1'].status === 'confirmed', 30000);
      check('"right" for both counts as Yes', intros().store.data.introSeasons['series:late show|1'].status === 'confirmed');
      await js('Player.close()');
      // Results survive a restart (they're in the saved data).
      intros().store.save(true);
      const saved = JSON.parse(fs.readFileSync(path.join(process.env.COUCHBOX_DATA_DIR, 'couchbox-data.json'), 'utf8'));
      check('results are saved (they survive a restart)', saved.introSeasons['series:test show|1'].status === 'confirmed' && !!saved.introEpisodes[E(2)]);
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
