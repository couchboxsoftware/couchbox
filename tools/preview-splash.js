// Preview only: renders renderer/splash.html over a stand-in desktop colour and saves
// a few frames to build/splash-preview-*.png. Does not touch the app.
// Run: npx electron tools/preview-splash.js
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow } = require('electron');
const appProtocol = require('../src/main/app-protocol'); // the splash loads through app://, as in the app
appProtocol.registerScheme();

app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  appProtocol.handle({ appRoot: path.join(__dirname, '..'), mediaRoots: () => [] });
  const win = new BrowserWindow({ width: 640, height: 360, show: false, frame: false, useContentSize: true, webPreferences: { offscreen: true } });
  win.webContents.setFrameRate(30);
  await new Promise((resolve) => {
    win.webContents.once('did-finish-load', resolve);
    win.loadURL(appProtocol.pageUrl('renderer/splash.html')).catch(() => {});
  });
  await win.webContents.executeJavaScript(`document.documentElement.style.background = '#3d5168'`);
  const shots = [[450, 'a'], [1300, 'b'], [3200, 'c']];
  let last = 0;
  for (const [ms, name] of shots) {
    await new Promise((r) => setTimeout(r, ms - last));
    last = ms;
    if (name === 'c') {
      await win.webContents.executeJavaScript('step(); step(); step()');
      await new Promise((r) => setTimeout(r, 500));
    }
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(__dirname, '..', 'build', `splash-preview-${name}.png`), img.resize({ width: 640 }).toPNG());
  }
  console.log('splash previews written');
  app.quit();
});
