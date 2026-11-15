// Update test: serves a built installer from a local stand-in "release" server, runs the app
// against it, and walks through the update banner. It stops just before installing, so nothing
// gets installed on this computer.
//
// Usage: set COUCHBOX_UPDATE_DIR (a dist folder holding latest.yml + the Setup exe),
// COUCHBOX_LIBRARY and COUCHBOX_SNAP_OUT, then: npx electron test/update-check.js
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { app } = require('electron');

const dir = process.env.COUCHBOX_UPDATE_DIR;
const out = process.env.COUCHBOX_SNAP_OUT;
// Pretend the served installer is a newer release (default: one patch above the app).
const FAKE_VERSION = process.env.COUCHBOX_FAKE_VERSION || require('../package.json').version.replace(/\d+$/, (n) => +n + 1);
fs.mkdirSync(out, { recursive: true });

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'couchbox-upd-'));
process.env.COUCHBOX_DATA_DIR = dataDir;
// COUCHBOX_UPDATE_WAIT=1: a conversion is running when the update finishes downloading, so it
// must wait ("Will update when conversions finish") and install once the conversion is done.
const WAIT = !!process.env.COUCHBOX_UPDATE_WAIT;
let library = process.env.COUCHBOX_LIBRARY;
if (WAIT) {
  library = fs.mkdtempSync(path.join(os.tmpdir(), 'couchbox-upd-lib-'));
  fs.mkdirSync(path.join(library, 'Films'));
  const f = path.join(library, 'Films', 'Long Haul (2001).mkv');
  require('child_process').spawnSync(require('ffmpeg-static'), ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25:duration=20', '-f', 'lavfi', '-i', 'sine=duration=20',
    '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'eac3', f]);
  const t = new Date(Date.now() - 3600e3);
  fs.utimesSync(f, t, t);
  process.env.COUCHBOX_CONV_RATE = '0.4'; // about 50 seconds
}
fs.writeFileSync(path.join(dataDir, 'couchbox-data.json'), JSON.stringify({
  settings: { libraryPath: library, ...require('./quiet').TEST_SETTINGS, ...(WAIT ? { autoConvert: true } : {}) },
  profiles: [{ id: 'p1', name: 'Sam', color: '#2E9E6B', kids: false }],
}));

const served = [];
const server = http.createServer((req, res) => {
  const name = decodeURIComponent(req.url.split('?')[0].replace(/^\//, ''));
  served.push(name);
  const file = path.join(dir, name);
  if (name === 'latest.yml') {
    let yml = fs.readFileSync(file, 'utf8').replace(/^version: .*$/m, `version: ${FAKE_VERSION}`);
    if (!/^releaseNotes:/m.test(yml)) yml += `releaseNotes: "Faster start-up and a new update banner."\n`;
    res.writeHead(200, { 'Content-Type': 'text/yaml' });
    return res.end(yml);
  }
  if (!name || !fs.existsSync(file)) {
    res.writeHead(404);
    return res.end();
  }
  // Throttle to roughly 40 MB/s so the progress bar has time to show.
  const size = fs.statSync(file).size;
  res.writeHead(200, { 'Content-Length': size, 'Content-Type': 'application/octet-stream' });
  const stream = fs.createReadStream(file, { highWaterMark: 1 << 20 });
  stream.on('data', (chunk) => {
    stream.pause();
    res.write(chunk, () => setTimeout(() => stream.resume(), 25));
  });
  stream.on('end', () => res.end());
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];
let installCalls = 0;

server.listen(0, '127.0.0.1', () => {
  process.env.COUCHBOX_UPDATE_URL = `http://127.0.0.1:${server.address().port}/`;

  app.on('browser-window-created', (_e, win) => {
    // Swap the real "install and restart" for a recorder, so nothing gets installed here.
    const { autoUpdater } = require('electron-updater');
    autoUpdater.quitAndInstall = (...args) => { installCalls++; console.log('quitAndInstall called with', JSON.stringify(args)); };
    if (!autoUpdater.__logged) {
      autoUpdater.__logged = true;
      for (const ev of ['checking-for-update', 'update-available', 'update-not-available', 'update-downloaded', 'error'])
        autoUpdater.on(ev, (x) => console.log('[updater]', ev, ev === 'error' ? String(x && x.message).split('\n')[0] : x && x.version ? x.version : ''));
    }

    win.webContents.once('did-finish-load', async () => {
      if (win.webContents.getURL().includes('splash.html')) return;
      win.setSize(1400, 860);
      win.webContents.on('console-message', (e) => {
        if (e.level === 'error' || e.level === 'warning' || e.level === 3 || e.level === 2) errors.push(e.message);
      });
      const js = (code) => win.webContents.executeJavaScript(code);
      const snap = async (name) => {
        await wait(450);
        fs.writeFileSync(path.join(out, name + '.png'), (await win.webContents.capturePage()).toPNG());
        console.log('snap', name);
      };
      const until = async (label, code, ms = 30000) => {
        for (let t = 0; t < ms; t += 250) {
          if (await js(code)) return;
          await wait(250);
        }
        throw new Error('timed out waiting for ' + label);
      };
      try {
        for (let i = 0; i < 100 && !win.isVisible(); i++) await wait(100);
        await until('update banner', `!document.getElementById('update-banner').hidden`);
        console.log('banner says:', await js(`document.getElementById('update-banner').innerText.replace(/\\s+/g,' ')`));
        await snap('20-update-available');

        await js(`document.querySelector('[data-ub="later"]').click()`);
        await wait(200);
        console.log('after Later, banner hidden:', await js(`document.getElementById('update-banner').hidden`));

        await js(`openSettings(null, 'app')`);
        await js(`document.getElementById('settings-updates').scrollIntoView({block:'center'})`);
        await snap('23-settings-updates');
        await js(`document.querySelector('#settings-updates [data-ub="now"]').click(); closeModal()`);
        await until('download progress', `/Downloading/.test(document.getElementById('update-banner').innerText)`);
        await wait(1200);
        console.log('banner says:', await js(`document.getElementById('update-banner').innerText.replace(/\\s+/g,' ')`));
        await snap('21-update-downloading');

        if (WAIT) {
          await until('waiting for conversions', `/Will update when conversions finish/.test(document.getElementById('update-banner').innerText)`, 120000);
          await snap('24-update-waiting');
          console.log('waiting banner shown; conversions running:', global.__couchbox.converter.running.size, '; install so far:', installCalls);
          await wait(3000);
          console.log('still waiting after 3 s:', installCalls === 0 ? 'yes' : 'NO');
          await until('conversion done', `!document.querySelector('#update-banner') || /Restarting/.test(document.getElementById('update-banner').innerText)`, 180000);
          console.log('conversions running when it installed:', global.__couchbox.converter.running.size);
        }
        await until('download finished', `/Restarting/.test(document.getElementById('update-banner').innerText)`, 120000);
        await snap('22-update-ready');
        await wait(1800);
        console.log('install would run:', installCalls === 1 ? 'yes' : 'NO (' + installCalls + ')');
      } catch (e) {
        console.error('UPDATE TEST FAILED', e.message);
        console.log('banner now:', await js(`document.getElementById('update-banner').innerText`).catch(() => '?'));
      }
      console.log('files requested:', [...new Set(served)].join(', '));
      console.log('console errors/warnings:', errors.length ? '\n' + errors.join('\n') : 'none');
      server.close();
      app.exit(0);
    });
  });

  require('../main.js');
});
