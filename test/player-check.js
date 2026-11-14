// Player test: auto-fullscreen when maximised, Esc / F11 / top-bar button, and the next-episode
// timings (card at 30 s left, countdown from 20 s, next episode at 15 s, marked watched).
// Usage: set COUCHBOX_LIBRARY (the sample library) and COUCHBOX_SNAP_OUT, then: npx electron test/player-check.js
const path = require('path');
const fs = require('fs');
const os = require('os');
const { app } = require('electron');

const out = process.env.COUCHBOX_SNAP_OUT;
fs.mkdirSync(out, { recursive: true });
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'couchbox-player-'));
process.env.COUCHBOX_DATA_DIR = dataDir;
fs.writeFileSync(path.join(dataDir, 'couchbox-data.json'), JSON.stringify({
  settings: { libraryPath: process.env.COUCHBOX_LIBRARY, volume: 0, autoplayNext: true, previews: false },
  profiles: [{ id: 'p1', name: 'Sam', color: '#2E9E6B', kids: false }],
}));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const errors = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== '' ? '  -- ' + detail : ''}`);
};

app.on('browser-window-created', (_e, win) => {
  win.webContents.once('did-finish-load', async () => {
    if (win.webContents.getURL().includes('splash.html')) return;
    win.webContents.on('console-message', (e) => {
      if (e.level === 'error' || e.level === 'warning' || e.level === 3 || e.level === 2) errors.push(e.message);
    });
    const js = (code) => win.webContents.executeJavaScript(code);
    const snap = async (name) => {
      await wait(400);
      fs.writeFileSync(path.join(out, name + '.png'), (await win.webContents.capturePage()).toPNG());
      console.log('snap', name);
    };
    const until = async (label, code, ms = 30000) => {
      for (let t = 0; t < ms; t += 200) {
        if (await js(code)) return true;
        await wait(200);
      }
      throw new Error('timed out waiting for ' + label);
    };
    const full = () => win.isFullScreen();
    const settle = () => wait(1200); // fullscreen changes are animated by Windows
    const vid = `document.querySelector('#player video.main')`;
    const cardState = () => js(`(() => { const c = document.querySelector('.next-card'); return c.hidden ? 'hidden' : c.querySelector('.count') ? 'count:' + c.querySelector('.secs').textContent : 'plain'; })()`);
    const epTitle = () => js(`document.querySelector('#player .p-name').textContent`);
    try {
      for (let i = 0; i < 100 && !win.isVisible(); i++) await wait(100);
      await js(`document.querySelector('[data-pid="p1"]').click()`);
      await until('library', `S.model.series.length > 0 && document.getElementById('statuspill').hidden`, 60000);
      const series = `S.model.series.find(s => s.title === 'The Long Coast')`;
      const ep1 = `${series}.seasons[0].episodes[0]`;

      // --- not maximised: plays in the window ---
      win.unmaximize();
      win.setSize(1200, 760);
      await settle();
      await js(`playFile(${ep1}.id)`);
      await settle();
      check('window not maximised: video plays in the window', !full());
      await js(`Player.close()`);
      await wait(500);

      // --- maximised: plays fullscreen, Esc leaves the video but stays fullscreen ---
      win.maximize();
      await settle();
      await js(`playFile(${ep1}.id)`);
      await settle();
      check('window maximised: video goes fullscreen', full());
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
      await wait(800);
      check('Esc in the player leaves the video', !(await js('Player.isOpen()')));
      check('...and Couchbox stays fullscreen', full());
      check('exit-fullscreen button shows in the top bar', await js(`getComputedStyle(document.querySelector('.exit-full')).display !== 'none'`));
      await snap('40-home-fullscreen');
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
      await settle();
      check('Esc on the home screen leaves fullscreen', !full());
      check('exit-fullscreen button hidden when not fullscreen', await js(`getComputedStyle(document.querySelector('.exit-full')).display === 'none'`));
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'F11' });
      await settle();
      check('F11 turns fullscreen on', full());
      await js(`document.querySelector('.exit-full').click()`);
      await settle();
      check('top-bar button leaves fullscreen', !full());
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'F11' });
      await settle();
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'F11' });
      await settle();
      check('F11 turns fullscreen off again', !full());

      // --- next episode timings (window not maximised, so this runs windowed) ---
      win.unmaximize();
      await settle();
      await js(`playFile(${ep1}.id)`);
      await until('video ready', `${vid}.duration > 0`);
      const d = await js(`${vid}.duration`);
      const first = await epTitle();
      await js(`${vid}.currentTime = ${d - 34}`);
      await wait(1500);
      const before = await cardState();
      check('no card with more than 30 s left', before === 'hidden', before);
      await until('30 s left', `${vid}.currentTime >= ${d - 29.5}`, 10000);
      const c30 = await cardState();
      check('card appears at 30 s left, no countdown yet', c30 === 'plain', c30);
      await snap('41-next-card-30s');
      await until('countdown', `${vid}.currentTime >= ${d - 19.5}`, 20000);
      const c20 = await cardState();
      check('countdown starts at 20 s left', c20.startsWith('count:'), c20);
      await snap('42-next-countdown');
      const t0 = Date.now();
      await until('next episode', `document.querySelector('#player .p-name').textContent !== ${JSON.stringify(first)}`, 15000);
      const secs = (Date.now() - t0) / 1000;
      const progress = await js(`S.progress[${ep1}.id]`);
      check('next episode starts at about 15 s left (not at the end)', secs < 6.5, `${secs.toFixed(1)} s after 19.5 s left`);
      check('the cut-short episode counts as watched', progress && isFinite(progress.t) && progress.t >= progress.d - 0.5, JSON.stringify(progress));
      await js(`Player.close()`);
      await wait(500);

      // --- Watch credits: no early countdown; the 5 s countdown runs at the real end ---
      await js(`playFile(${ep1}.id)`);
      await until('video ready', `${vid}.duration > 0`);
      await js(`${vid}.currentTime = ${d - 31}`);
      await until('card', `!document.querySelector('.next-card').hidden`, 8000);
      await js(`document.querySelector('[data-p="dismiss-next"]').click()`);
      await until('past 15 s left', `${vid}.currentTime >= ${d - 13}`, 25000);
      check('Watch credits: no early switch', (await epTitle()) === first && (await cardState()) === 'hidden');
      await until('end countdown', `!!document.querySelector('.next-card .count')`, 40000).catch(async (e) => {
        console.log('debug:', JSON.stringify(await js(`({ t: ${vid}.currentTime, d: ${vid}.duration, paused: ${vid}.paused, ended: ${vid}.ended, card: document.querySelector('.next-card').hidden })`)));
        throw e;
      });
      check('Watch credits: countdown appears at the end, as before', true);
      await until('next episode', `document.querySelector('#player .p-name').textContent !== ${JSON.stringify(first)}`, 10000);
      check('Watch credits: next episode plays after the end countdown', true);
      await js(`Player.close()`);
      await wait(500);

      // --- Skipping straight into the last 15 s: card, but no instant jump ---
      await js(`playFile(${ep1}.id)`);
      await until('video ready', `${vid}.duration > 0`);
      await js(`${vid}.currentTime = ${d - 12}`);
      await wait(2000);
      const cSkip = await cardState();
      check('skip into last 15 s: stays on the episode with the plain card', (await epTitle()) === first && cSkip === 'plain', cSkip);
      await until('end countdown', `!!document.querySelector('.next-card .count')`, 25000);
      check('skip into last 15 s: countdown runs at the end', true);
      await js(`Player.close()`);
      await wait(500);

      // --- Cancel during the early countdown ---
      await js(`playFile(${ep1}.id)`);
      await until('video ready', `${vid}.duration > 0`);
      await js(`${vid}.currentTime = ${d - 21.5}`);
      await until('countdown', `!!document.querySelector('.next-card .count')`, 8000);
      await js(`document.querySelector('[data-p="dismiss-next"]').click()`);
      await until('past 15 s left', `${vid}.currentTime >= ${d - 13}`, 15000);
      check('Cancel: stays on the same episode past 15 s left', (await epTitle()) === first && (await cardState()) === 'hidden');
      await js(`Player.close()`);
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
