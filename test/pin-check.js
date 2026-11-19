// Profile PIN (profile lock). First the main-process rules on their own (src/main/pins.js):
// only a salted hash is stored, wrong tries mean a wait, and saving profiles is refused without
// the right PIN (a locked profile changed or deleted, a profile added or Kids turned off without
// a grown-up's PIN). Then the app itself: adding a PIN, the full-screen PIN when picking a
// profile (pad and keyboard, wrong PIN, Cancel), Settings asking every time, 5 wrong tries, the
// kids gap, Forgot PIN? (Windows Hello stood in for), Change and Remove PIN, a kids profile
// can't have one, and reopening from the tray stays on the profile.
// Usage: npx electron test/pin-check.js   (screenshots go to COUCHBOX_SNAP_OUT, or a temp folder)
const path = require('path');
const fs = require('fs');
const os = require('os');
const { app } = require('electron');
// The app:// scheme must be set up before the app is ready; main.js loads later here.
require('../src/main/app-protocol.js').registerScheme();
const { TEST_SETTINGS } = require('./quiet');

process.env.COUCHBOX_NO_LOGIN_ITEM = '1';
process.env.COUCHBOX_PIN_WAIT_MS = '3000'; // the 30-second wait, shortened (set before pins.js loads)
process.env.COUCHBOX_HELLO_STUB = 'ok';
const pinsLib = require('../src/main/pins');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'couchbox-pin-'));
const lib = path.join(tmp, 'Videos');
const dataDir = path.join(tmp, 'data');
const out = process.env.COUCHBOX_SNAP_OUT || path.join(tmp, 'snaps');
for (const d of [lib, dataDir, out]) fs.mkdirSync(d, { recursive: true });
process.env.COUCHBOX_DATA_DIR = dataDir;
const dataFile = path.join(dataDir, 'couchbox-data.json');
fs.writeFileSync(dataFile, JSON.stringify({
  settings: { libraryPath: lib, previews: false, ...TEST_SETTINGS },
  profiles: [
    { id: 'p1', name: 'Sam', color: '#2E9E6B', kids: false },
    { id: 'p2', name: 'Alex', color: '#3B82C4', kids: false },
    { id: 'p3', name: 'Kim', color: '#D9A21B', kids: true },
  ],
}));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const errors = [];
const check = (name, ok, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== '' ? '  -- ' + detail : ''}`);
};
const stored = () => JSON.parse(fs.readFileSync(dataFile, 'utf8'));

/* ---------- 1. the main-process rules on their own ---------- */
async function rules() {
  const store = { data: { profiles: [{ id: 'a', name: 'A', kids: false }, { id: 'b', name: 'B', kids: false }, { id: 'k', name: 'K', kids: true }] }, save() {} };
  let helloOk = true;
  const P = pinsLib.create({ store, hello: { verify: async () => (helloOk ? { ok: true } : { ok: false, error: 'no' }), kind: async () => 'hello' } });
  const r = P.set('a', '4821', null);
  check('[rules] a PIN is stored as a salted hash only', r.ok && store.data.profiles[0].pin && /^[0-9a-f]{64}$/.test(store.data.profiles[0].pin.hash) && !JSON.stringify(store.data).includes('4821'));
  check('[rules] the screens only see locked: true', JSON.stringify(P.publicProfiles()).indexOf('hash') < 0 && P.publicProfiles()[0].locked === true && P.publicProfiles()[1].locked === false);
  check('[rules] kids profiles can\'t have a PIN', !P.set('k', '1111', null).ok);
  check('[rules] a PIN is 4 numbers', !P.set('b', '12a4', null).ok && !P.set('b', '123', null).ok);
  check('[rules] changing a PIN needs the current one', !P.set('a', '1111', '0000').ok && P.set('a', '1111', '4821').ok && P.set('a', '4821', '1111').ok);

  // A fresh instance has no grants: the save guard refuses.
  const Q = pinsLib.create({ store, hello: { verify: async () => (helloOk ? { ok: true } : { ok: false }), kind: async () => 'hello' } });
  const list = () => store.data.profiles.map((p) => ({ ...p, pin: undefined, locked: !!p.pin }));
  const renamed = list().map((p) => (p.id === 'a' ? { ...p, name: 'A2' } : p));
  check('[rules] changing a locked profile without its PIN is refused', !!Q.guardSave(renamed).error);
  check('[rules] deleting a locked profile without its PIN is refused', !!Q.guardSave(list().filter((p) => p.id !== 'a')).error);
  check('[rules] adding a profile without a grown-up\'s PIN is refused', !!Q.guardSave([...list(), { id: 'n', name: 'N', kids: false }]).error);
  check('[rules] turning Kids off without a grown-up\'s PIN is refused', !!Q.guardSave(list().map((p) => (p.id === 'k' ? { ...p, kids: false } : p))).error);
  check('[rules] other profiles can still be changed', !Q.guardSave(list().map((p) => (p.id === 'b' ? { ...p, name: 'B2' } : p))).error);
  const kept = Q.guardSave(list().map((p) => (p.id === 'b' ? { ...p, name: 'B2' } : p)));
  check('[rules] saving keeps the stored PIN (the screens never send it)', kept.profiles.find((p) => p.id === 'a').pin === store.data.profiles[0].pin);
  check('[rules] a wrong PIN says how many tries are left', Q.check('a', '0000').left === 4);
  Q.check('a', '4821');
  check('[rules] with its PIN entered, the locked profile can be changed', !Q.guardSave(renamed).error);
  check('[rules] a locked profile turned into a kids profile loses its PIN', !Q.guardSave(list().map((p) => (p.id === 'a' ? { ...p, kids: true } : p))).profiles.find((p) => p.id === 'a').pin);
  check('[rules] a grown-up\'s PIN: any locked profile\'s', !Q.checkAny('9999').ok && Q.checkAny('4821').ok);
  check('[rules] ...then adding a profile and turning Kids off are allowed', !Q.guardSave([...list(), { id: 'n', name: 'N', kids: false }]).error && !Q.guardSave(list().map((p) => (p.id === 'k' ? { ...p, kids: false } : p))).error);

  // 5 wrong tries: a wait, enforced here (the right PIN is refused during it).
  const W = pinsLib.create({ store, hello: { verify: async () => (helloOk ? { ok: true } : { ok: false, error: 'no' }), kind: async () => 'hello' } });
  let last;
  for (let i = 0; i < 5; i++) last = W.check('a', '0000');
  check('[rules] 5 wrong tries in a row: a wait', last.wait > 0, JSON.stringify(last));
  check('[rules] ...during which even the right PIN is refused', !W.check('a', '4821').ok);
  await wait(3200);
  check('[rules] ...and after it, the right PIN works', W.check('a', '4821').ok);

  helloOk = false;
  check('[rules] Forgot PIN?: Windows says no, the PIN stays', !(await W.forgot('a', 'A')).ok && !!store.data.profiles[0].pin);
  helloOk = true;
  check('[rules] Forgot PIN?: Windows says yes, the PIN is removed', (await W.forgot('a', 'A')).ok && !store.data.profiles[0].pin);
}

/* ---------- 2. the app ---------- */
app.on('browser-window-created', (_e, win) => {
  win.webContents.once('did-finish-load', async () => {
    if (win.webContents.getURL().includes('splash.html')) return;
    win.webContents.on('console-message', (e) => {
      if (e.level === 'error' || e.level === 3) errors.push(e.message);
    });
    const js = (code) => win.webContents.executeJavaScript(code);
    const snap = async (name) => {
      await wait(400);
      fs.writeFileSync(path.join(out, name + '.png'), (await win.webContents.capturePage()).toPNG());
      console.log('snap', path.join(out, name + '.png'));
    };
    const click = (sel) => js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.click(); return true; })()`);
    const has = (sel) => js(`!!document.querySelector(${JSON.stringify(sel)})`);
    const text = (sel) => js(`(document.querySelector(${JSON.stringify(sel)}) || {}).textContent || ''`);
    // The on-screen number pad, or the keyboard.
    const pad = async (code) => {
      for (const d of code) {
        await click(`#pin-root [data-k="${d}"]`);
        await wait(60);
      }
      await wait(450);
    };
    const keys = async (code) => {
      for (const d of code) {
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode: d });
        win.webContents.sendInputEvent({ type: 'char', keyCode: d });
        win.webContents.sendInputEvent({ type: 'keyUp', keyCode: d });
        await wait(60);
      }
      await wait(450);
    };
    const profile = () => js(`S.profile ? S.profile.id : null`);
    const pick = (id) => click(`.profiles [data-pid="${id}"]`);
    try {
      for (let i = 0; i < 100 && !win.isVisible(); i++) await wait(100);
      await wait(600);

      // Add a PIN to Sam from Manage profiles (no PIN yet, so no PIN is asked to edit).
      await click('[data-act="toggle-manage"]');
      await wait(300);
      await pick('p1');
      await wait(400);
      check('the editor opens straight away for a profile without a PIN', await has('#pe-name'));
      check('grown-up profile: a Profile lock section with Add PIN', await has('#pe-pin-add'));
      await click('#pe-pin-add');
      await wait(300);
      check('Add PIN: choose a 4-number PIN', /Choose a 4-number PIN/.test(await text('#pin-root .pin-title')));
      await pad('1234');
      check('...then enter it again', /Enter it again/.test(await text('#pin-root .pin-title')));
      await pad('1243');
      check("...two different PINs don't match", /didn't match/.test(await text('#pin-root .pin-msg')));
      await pad('1234');
      await pad('1234');
      check('the PIN is added', !(await has('#pin-root .pin-window')) && (await has('#pe-pin-change')) && (await has('#pe-pin-remove')));
      const sam = stored().profiles.find((p) => p.id === 'p1');
      check('only a salted hash is stored, never the PIN', sam.pin && sam.pin.salt && sam.pin.hash && !fs.readFileSync(dataFile, 'utf8').includes('"1234"'));
      await snap('140-profile-lock-section');
      await click('#pe-cancel');
      await click('[data-act="toggle-manage"]');
      await wait(300);
      check("Who's watching: a padlock on Sam", await has('.profiles [data-pid="p1"] .lock'));
      check('...and not on the others', !(await has('.profiles [data-pid="p2"] .lock')) && !(await has('.profiles [data-pid="p3"] .lock')));

      // Picking Sam: full screen.
      await pick('p1');
      await wait(300);
      check('picking a locked profile asks for its PIN, full screen', await has('#pin-root .pin-screen'));
      await snap('141-pin-full-screen');
      await pad('9999');
      check('a wrong PIN shakes and clears', (await has('#pin-root .pin-boxes.shake')) && !(await has('#pin-root .pin-boxes span.on')) && /Wrong PIN/.test(await text('#pin-root .pin-msg')));
      await snap('142-pin-wrong');
      await click('#pin-root [data-pin="cancel"]');
      await wait(300);
      check("Cancel goes back to Who's watching", !(await has('#pin-root .pin-screen')) && (await profile()) === null);
      await pick('p1');
      await wait(300);
      await keys('1234');
      check("the keyboard's numbers work, and the right PIN opens the profile", (await profile()) === 'p1' && !(await has('#pin-root .pin-screen')));

      // Settings asks every time it opens (a smaller window), but not when switching its tabs.
      js(`openSettings()`);
      await wait(400);
      check('opening Settings asks for the PIN (a smaller window)', (await has('#pin-root .pin-window')) && !(await has('#modal-root .settings-dlg')));
      await snap('143-pin-settings');
      await click('#pin-root [data-pin="cancel"]');
      await wait(300);
      check('...Cancel: no Settings', !(await has('#modal-root .settings-dlg')));
      js(`openSettings()`);
      await wait(300);
      await pad('1234');
      check('...the right PIN opens Settings', await has('#modal-root .settings-dlg'));
      js(`openSettings(null, 'app')`);
      await wait(300);
      check("...switching Settings' tabs doesn't ask again", !(await has('#pin-root .pin-window')) && (await has('#modal-root .settings-dlg')));
      await js(`closeModal()`);
      js(`openSettings()`);
      await wait(300);
      check('...and it asks again the next time', await has('#pin-root .pin-window'));
      await click('#pin-root [data-pin="cancel"]');

      // 5 wrong tries.
      await click('[data-act="profile-menu"]');
      await wait(200);
      await click('#pmenu [data-act="switch-profile"]');
      await wait(300);
      await pick('p1');
      await wait(300);
      for (let i = 0; i < 5; i++) await pad('0000');
      check('5 wrong tries: a wait, with a countdown', /Too many tries\. Try again in \d/.test(await text('#pin-root .pin-msg')));
      const during = await js(`cb.pinCheck('p1', '1234')`);
      check('...enforced by Couchbox itself, not just the screen', !during.ok && during.wait > 0, JSON.stringify(during));
      await pad('1234');
      check('...numbers do nothing during the wait', (await profile()) === null);
      await wait(3200);
      await pad('1234');
      check('...after the wait the right PIN works', (await profile()) === 'p1');

      // The profile menu's switch to another profile asks too.
      await click('[data-act="profile-menu"]');
      await wait(200);
      await click('#pmenu [data-act="pick-profile"][data-pid="p2"]');
      await wait(300);
      check('switching from the profile menu to an unlocked profile needs no PIN', (await profile()) === 'p2');
      await click('[data-act="profile-menu"]');
      await wait(200);
      await click('#pmenu [data-act="pick-profile"][data-pid="p1"]');
      await wait(300);
      check('...to a locked one asks for its PIN', await has('#pin-root .pin-screen'));
      await pad('1234');

      // Editing or deleting a locked profile asks for its PIN.
      await click('[data-act="profile-menu"]');
      await wait(200);
      await click('#pmenu [data-act="manage-profiles"]');
      await wait(300);
      await pick('p1');
      await wait(300);
      check('editing a locked profile asks for its PIN', (await has('#pin-root .pin-screen')) && !(await has('#pe-name')));
      await click('#pin-root [data-pin="cancel"]');
      await wait(300);
      check('...Cancel: no editor', !(await has('#pe-name')));

      // The kids gap: from a kids profile, adding a profile or turning Kids off needs a grown-up's PIN.
      await click('[data-act="toggle-manage"]');
      await wait(300);
      await pick('p3');
      await wait(400);
      check('a kids profile opens without a PIN', (await profile()) === 'p3');
      await click('[data-act="profile-menu"]');
      await wait(200);
      await click('#pmenu [data-act="manage-profiles"]');
      await wait(300);
      await click('[data-act="add-profile"]');
      await wait(300);
      check("adding a profile asks for a grown-up's PIN", (await has('#pin-root .pin-screen .pin-av-lock')) && /grown-up/.test(await text('#pin-root .pin-title')));
      await snap('144-pin-grown-up');
      await pad('9999');
      check("...a PIN that isn't any profile's is wrong", /Wrong PIN/.test(await text('#pin-root .pin-msg')));
      await click('#pin-root [data-pin="cancel"]');
      await wait(300);
      check('...Cancel: no new profile', !(await has('#pe-name')));
      await click('[data-act="add-profile"]');
      await wait(300);
      await pad('1234');
      check("...a grown-up's PIN opens Add profile", /Add profile/.test(await text('#modal-root h2')));
      await click('#pe-cancel');
      await wait(200);
      await pick('p3');
      await wait(400);
      check("a kids profile's editor has no Profile lock", (await has('#pe-name')) && !(await has('.pe-lock')));
      await click('#pe-kids');
      await wait(200);
      await click('#pe-save');
      await wait(400);
      check("turning Kids off asks for a grown-up's PIN", await has('#pin-root .pin-window'));
      await click('#pin-root [data-pin="cancel"]');
      await wait(300);
      check('...Cancel: nothing saved, still a kids profile', stored().profiles.find((p) => p.id === 'p3').kids === true && (await has('#pe-name')));
      await click('#pe-cancel');
      await wait(200);

      // Forgot PIN? (Windows Hello stood in for).
      await click('[data-act="toggle-manage"]');
      await wait(300);
      process.env.COUCHBOX_HELLO_STUB = 'fail';
      await pick('p1');
      await wait(300);
      await click('#pin-root [data-pin="forgot"]');
      await wait(600);
      check("Forgot PIN?: if Windows can't confirm it's you, the PIN stays", /couldn't confirm/.test(await text('#pin-root .pin-msg')) && !!stored().profiles.find((p) => p.id === 'p1').pin);
      process.env.COUCHBOX_HELLO_STUB = 'ok';
      await click('#pin-root [data-pin="forgot"]');
      await wait(600);
      check('Forgot PIN?: when Windows confirms it, the PIN is removed', /PIN is removed/.test(await text('#pin-root .pin-msg')) && !stored().profiles.find((p) => p.id === 'p1').pin);
      check('...and it offers to set a new one', await has('#pin-root [data-after="new"]'));
      await snap('145-pin-forgot');
      await click('#pin-root [data-after="skip"]');
      await wait(400);
      check('...Not now opens the profile', (await profile()) === 'p1');

      // Change and Remove PIN.
      await click('[data-act="profile-menu"]');
      await wait(200);
      await click('#pmenu [data-act="manage-profiles"]');
      await wait(300);
      await pick('p1');
      await wait(400);
      await click('#pe-pin-add');
      await wait(200);
      await pad('2580');
      await pad('2580');
      await click('#pe-pin-change');
      await wait(300);
      check('Change PIN asks for the current one', /current PIN/.test(await text('#pin-root .pin-title')));
      await pad('2580');
      await pad('1111');
      await pad('1111');
      check('...then a new one: changed', (await js(`cb.pinCheck('p1', '1111')`)).ok);
      await click('#pe-pin-remove');
      await wait(300);
      await pad('1111');
      check('Remove PIN asks for the current one, then removes it', !stored().profiles.find((p) => p.id === 'p1').pin && (await has('#pe-pin-add')));
      await click('#pe-cancel');

      // Kids can't have a PIN (the main process refuses too).
      const kidsPin = await js(`cb.pinSet('p3', '1234', null)`);
      check("a kids profile can't have a PIN", !kidsPin.ok, JSON.stringify(kidsPin));

      // The tray: hidden and opened again, it stays on the profile.
      await js(`cb.pinSet('p1', '1234', null)`);
      await click('[data-act="toggle-manage"]');
      await wait(300);
      await js(`(async () => { const r = await cb.init(); Pin.syncProfiles(r.profiles); render(); })()`);
      await wait(300);
      await pick('p1');
      await wait(300);
      await pad('1234');
      win.close(); // hides to the tray
      await wait(600);
      global.__couchbox.bg.show();
      await wait(600);
      check('reopened from the tray, it stays on the profile (as chosen)', win.isVisible() && (await profile()) === 'p1' && !(await has('#pin-root .pin-screen')));

      check('no errors in the console', errors.length === 0, errors.join(' | '));
    } catch (e) {
      failed++;
      console.log('FAIL  ' + e.stack);
    }
    console.log(`\n${failed ? failed + ' failed' : 'all passed'}`);
    app.exit(failed ? 1 : 0);
  });
});

rules()
  .catch((e) => {
    failed++;
    console.log('FAIL  [rules] ' + e.stack);
  })
  .then(() => require('../main.js'));
