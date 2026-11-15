// Real-mouse test of the first-run profile dialog (scripted clicks bypass Windows'
// drag-region hit testing, so this one waits for genuine OS clicks).
// Writes target coordinates to COUCHBOX_CLICK_OUT/coords.json, then result.json.
const path = require('path');
const fs = require('fs');
const os = require('os');
const { app } = require('electron');

const out = process.env.COUCHBOX_CLICK_OUT;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'couchbox-click-'));
process.env.COUCHBOX_DATA_DIR = dataDir;
fs.writeFileSync(path.join(dataDir, 'couchbox-data.json'), JSON.stringify({ settings: { libraryPath: process.env.COUCHBOX_LIBRARY, ...require('./quiet').TEST_SETTINGS }, profiles: [] }));
fs.mkdirSync(out, { recursive: true });

app.on('browser-window-created', (_e, win) => {
  if (win.getSize()[0] < 1000) return; // splash
  win.setBounds({ x: 120, y: 80, width: 1200, height: 800 });
  win.setAlwaysOnTop(true);
  win.webContents.once('did-finish-load', async () => {
    const js = (c) => win.webContents.executeJavaScript(c);
    for (let i = 0; i < 80 && !win.isVisible(); i++) await new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 800));
    win.focus();
    const rects = JSON.parse(
      await js(`JSON.stringify(Object.fromEntries([['swatch', document.querySelectorAll('.swatch')[2]], ['name', document.getElementById('pe-name')], ['save', document.getElementById('pe-save')]].map(([k, el]) => { const r = el.getBoundingClientRect(); return [k, { x: r.left + r.width / 2, y: r.top + r.height / 2 }]; })))`)
    );
    const cb = win.getContentBounds();
    const coords = Object.fromEntries(Object.entries(rects).map(([k, p]) => [k, { x: Math.round(cb.x + p.x), y: Math.round(cb.y + p.y) }]));
    fs.writeFileSync(path.join(out, 'coords.json'), JSON.stringify(coords));
    const started = Date.now();
    let colour = null;
    while (Date.now() - started < 25000) {
      await new Promise((r) => setTimeout(r, 300));
      const state = JSON.parse(await js(`JSON.stringify({ colour: (document.querySelector('.swatch.on') || {}).dataset?.colour || null, profiles: S.profiles.map(p => ({ name: p.name, color: p.color })), screen: S.profile ? 'browse' : 'profiles' })`));
      if (state.colour) colour = state.colour;
      if (state.profiles.length) {
        fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ ok: true, lastSwatch: colour, ...state }));
        return app.quit();
      }
    }
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ ok: false, lastSwatch: colour }));
    app.quit();
  });
});

require('../main.js');
