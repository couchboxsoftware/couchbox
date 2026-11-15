// Sounds and "When Couchbox opens" test. Runs one app launch per call, driven by SW_STEP:
//   sounds-on    opening sounds on: organ on the splash, bloom on show, clicks per profile,
//                no clicks in the player, Settings controls (and a screenshot)
//   sounds-off   opening sounds off: no organ, no bloom
//   mode:<m>     open with openMode <m> and check the window; SW_ACT then changes the window
//                before quitting (maximize | fullscreen | bounds) so 'remember' can be checked next
// The app is muted throughout (test/quiet.js); the tests read which sounds were played instead.
// Usage: set SW_DATA (a data folder kept between calls), SW_FRESH=1 on the first call,
// COUCHBOX_LIBRARY and COUCHBOX_SNAP_OUT, then: npx electron test/sound-window-check.js
const path = require('path');
const fs = require('fs');
const { app } = require('electron');
require('./quiet');

const step = process.env.SW_STEP;
const act = process.env.SW_ACT || '';
const dataDir = process.env.SW_DATA;
const out = process.env.COUCHBOX_SNAP_OUT;
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(out, { recursive: true });
process.env.COUCHBOX_DATA_DIR = dataDir;
const file = path.join(dataDir, 'couchbox-data.json');
const data = process.env.SW_FRESH === '1' || !fs.existsSync(file) ? {
  settings: { libraryPath: process.env.COUCHBOX_LIBRARY, previews: false, autoConvert: false }, // never rewrite the sample videos
  profiles: [{ id: 'p1', name: 'Sam', color: '#2E9E6B', kids: false }, { id: 'p2', name: 'Alex', color: '#3B82C4', kids: false, clicks: false }],
} : JSON.parse(fs.readFileSync(file, 'utf8'));
if (step === 'sounds-on') Object.assign(data.settings, { openingSounds: true, soundVolume: 0.5, openMode: 'window' });
if (step === 'sounds-off') Object.assign(data.settings, { openingSounds: false, openMode: 'window' });
if (step.startsWith('mode:')) Object.assign(data.settings, { openMode: step.slice(5), openingSounds: false });
fs.writeFileSync(file, JSON.stringify(data));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  [${step}] ${name}${detail !== '' ? '  -- ' + detail : ''}`);
};
let splashPlayed = null;

app.on('browser-window-created', (_e, win) => {
  win.webContents.once('did-finish-load', async () => {
    const js = (code) => win.webContents.executeJavaScript(code);
    if (win.webContents.getURL().includes('splash.html')) {
      await wait(700);
      splashPlayed = await js('Sounds.played.slice()').catch(() => []);
      return;
    }
    const until = async (label, code, ms = 30000) => {
      for (let t = 0; t < ms; t += 200) {
        if (await js(code)) return;
        await wait(200);
      }
      throw new Error('timed out waiting for ' + label);
    };
    try {
      for (let i = 0; i < 100 && !win.isVisible(); i++) await wait(100);
      await wait(1500);
      const played = () => js('Sounds.played.slice()');
      const taps = async () => (await played()).filter((n) => n === 'tap').length;

      if (step === 'sounds-on' || step === 'sounds-off') {
        const on = step === 'sounds-on';
        check(on ? 'organ plays on the splash' : 'no organ on the splash', on ? (splashPlayed || []).includes('organ') : !(splashPlayed || []).includes('organ'), JSON.stringify(splashPlayed));
        check(on ? 'bloom plays when the window appears' : 'no bloom when the window appears', on === (await played()).includes('bloom'), JSON.stringify(await played()));
      }

      if (step === 'sounds-on') {
        // Profile screen: uses the last profile's setting (none yet -> on).
        let n = await taps();
        await js(`document.querySelector('[data-pid="p1"]').click()`);
        await wait(600);
        check('click on a profile plays a tap', (await taps()) === n + 1);
        await until('library', `document.getElementById('statuspill').hidden && S.model.films.length > 0`, 60000);
        n = await taps();
        await js(`document.querySelector('[data-act="tab"][data-tab="films"]').click()`);
        await wait(300);
        check('click on a tab plays a tap (Sam: clicks on)', (await taps()) === n + 1);
        n = await taps();
        await js(`document.querySelector('.card').click()`);
        await wait(500);
        check('opening a title plays a tap', (await taps()) === n + 1);
        n = await taps();
        await js(`document.querySelector('[data-act="list"]') && document.querySelector('[data-act="list"]').click()`);
        await wait(400);
        check('My list button plays a tap', (await taps()) === n + 1);
        n = await taps();
        await js(`document.querySelector('.details [data-act="play"], [data-act="play"]').click()`);
        await wait(1500);
        check('pressing Play plays a tap', (await taps()) === n + 1);
        n = await taps();
        await js(`document.querySelector('#player [data-p="toggle"]').click(); document.querySelector('#player [data-p="toggle"]').click()`);
        await wait(300);
        check('no taps inside the player', (await taps()) === n);
        await js(`Player.close(); closeModal()`);
        await wait(500);

        // Settings, App tab: the Sounds and "When Couchbox opens" sections.
        await js(`openSettings(null, 'app')`);
        await wait(500);
        check('Settings has Opening sounds, Click sounds for Sam and Volume', await js(`!!document.querySelector('[data-setting="openingSounds"]') && /Click sounds for Sam/.test(document.querySelector('.dialog').innerText) && !!document.getElementById('set-sound-vol')`));
        check('Settings has the four "When Couchbox opens" choices, Window selected', await js(`document.querySelectorAll('input[name="open-mode"]').length === 4 && document.querySelector('input[name="open-mode"]:checked').value === 'window'`));
        await js(`document.querySelector('#set-sound-vol').scrollIntoView({block:'center'})`);
        await wait(300);
        fs.writeFileSync(path.join(out, '50-settings-sounds.png'), (await win.webContents.capturePage()).toPNG());
        console.log('snap 50-settings-sounds');
        await js(`(() => { const v = document.getElementById('set-sound-vol'); v.value = '0.3'; v.dispatchEvent(new Event('input')); })()`);
        await wait(800);
        check('volume slider saves the new level', (await js('cb.init()')).settings.soundVolume === 0.3);
        // Turn Sam's clicks off: no more taps for Sam.
        await js(`document.getElementById('set-clicks').click()`);
        await wait(600);
        await js(`closeModal()`);
        n = await taps();
        await js(`document.querySelector('[data-act="tab"][data-tab="series"]').click()`);
        await wait(300);
        check('Sam with clicks off: no tap', (await taps()) === n);
        check('Sam\'s click setting saved on the profile', (await js('cb.init()')).profiles.find((p) => p.id === 'p1').clicks === false);
        // Alex has clicks off from the start, Sam now too; turn Alex on and check per-profile.
        await js(`pickProfile('p2')`);
        await wait(1000);
        await js(`openSettings(null, 'app')`);
        await wait(400);
        await js(`document.getElementById('set-clicks').click()`);
        await wait(600);
        await js(`closeModal()`);
        n = await taps();
        await js(`document.querySelector('[data-act="tab"][data-tab="films"]').click()`);
        await wait(300);
        check('Alex with clicks on: tap (each profile has its own setting)', (await taps()) === n + 1);
        // Opening sounds switch saves.
        await js(`openSettings(null, 'app')`);
        await wait(400);
        await js(`document.querySelector('[data-setting="openingSounds"]').click()`);
        await wait(500);
        check('Opening sounds switch saves', (await js('cb.init()')).settings.openingSounds === false);
        // Choosing an open mode saves.
        await js(`document.querySelector('input[name="open-mode"][value="maximized"]').click()`);
        await wait(500);
        check('choosing "Maximised" saves', (await js('cb.init()')).settings.openMode === 'maximized');
      }

      if (step.startsWith('mode:')) {
        const mode = step.slice(5);
        const expect = process.env.SW_EXPECT || mode;
        const [w, h] = win.getSize();
        const state = win.isFullScreen() ? 'fullscreen' : win.isMaximized() ? 'maximized' : `window ${w}x${h} at ${win.getPosition().join(',')}`;
        // "window WxH" or "window WxH at X,Y": allow a few pixels for Windows display scaling.
        const near = (a, b) => Math.abs(a - b) <= 10;
        let ok = state === expect;
        const m = expect.match(/^window (\d+)x(\d+)(?: at (-?\d+),(-?\d+))?/);
        if (m && !win.isFullScreen() && !win.isMaximized()) {
          const [x, y] = win.getPosition();
          ok = near(w, +m[1]) && near(h, +m[2]) && (m[3] == null || (near(x, +m[3]) && near(y, +m[4])));
        }
        check(`opens as expected (${expect})`, ok, state);
        console.log(`[${step}] saved bounds were ${JSON.stringify((data.settings.windowState || {}).bounds || null)}`);
        if (act === 'maximize') {
          if (win.isFullScreen()) win.setFullScreen(false);
          await wait(1200);
          win.maximize();
        }
        if (act === 'fullscreen') win.setFullScreen(true);
        if (act === 'bounds') {
          if (win.isFullScreen()) win.setFullScreen(false);
          await wait(1200);
          if (win.isMaximized()) win.unmaximize();
          await wait(600);
          win.setBounds({ x: 140, y: 90, width: 1100, height: 700 });
        }
        await wait(1500);
      }
    } catch (e) {
      console.log(`FAIL  [${step}] ${e.message}`);
      results.push(false);
    }
    console.log(`[${step}] ${results.filter(Boolean).length} passed, ${results.filter((r) => !r).length} failed`);
    app.quit(); // a real quit, so the window's state is saved like it would be for a person
  });
});

require('../main.js');
