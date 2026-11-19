// Preview only: records renderer/splash.html playing (with fake loading steps) to
// build/splash-preview.mp4 and build/splash-preview.gif. Does not touch the app.
// Run: node_modules\electron\dist\electron.exe tools/record-splash.js
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const { app, BrowserWindow } = require('electron');
const appProtocol = require('../src/main/app-protocol'); // the splash loads through app://, as in the app
appProtocol.registerScheme();
const ffmpeg = require('ffmpeg-static');

const FPS = 30;
const SECONDS = 8;
const build = path.join(__dirname, '..', 'build');
const frames = fs.mkdtempSync(path.join(os.tmpdir(), 'couchbox-frames-'));

app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  appProtocol.handle({ appRoot: path.join(__dirname, '..'), mediaRoots: () => [] });
  const win = new BrowserWindow({ width: 640, height: 360, show: false, frame: false, useContentSize: true, webPreferences: { offscreen: true } });
  win.webContents.setFrameRate(FPS);
  // Paint the stand-in desktop colour before the page's own animations start.
  win.webContents.on('dom-ready', () => win.webContents.insertCSS('html{background:#3d5168 !important}'));

  let latest = null;
  win.webContents.on('paint', (_e, _dirty, img) => { latest = img; });
  await new Promise((resolve) => {
    win.webContents.once('did-finish-load', resolve);
    win.loadURL(appProtocol.pageUrl('renderer/splash.html')).catch(() => {});
  });

  // Sample at a fixed rate so the clip plays at real speed; fake the app's loading steps.
  const steps = { 900: 1, 1700: 1, 2400: 1, 3100: 1, 3700: 'finish' };
  const total = FPS * SECONDS;
  const start = Date.now();
  for (let i = 0; i < total; i++) {
    const due = start + (i * 1000) / FPS;
    await new Promise((r) => setTimeout(r, Math.max(0, due - Date.now())));
    const ms = i * (1000 / FPS);
    for (const k of Object.keys(steps)) {
      if (ms >= +k && steps[k] !== null) {
        win.webContents.executeJavaScript(steps[k] === 'finish' ? 'finish()' : 'step()');
        steps[k] = null;
      }
    }
    if (latest) fs.writeFileSync(path.join(frames, `f${String(i).padStart(4, '0')}.png`), latest.resize({ width: 640 }).toPNG());
  }
  win.destroy();

  // Fill any frames that were skipped before the first paint with the next one.
  const names = fs.readdirSync(frames).sort();
  for (let i = 0, j = 0; i < total; i++) {
    const n = `f${String(i).padStart(4, '0')}.png`;
    if (!fs.existsSync(path.join(frames, n))) fs.copyFileSync(path.join(frames, names[Math.min(j, names.length - 1)]), path.join(frames, n));
    else j = names.indexOf(n) + 1;
  }

  const input = ['-y', '-framerate', String(FPS), '-i', path.join(frames, 'f%04d.png')];
  execFileSync(ffmpeg, [...input, '-vf', 'crop=640:360:0:0', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', path.join(build, 'splash-preview.mp4')], { stdio: 'ignore' });
  execFileSync(ffmpeg, [...input, '-vf', 'fps=20,scale=480:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer:bayer_scale=4', path.join(build, 'splash-preview.gif')], { stdio: 'ignore' });
  fs.rmSync(frames, { recursive: true, force: true });
  console.log('splash recording written');
  app.quit();
}).catch((err) => { console.error(err.message); app.exit(1); });
