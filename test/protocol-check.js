// The app:// protocol (src/main/app-protocol.js): pages come from app://couchbox/, and media from
// app://couchbox/media/… only inside the video folder and Couchbox's data folder. Byte ranges get
// 206 Partial Content (whole, a range, the last bytes); anything outside those folders, or
// climbing out of the app folder, is refused. In the real player: an MP4 and an MKV play, seeking
// lands where it should, the scrub thumbnails seek, subtitles show, a hover preview plays, and
// the Content-Security-Policy is never broken.
// Usage: npx electron test/protocol-check.js
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');
const { app } = require('electron');
const { TEST_SETTINGS } = require('./quiet');
const ffmpeg = require('ffmpeg-static');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'couchbox-proto-'));
const lib = path.join(tmp, 'Videos');
fs.mkdirSync(path.join(lib, 'Films'), { recursive: true });
process.env.COUCHBOX_DATA_DIR = path.join(tmp, 'data');
process.env.COUCHBOX_NO_LOGIN_ITEM = '1';
fs.mkdirSync(process.env.COUCHBOX_DATA_DIR);
function video(rel, secs, freq, codec = 'aac') {
  const f = path.join(lib, rel);
  const r = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=size=320x180:rate=25:duration=${secs}`, '-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=${secs}`,
    '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-g', '25', '-c:a', codec, f]);
  if (r.status !== 0) throw new Error(String(r.stderr));
  const t = new Date(Date.now() - 3600e3);
  fs.utimesSync(f, t, t);
  return f;
}
const mp4 = video('Films/Night Train (2019).mp4', 90, 330);
video('Films/Fernhill (2018).mkv', 30, 440);
fs.writeFileSync(path.join(lib, 'Films', 'Night Train (2019).srt'), '1\n00:00:00,500 --> 00:01:30,000\nHello from the subtitles\n');
const outside = path.join(tmp, 'outside.txt'); // in neither the video folder nor the data folder
fs.writeFileSync(outside, 'secret');
fs.writeFileSync(path.join(process.env.COUCHBOX_DATA_DIR, 'couchbox-data.json'), JSON.stringify({
  settings: { libraryPath: lib, ...TEST_SETTINGS, previews: true },
  profiles: [{ id: 'p1', name: 'Sam', color: '#2E9E6B', kids: false }],
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
      if (e.level === 'error' || e.level === 3 || /Content Security Policy/i.test(e.message)) errors.push(e.message);
    });
    const js = (code) => win.webContents.executeJavaScript(code);
    const until = async (code, ms = 20000) => {
      for (let t = 0; t < ms; t += 200) {
        if (await js(code)) return true;
        await wait(200);
      }
      return false;
    };
    const media = (p) => 'app://couchbox/media/' + encodeURIComponent(p);
    const get = (url, headers = {}) => js(`fetch(${JSON.stringify(url)}, { headers: ${JSON.stringify(headers)} }).then(async (r) => ({ status: r.status, len: (await r.arrayBuffer()).byteLength, range: r.headers.get('content-range'), type: r.headers.get('content-type'), accept: r.headers.get('accept-ranges') })).catch((e) => ({ error: String(e) }))`);
    try {
      for (let i = 0; i < 100 && !win.isVisible(); i++) await wait(100);
      check('the page loads from app://couchbox/', /^app:\/\/couchbox\/renderer\/index\.html/.test(win.webContents.getURL()), win.webContents.getURL());
      await js(`document.querySelector('[data-pid="p1"]').click()`);
      await until(`S.model && S.model.films.length === 2 && S.model.films.every((f) => f.duration > 0)`, 30000);
      await wait(600);
      check('media addresses are app:// (no file: anywhere)', await js(`S.model.films.every((f) => f.video.startsWith('app://couchbox/media/')) && !JSON.stringify(S.model).includes('file:')`));

      // Byte ranges.
      const size = fs.statSync(mp4).size;
      const whole = await get(media(mp4));
      check('a whole file: 200, every byte, and it says ranges work', whole.status === 200 && whole.len === size && whole.accept === 'bytes' && whole.type === 'video/mp4', JSON.stringify(whole));
      const part = await get(media(mp4), { Range: 'bytes=1000-1999' });
      check('a range: 206 with exactly those bytes', part.status === 206 && part.len === 1000 && part.range === `bytes 1000-1999/${size}`, JSON.stringify(part));
      const open = await get(media(mp4), { Range: `bytes=${size - 300}-` });
      check('a range to the end: 206', open.status === 206 && open.len === 300, JSON.stringify(open));
      const tail = await get(media(mp4), { Range: 'bytes=-50' });
      check('the last bytes: 206', tail.status === 206 && tail.len === 50 && tail.range === `bytes ${size - 50}-${size - 1}/${size}`, JSON.stringify(tail));
      const past = await get(media(mp4), { Range: `bytes=${size + 10}-` });
      check('a range past the end: 416', past.status === 416, JSON.stringify(past));

      // Refused.
      const out = await get(media(outside));
      check('a file outside the video and data folders is refused', out.status === 404, JSON.stringify(out));
      const sneaky = await get(media(path.join(lib, '..', 'outside.txt')));
      check('...even through ..\\ in the path', sneaky.status === 404, JSON.stringify(sneaky));
      const lookalike = path.join(tmp, 'Videos2', 'x.txt');
      fs.mkdirSync(path.dirname(lookalike), { recursive: true });
      fs.writeFileSync(lookalike, 'x');
      check("...or a folder that only starts with the same name (Videos2)", (await get(media(lookalike))).status === 404);
      const climb = await get('app://couchbox/%2E%2E/%2E%2E/%2E%2E/outside.txt');
      check('climbing out of the app folder is refused', climb.status === 404, JSON.stringify(climb));
      const other = await get('app://other/renderer/index.html');
      check('another host is refused (the page may not even ask for it)', other.status === 404 || !!other.error, JSON.stringify(other));
      for (let i = errors.length - 1; i >= 0; i--) if (errors[i].includes('app://other/')) errors.splice(i, 1); // the refusal itself
      const dataFile = await get(media(path.join(process.env.COUCHBOX_DATA_DIR, 'couchbox-data.json')));
      check("Couchbox's data folder is served (thumbnails, posters, pictures)", dataFile.status === 200);

      // The real player: plays, seeks, scrub thumbnails, subtitles.
      await js(`playFile(S.model.films.find((f) => f.title === 'Night Train').id)`);
      check('the MP4 plays', await until(`(() => { const v = document.querySelector('#player video.main'); return v && !v.paused && v.currentTime > 0.5; })()`));
      await js(`document.querySelector('#player video.main').currentTime = 60`);
      check('seeking to 1:00 lands there and carries on playing', await until(`(() => { const v = document.querySelector('#player video.main'); return Math.abs(v.currentTime - 60) < 3 && v.readyState >= 3 && !v.seeking; })()`), String(await js(`document.querySelector('#player video.main').currentTime`)));
      await js(`document.querySelector('#player video.main').currentTime = 5`);
      check('...and back to 0:05', await until(`(() => { const v = document.querySelector('#player video.main'); return Math.abs(v.currentTime - 5) < 3 && !v.seeking; })()`));
      const scrubbed = await js(`new Promise((res) => { const s = document.querySelector('#player video.scrubber'); const t = setTimeout(() => res(false), 8000); s.addEventListener('seeked', () => { clearTimeout(t); res(Math.abs(s.currentTime - 45) < 2); }, { once: true }); s.currentTime = 45; })`);
      check('the scrub thumbnails seek too', scrubbed);
      await js(`document.querySelector('[data-p="subs-menu"]').click()`);
      await wait(400);
      await js(`(document.querySelector('[data-p="sub"][data-label]:not([data-label="off"])') || document.querySelector('[data-p="sub"]:last-child')).click()`);
      check('subtitles show', await until(`(document.querySelector('#player .p-subs') || {}).textContent.includes('Hello from the subtitles')`, 8000), await js(`(document.querySelector('#player .p-subs') || {}).textContent`));
      await js('Player.close()');
      await wait(500);
      await js(`playFile(S.model.films.find((f) => f.title === 'Fernhill').id)`);
      check('an MKV plays', await until(`(() => { const v = document.querySelector('#player video.main'); return v && !v.paused && v.currentTime > 0.5 && !v.error; })()`));
      await js('Player.close()');
      await wait(500);

      // A hover preview (previews are on in this check).
      await js(`showHover(document.querySelector('.row .card'))`);
      check('a hover preview plays', await until(`!!document.querySelector('#hovercard video.on')`, 10000));
      await js('hideHover()');

      check('no errors, and nothing broke the Content-Security-Policy', errors.length === 0, errors.join(' | '));
    } catch (e) {
      failed++;
      console.log('FAIL  ' + e.stack + (errors.length ? '\n  page errors: ' + errors.join(' | ') : ''));
    }
    console.log(`\n${failed ? failed + ' failed' : 'all passed'}`);
    app.exit(failed ? 1 : 0);
  });
});

require('../main.js');
