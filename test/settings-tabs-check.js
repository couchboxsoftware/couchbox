// Settings tabs: Library, Find videos, Playback and App for grown-up profiles; only Playback and
// App for kids. Checks each setting is on the right tab and still saves, that Settings reopens on
// the last tab used, that a TMDB key problem shows on Library, and saves a screenshot of each tab.
// Usage: npx electron test/settings-tabs-check.js   (screenshots go to COUCHBOX_SNAP_OUT, or a temp folder)
const path = require('path');
const fs = require('fs');
const os = require('os');
const { app } = require('electron');
const { TEST_SETTINGS } = require('./quiet');

const lib = fs.mkdtempSync(path.join(os.tmpdir(), 'couchbox-tabs-lib-'));
fs.mkdirSync(path.join(lib, 'Films'), { recursive: true });
fs.writeFileSync(path.join(lib, 'Films', 'Night Train (2019).mp4'), '');
const out = process.env.COUCHBOX_SNAP_OUT || fs.mkdtempSync(path.join(os.tmpdir(), 'couchbox-tabs-snaps-'));
fs.mkdirSync(out, { recursive: true });
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'couchbox-tabs-'));
process.env.COUCHBOX_DATA_DIR = dataDir;
fs.writeFileSync(path.join(dataDir, 'couchbox-data.json'), JSON.stringify({
  settings: { libraryPath: lib, previews: false, autoplayNext: true, ...TEST_SETTINGS },
  profiles: [{ id: 'p1', name: 'Sam', color: '#2E9E6B', kids: false }, { id: 'p3', name: 'Kids', color: '#D9A21B', kids: true }],
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
      if (e.level === 'error' || e.level === 3) errors.push(e.message);
    });
    const js = (code) => win.webContents.executeJavaScript(code);
    const snap = async (name) => {
      await wait(350);
      fs.writeFileSync(path.join(out, name + '.png'), (await win.webContents.capturePage()).toPNG());
      console.log('snap', path.join(out, name + '.png'));
    };
    const tabs = () => js(`[...document.querySelectorAll('.stabs [role="tab"]')].map(b => b.textContent)`);
    const on = () => js(`(document.querySelector('.stabs .on') || {}).textContent`);
    const has = (sel) => js(`!!document.querySelector(${JSON.stringify(sel)})`);
    const clickTab = async (k) => {
      await js(`document.querySelector('.stabs [data-tab="${k}"]').click()`);
      await wait(400);
    };
    try {
      win.setSize(1400, 900);
      for (let i = 0; i < 100 && !win.isVisible(); i++) await wait(100);
      await js(`document.querySelector('[data-pid="p1"]').click()`);
      await wait(1200);

      // Grown-up profile, first open: Library.
      await js(`openSettings()`);
      await wait(400);
      check('four tabs: Library, Find videos, Playback, App', JSON.stringify(await tabs()) === JSON.stringify(['Library', 'Find videos', 'Playback', 'App']), JSON.stringify(await tabs()));
      check('first open is on Library', (await on()) === 'Library');
      check('Library: folder buttons and TMDB key', (await has('[data-act="choose-folder"]')) && (await has('[data-act="rescan"]')) && (await has('[data-act="open-folder"]')) && (await has('#set-key')));
      check('Library: nothing from the other tabs', !(await has('[data-setting]')) && !(await has('#set-sound-vol')) && !(await has('#settings-updates')));
      check('opening Settings fades in as usual', !(await has('.overlay.no-anim')));
      const left = () => js(`Math.round(document.querySelector('.settings-dlg').getBoundingClientRect().left)`);
      const lefts = [await left()];
      await snap('60-settings-library');

      await clickTab('playback');
      check('Playback tab selected', (await on()) === 'Playback');
      check('switching tabs doesn\'t replay the fade', await has('.overlay.no-anim'));
      lefts.push(await left());
      check('Playback: autoplay next episode and previews only', (await has('[data-setting="autoplayNext"]')) && (await has('[data-setting="previews"]')) && !(await has('#set-key')) && !(await has('[data-setting="openingSounds"]')));
      await snap('61-settings-playback');
      await js(`document.querySelector('[data-setting="autoplayNext"]').click()`);
      await wait(500);
      check('autoplay switch still saves', (await js('cb.init()')).settings.autoplayNext === false);

      await clickTab('app');
      check('App: opening sounds, click sounds for Sam, volume', (await has('[data-setting="openingSounds"]')) && (await has('#set-clicks')) && (await has('#set-sound-vol')) && /Click sounds for Sam/.test(await js(`document.querySelector('.dialog').innerText`)));
      check('App: the four "When Couchbox opens" choices, Window selected', await js(`document.querySelectorAll('input[name="open-mode"]').length === 4 && document.querySelector('input[name="open-mode"]:checked').value === 'window'`));
      check('App: Updates with the version number', /Version \d+\.\d+\.\d+/.test(await js(`document.getElementById('settings-updates').innerText`)));
      check('App: nothing from Library or Playback', !(await has('#set-key')) && !(await has('[data-setting="autoplayNext"]')));
      lefts.push(await left());
      check('the window stays in the same place on every tab (App is taller)', new Set(lefts).size === 1, lefts.join(', '));
      await snap('63-settings-app');
      await js(`document.getElementById('settings-updates').scrollIntoView({block:'center'})`);
      await snap('63b-settings-app-lower');
      await js(`(() => { const v = document.getElementById('set-sound-vol'); v.value = '0.3'; v.dispatchEvent(new Event('input')); })()`);
      await wait(800);
      check('volume slider still saves', (await js('cb.init()')).settings.soundVolume === 0.3);
      await js(`document.querySelector('input[name="open-mode"][value="maximized"]').click()`);
      await wait(500);
      check('open mode still saves', (await js('cb.init()')).settings.openMode === 'maximized');

      // Reopening remembers the tab.
      await js(`closeModal()`);
      await wait(300);
      await js(`document.querySelector('[data-act="profile-menu"]').click()`);
      await wait(300);
      await js(`document.querySelector('#pmenu [data-act="settings"]').click()`);
      await wait(400);
      check('Settings from the profile menu reopens on App (the last tab)', (await on()) === 'App');

      await clickTab('find');
      check('Find videos tab: the finder in the wide window', (await has('#finder-host')) && (await has('.dialog-wide')) && (await on()) === 'Find videos');
      await wait(600);
      check('Find videos: the no-key hint points to the Library tab', await js(`(() => { const t = document.getElementById('finder-host').innerText; return /Library tab/.test(t) && !/General/.test(t); })()`));
      await snap('62-settings-find');
      await js(`closeModal()`);
      await wait(300);
      await js(`openSettings()`);
      await wait(400);
      check('reopens on Find videos', (await on()) === 'Find videos');

      // A key problem shows on Library, whichever tab was open.
      await clickTab('app');
      await js(`openSettings('Paste a key first')`);
      await wait(300);
      check('a TMDB key message jumps to Library and shows there', (await on()) === 'Library' && /Paste a key first/.test(await js(`document.querySelector('.dialog .err').textContent`)));
      await js(`document.querySelector('[data-act="settings-save-key"]').click()`);
      await wait(400);
      check('Save with an empty key: message on Library', (await on()) === 'Library' && (await has('.dialog .err')));

      // Kids profile: Playback and App only.
      await js(`closeModal(); pickProfile('p3')`);
      await wait(1200);
      await js(`openSettings()`);
      await wait(400);
      check('kids: only Playback and App', JSON.stringify(await tabs()) === JSON.stringify(['Playback', 'App']), JSON.stringify(await tabs()));
      check('kids: last tab was Library, so it opens on Playback', (await on()) === 'Playback');
      check('kids: no folder buttons or TMDB key anywhere', !(await has('[data-act="choose-folder"]')) && !(await has('#set-key')));
      await snap('64-settings-kids');
      await js(`openSettings(null, 'library')`);
      await wait(300);
      check('kids: asking for Library still shows Playback', (await on()) === 'Playback' && !(await has('#set-key')));
      await js(`openSettings(null, 'find')`);
      await wait(300);
      check('kids: asking for Find videos still shows Playback', (await on()) === 'Playback' && !(await has('#finder-host')));
      await clickTab('app');
      check('kids: App has click sounds for Kids', /Click sounds for Kids/.test(await js(`document.querySelector('.dialog').innerText`)));
      await js(`closeModal()`);

      // Back to the grown-up: the last tab (App) is still allowed, so it opens there.
      await js(`pickProfile('p1')`);
      await wait(1200);
      await js(`openSettings()`);
      await wait(400);
      check('grown-up again: opens on App, the last tab used', (await on()) === 'App' && (await tabs()).length === 4);
      await js(`closeModal()`);
      check('no errors in the app', errors.length === 0, errors.join(' | '));
    } catch (e) {
      failed++;
      console.log('FAIL  ' + e.message);
    }
    console.log(`\n${failed ? failed + ' failed' : 'all passed'}`);
    fs.rmSync(lib, { recursive: true, force: true });
    app.exit(0);
  });
});

require('../main.js');
