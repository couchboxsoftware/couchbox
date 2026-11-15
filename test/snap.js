// Screenshot test: runs the real app against a sample library and saves PNGs.
// Usage: set COUCHBOX_LIBRARY and COUCHBOX_SNAP_OUT, then: npx electron test/snap.js
const path = require('path');
const fs = require('fs');
const os = require('os');
const { app, BrowserWindow } = require('electron');

const out = process.env.COUCHBOX_SNAP_OUT;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'couchbox-test-'));
process.env.COUCHBOX_DATA_DIR = dataDir;
fs.writeFileSync(
  path.join(dataDir, 'couchbox-data.json'),
  JSON.stringify({
    settings: {
      libraryPath: process.env.COUCHBOX_LIBRARY,
      volume: 0.2,
      autoplayNext: true,
      previews: true,
      ...(process.env.COUCHBOX_FAKE_IMAGES ? { tmdbKey: 'test-key' } : {}),
      ...require('./quiet').TEST_SETTINGS,
    },
    profiles: [
      { id: 'p1', name: 'Sam', color: '#2E9E6B', kids: false },
      { id: 'p2', name: 'Alex', color: '#3B82C4', kids: false },
      { id: 'p3', name: 'Kids', color: '#C9A227', kids: true },
    ],
  })
);
fs.mkdirSync(out, { recursive: true });
const fake = process.env.COUCHBOX_FAKE_IMAGES ? require('./fake-tmdb') : null;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];

app.on('browser-window-created', (_e, win) => {
  win.setIgnoreMouseEvents(true);
  win.webContents.once('did-finish-load', () => {
    if (!win.webContents.getURL().includes('splash.html')) return;
    // Capture the splash at a few moments of its animation.
    const started = Date.now();
    console.log('splash loaded');
    [250, 700, 1300, 2100].forEach((ms, i) =>
      setTimeout(async () => {
        if (win.isDestroyed()) return;
        const img = await win.webContents.capturePage();
        fs.writeFileSync(path.join(out, `00-splash-${i + 1}.png`), img.toPNG());
        console.log('snap splash', i + 1, Date.now() - started + 'ms');
      }, ms)
    );
    win.on('closed', () => console.log('splash closed after', Date.now() - started + 'ms'));
  });
  if (win.getSize()[0] < 1000) return; // the splash: leave it alone
  win.setSize(1400, 860);
  win.webContents.on('console-message', (e) => {
    const lvl = e.level;
    if (lvl === 'error' || lvl === 'warning' || lvl === 3 || lvl === 2) errors.push(`[${lvl}] ${e.message}`);
  });
  win.webContents.once('did-finish-load', async () => {
    const js = (code) => win.webContents.executeJavaScript(code);
    const snap = async (name) => {
      await wait(400);
      const img = await win.webContents.capturePage();
      fs.writeFileSync(path.join(out, name + '.png'), img.toPNG());
      console.log('snap', name);
    };
    try {
      for (let i = 0; i < 60 && !win.isVisible(); i++) await wait(100);
      await wait(800);
      await snap('01-profiles');
      if (process.env.COUCHBOX_SNAP_QUICK) {
        await js(`document.querySelector('[data-pid="p1"]').click()`);
        await wait(2500);
        await snap('02-home');
        await js(`S.profile = null; render(); openProfileEditor(null)`);
        await snap('15-edit-profile');
        throw new Error('quick run done');
      }
      await js(`document.querySelector('[data-pid="p1"]').click()`);
      // Let the scan, probing and frame grabs finish.
      for (let i = 0; i < 40; i++) {
        await wait(500);
        if (await js(`document.getElementById('statuspill').hidden`)) break;
      }
      await wait(1500);
      await snap('02-home');
      await js(`(() => { const c = document.querySelector('.card[data-id^="series:the long coast"]'); showHover(c); })()`);
      await wait(2500);
      await snap('03-hover');
      await js(`hideHover(); openDetails('series:the long coast')`);
      await wait(800);
      await snap('04-details-series');
      await js(`closeModal(); playFile(S.model.series.find(s=>s.title==='The Long Coast').seasons[0].episodes[0].id)`);
      await wait(2500);
      await js(`(() => { const v = document.querySelector('#player video.main'); v.currentTime = 3; document.querySelector('[data-p="subs-menu"]').click(); })()`);
      await wait(600);
      await js(`document.querySelector('[data-p="sub"][data-label="Subtitles"]').click()`);
      await wait(1500);
      await js(`document.getElementById('player').dispatchEvent(new MouseEvent('mousemove', {bubbles:true}))`);
      await snap('05-player');
      await js(`document.querySelector('#player video.main').currentTime = 115`);
      await wait(1500);
      await js(`document.getElementById('player').dispatchEvent(new MouseEvent('mousemove', {bubbles:true}))`);
      await snap('06-player-next');
      await js(`document.querySelector('#player video.main').currentTime = 60`);
      await wait(1200);
      await js(`Player.close()`);
      await wait(800);
      await js(`document.getElementById('app').scrollTop = 0`);
      await snap('07-home-continue');
      await js(`(() => { const s = document.getElementById('search'); s.value = 'coast'; s.dispatchEvent(new Event('input')); })()`);
      await wait(700);
      await snap('08-search');
      await js(`(() => { const s = document.getElementById('search'); s.value = ''; s.dispatchEvent(new Event('input')); })()`);
      await wait(400);
      await js(`openDetails(S.model.films.find(f=>f.title==='Paper Moons').id)`);
      await wait(600);
      await snap('09-details-film');
      await js(`closeModal(); play(S.model.films.find(f=>f.title==='Paper Moons'))`);
      await wait(1000);
      // Automatic conversion is off in tests (it would rewrite the sample files), so the player
      // says this one needs converting. test/conversion-check.js covers the conversions.
      await snap('10-needs-converting');
      console.log('needs-converting screen:', await js(`document.querySelector('.p-overlay').innerText.split('\\n')[0]`));
      await js(`Player.close()`);
      await wait(500);
      await js(`openSettings()`);
      await snap('12-settings');
      await js(`closeModal(); openDetails(S.model.films.find(f=>f.title==='Night Train').id)`);
      await wait(300);
      await js(`document.querySelector('[data-act="kids-toggle"]').click()`);
      await wait(500);
      await js(`closeModal(); S.profile = null; render()`);
      await wait(300);
      await js(`document.querySelector('[data-pid="p3"]').click()`);
      await wait(1000);
      await snap('13-kids');
      console.log('kids sees:', await js(`visible().map(i=>i.title).join(', ')`));
      await js(`S.profile=null; S.managing=true; render()`);
      await wait(300);
      await snap('14-manage');
      await js(`openProfileEditor('p2')`);
      await snap('15-edit-profile');
    } catch (e) {
      console.error('SNAP FAILED', e);
    }
    if (fake) console.log('fake TMDB calls:', fake.calls.length, fake.calls.filter((c) => !c.includes('.jpg')).slice(0, 12));
    console.log('console errors/warnings:', errors.length ? '\n' + errors.join('\n') : 'none');
    app.quit();
  });
});

require('../main.js');
