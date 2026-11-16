// The player's controls and a knocked mouse, with real mouse moves: a small knock or a slow drift
// doesn't bring the controls (or the pointer) up; a longer move, a shake or a click does; once
// they're up, small moves keep them up, and they hide 3 s after the mouse stops; paused, they
// stay up; the up/down volume keys still show them.
// Usage: npx electron test/player-wake-check.js
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');
const { app } = require('electron');
const { TEST_SETTINGS } = require('./quiet');
const ffmpeg = require('ffmpeg-static');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'couchbox-wake-'));
const lib = path.join(tmp, 'Videos');
fs.mkdirSync(path.join(lib, 'Films'), { recursive: true });
process.env.COUCHBOX_DATA_DIR = path.join(tmp, 'data');
process.env.COUCHBOX_NO_LOGIN_ITEM = '1';
fs.mkdirSync(process.env.COUCHBOX_DATA_DIR);
const film = path.join(lib, 'Films', 'Long Clip (2020).mkv');
const r = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25:duration=120', '-f', 'lavfi', '-i', 'sine=duration=120',
  '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', film]);
if (r.status !== 0) throw new Error(String(r.stderr));
const hourAgo = new Date(Date.now() - 3600e3);
fs.utimesSync(film, hourAgo, hourAgo); // not a file that's still downloading
fs.writeFileSync(path.join(process.env.COUCHBOX_DATA_DIR, 'couchbox-data.json'), JSON.stringify({
  settings: { libraryPath: lib, previews: false, ...TEST_SETTINGS },
  profiles: [{ id: 'p1', name: 'Sam', color: '#2E9E6B', kids: false }],
}));

const wait = (ms) => new Promise((res) => setTimeout(res, ms));
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
    const wc = win.webContents;
    const js = (code) => wc.executeJavaScript(code);
    const idle = () => js(`document.getElementById('player').classList.contains('idle')`);
    const until = async (code, ms = 15000) => {
      for (let t = 0; t < ms; t += 100) {
        if (await js(code)) return true;
        await wait(100);
      }
      return false;
    };
    let x = 600, y = 400;
    const move = async (dx, dy, gap = 30) => {
      x += dx;
      y += dy;
      wc.sendInputEvent({ type: 'mouseMove', x, y });
      await wait(gap);
    };
    const waitIdle = () => until(`document.getElementById('player').classList.contains('idle')`, 6000);
    try {
      for (let i = 0; i < 100 && !win.isVisible(); i++) await wait(100);
      win.setSize(1300, 850);
      await js(`document.querySelector('[data-pid="p1"]').click()`);
      await until(`S.model && S.model.films.length === 1 && S.model.films[0].duration > 0`, 30000);
      await js(`playFile(S.model.films[0].id)`);
      await until(`(() => { const v = document.querySelector('#player video.main'); return v && !v.paused && v.currentTime > 0.5; })()`);
      wc.sendInputEvent({ type: 'mouseMove', x, y }); // where the mouse is
      check('playing: the controls hide after 3 s', await waitIdle());
      await js(`(() => { window.__log = []; const r = document.getElementById('player'); const t0 = performance.now();
        r.addEventListener('mousemove', (e) => window.__log.push('m ' + Math.round(performance.now() - t0) + ' ' + e.clientX + ',' + e.clientY), true);
        new MutationObserver(() => window.__log.push('c ' + Math.round(performance.now() - t0) + ' ' + r.className)).observe(r, { attributes: true, attributeFilter: ['class'] }); })()`);
      const dump = async () => console.log('LOG', (await js('window.__log')).join(' | '));

      await move(5, 0);
      await wait(150);
      const k = await idle(); check('a 5 px knock: the controls stay hidden', k); if (!k) await dump();
      check('...and so does the pointer', (await js(`getComputedStyle(document.getElementById('player')).cursor`)) === 'none');

      for (let i = 0; i < 40; i++) await move(i % 2 ? 0 : 6, i % 2 ? 6 : 0, 100); // 4 s, 240 px, slowly
      check('a slow drift (240 px over 4 s): still hidden', await idle());

      for (let i = 0; i < 6; i++) await move(30, 0, 40); // 180 px in about a quarter second
      const lm = !(await idle()); check('a longer move (180 px in a quarter second): the controls come up', lm); if (!lm) await dump();

      check('...and hide again 3 s after the mouse stops', await waitIdle());
      for (const dx of [30, -30, 30, -30]) await move(dx, 0, 60); // a shake: 3 changes of direction
      check('a shake (3 swings back and forth): the controls come up', !(await idle()));

      // Once up, small moves keep them up.
      for (let i = 0; i < 8; i++) await move(i % 2 ? -4 : 4, 0, 500);
      check('once up, small moves keep them up (4 s of small moves)', !(await idle()));
      check('...then they hide 3 s after the mouse stops', await waitIdle());

      // A click on the picture: up, and it still pauses.
      wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
      wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
      await wait(500);
      check('a click brings the controls up', !(await idle()));
      check('...and still pauses', await js(`document.querySelector('#player video.main').paused`));
      await wait(3500);
      check('paused: the controls stay up', !(await idle()));
      await js(`document.querySelector('#player video.main').play()`);
      await waitIdle();

      // The volume keys still show them.
      wc.sendInputEvent({ type: 'keyDown', keyCode: 'Up' });
      wc.sendInputEvent({ type: 'keyUp', keyCode: 'Up' });
      await wait(200);
      check('the up volume key shows the controls', !(await idle()));
      await waitIdle();
      wc.sendInputEvent({ type: 'keyDown', keyCode: 'Down' });
      wc.sendInputEvent({ type: 'keyUp', keyCode: 'Down' });
      await wait(200);
      check('...and the down one', !(await idle()));

      await js('Player.close()');
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
