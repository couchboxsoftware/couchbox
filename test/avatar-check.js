// Profile picture test: the cropper (move, resize from corners, stays square and inside, rotate),
// saving a 200 x 200 picture of the chosen part, Cancel, Remove, deleting a profile, and the
// picture showing in every avatar spot. The file picker is replaced by a stand-in that returns
// test pictures from AVATAR_TEST (wide.png: red | blue, tall.png: green over yellow,
// small.png, photo.jpg, bad.jpg).
// Usage: set AVATAR_TEST, COUCHBOX_LIBRARY and COUCHBOX_SNAP_OUT, then: npx electron test/avatar-check.js
const path = require('path');
const fs = require('fs');
const os = require('os');
const electron = require('electron');
const { app } = electron;
const { TEST_SETTINGS } = require('./quiet');

const T = process.env.AVATAR_TEST;
const out = process.env.COUCHBOX_SNAP_OUT;
fs.mkdirSync(out, { recursive: true });
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'couchbox-avatar-'));
process.env.COUCHBOX_DATA_DIR = dataDir;
const avatars = path.join(dataDir, 'avatars');
fs.writeFileSync(path.join(dataDir, 'couchbox-data.json'), JSON.stringify({
  settings: { libraryPath: process.env.COUCHBOX_LIBRARY, previews: false, ...TEST_SETTINGS },
  profiles: [{ id: 'p1', name: 'Sam', color: '#2E9E6B', kids: false }, { id: 'p2', name: 'Alex', color: '#3B82C4', kids: false }],
}));
let nextPick = null;
electron.dialog.showOpenDialog = async () => (nextPick ? { canceled: false, filePaths: [path.join(T, nextPick)] } : { canceled: true, filePaths: [] });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const errors = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== '' ? '  -- ' + detail : ''}`);
};
const files = () => (fs.existsSync(avatars) ? fs.readdirSync(avatars) : []);
const data = () => JSON.parse(fs.readFileSync(path.join(dataDir, 'couchbox-data.json'), 'utf8'));

app.on('browser-window-created', (_e, win) => {
  win.webContents.once('did-finish-load', async () => {
    if (win.webContents.getURL().includes('splash.html')) return;
    win.setSize(1400, 900);
    win.webContents.on('console-message', (e) => {
      if (e.level === 'error' || e.level === 'warning' || e.level === 3 || e.level === 2) errors.push(e.message);
    });
    const js = (code) => win.webContents.executeJavaScript(code);
    const snap = async (name) => {
      await wait(350);
      fs.writeFileSync(path.join(out, name + '.png'), (await win.webContents.capturePage()).toPNG());
      console.log('snap', name);
    };
    const until = async (label, code, ms = 10000) => {
      for (let t = 0; t < ms; t += 100) {
        if (await js(code)) return;
        await wait(100);
      }
      throw new Error('timed out waiting for ' + label);
    };
    const box = () => js('Cropper.state()');
    // Drag on the cropper canvas, in picture pixels (converted to screen points).
    const drag = (from, to) =>
      js(`(() => {
        const cv = document.getElementById('crop-cv'), r = cv.getBoundingClientRect(), k = Cropper.state().k;
        const ev = (type, p) => cv.dispatchEvent(new PointerEvent(type, { clientX: r.left + p[0] * k, clientY: r.top + p[1] * k, pointerId: 1, bubbles: true, button: 0, buttons: 1 }));
        ev('pointerdown', ${JSON.stringify(from)}); ev('pointermove', [${from[0]} + (${to[0]} - ${from[0]}) / 2, ${from[1]} + (${to[1]} - ${from[1]}) / 2]); ev('pointermove', ${JSON.stringify(to)}); ev('pointerup', ${JSON.stringify(to)});
      })()`);
    const openCropper = async (file) => {
      nextPick = file;
      await js(`document.getElementById('pe-choose').click()`);
      await until('cropper', `!!document.getElementById('crop-cv') && !!Cropper.state()`);
      await wait(200);
    };
    // Centre pixel colour of a saved picture, and its size.
    const inspect = (file) =>
      js(`new Promise((res) => { const i = new Image(); i.onload = () => { const c = document.createElement('canvas'); c.width = i.naturalWidth; c.height = i.naturalHeight; const x = c.getContext('2d'); x.drawImage(i, 0, 0); const d = x.getImageData(c.width / 2, c.height / 2, 1, 1).data; res({ w: i.naturalWidth, h: i.naturalHeight, rgb: [d[0], d[1], d[2]] }); }; i.onerror = () => res(null); i.src = S.avatarBase + ${JSON.stringify(encodeURIComponent(file))} + '?t=' + Date.now(); })`);
    const near = (a, b, tol = 2) => Math.abs(a - b) <= tol;
    try {
      for (let i = 0; i < 100 && !win.isVisible(); i++) await wait(100);
      await wait(800);
      await js(`document.querySelector('[data-pid="p1"]').click()`);
      await wait(1200);

      // --- the cropper ---
      await js(`openProfileEditor('p1')`);
      await openCropper('wide.png');
      let b = await box();
      check('wide picture: starts with the largest centred square', b.W === 1600 && b.H === 800 && near(b.box.x, 400) && b.box.y === 0 && b.box.s === 800, JSON.stringify(b.box));
      await snap('60-cropper');
      await drag([800, 400], [100, 400]);
      b = await box();
      check('dragging moves the square, and it stops at the edge', near(b.box.x, 0) && b.box.y === 0 && b.box.s === 800, JSON.stringify(b.box));
      await drag([800, 800], [400, 300]);
      b = await box();
      check('bottom-right corner resizes (top-left stays put), still square', near(b.box.x, 0) && near(b.box.y, 0) && near(b.box.s, 400, 3), JSON.stringify(b.box));
      await drag([400, 400], [2000, 2000]);
      b = await box();
      check('can\'t grow past the picture: biggest is the picture height', near(b.box.s, 800, 1) && b.box.x + b.box.s <= 1600 && b.box.y + b.box.s <= 800, JSON.stringify(b.box));
      await drag([0, 0], [700, 700]);
      b = await box();
      check('top-left corner resizes inwards (bottom-right stays put)', near(b.box.x + b.box.s, 800, 2) && near(b.box.y + b.box.s, 800, 2) && b.box.s >= 24, JSON.stringify(b.box));
      await drag([b.box.x + b.box.s, b.box.y], [b.box.x + b.box.s - 5000, b.box.y + 5000]);
      b = await box();
      check('top-right corner: square never shrinks below the minimum or leaves the picture', b.box.s >= 24 && b.box.x >= 0 && b.box.y >= 0 && b.box.x + b.box.s <= 1600 && b.box.y + b.box.s <= 800, JSON.stringify(b.box));
      await js(`document.querySelector('[data-crop="rotate"]').click()`);
      await wait(200);
      b = await box();
      check('rotate turns the picture 90° and resets the square', b.rot === 90 && b.W === 800 && b.H === 1600 && b.box.s === 800 && near(b.box.y, 400), JSON.stringify(b));
      for (let i = 0; i < 3; i++) await js(`document.querySelector('[data-crop="rotate"]').click()`);
      await wait(200);
      b = await box();
      check('four rotations bring it back', b.rot === 0 && b.W === 1600);
      await drag([800, 400], [100, 400]); // the red half
      await js(`document.querySelector('[data-crop="use"]').click()`);
      await wait(300);
      check('after "Use picture", the editor shows the new picture', await js(`!!document.querySelector('#pe-av img')`));
      check('nothing saved before Save', files().length === 0);
      await js(`document.getElementById('pe-save').click()`);
      await wait(800);
      let p1 = data().profiles.find((p) => p.id === 'p1');
      let info = p1.avatar && (await inspect(p1.avatar));
      check('Save stores a 200 x 200 picture', info && info.w === 200 && info.h === 200, JSON.stringify(info));
      check('the picture is the chosen part (the red half)', info && info.rgb[0] > 200 && info.rgb[2] < 60, JSON.stringify(info && info.rgb));
      check('one picture file on disk', files().length === 1, files().join(','));
      const shown = await js(`(() => ({ topbar: !!document.querySelector('.profile-menu-btn .avatar img') }))()`);
      check('picture shows in the top-bar profile button', shown.topbar);
      await js(`toggleProfileMenu()`);
      await wait(200);
      await js(`toggleProfileMenu()`);

      // --- Cancel keeps the old picture ---
      const before = data().profiles.find((p) => p.id === 'p1').avatar;
      await js(`openProfileEditor('p1')`);
      await openCropper('tall.png');
      await js(`document.querySelector('[data-crop="cancel"]').click()`);
      await wait(200);
      check('cropper Cancel: editor still shows the current picture', await js(`!!document.querySelector('#pe-av img') && !document.getElementById('crop-ov')`));
      await openCropper('tall.png');
      await js(`document.querySelector('[data-crop="use"]').click()`);
      await wait(200);
      await js(`document.getElementById('pe-cancel').click()`);
      await wait(400);
      check('editor Cancel: picture unchanged, no new file', data().profiles.find((p) => p.id === 'p1').avatar === before && files().length === 1);

      // --- Change picture: the old file is removed ---
      await js(`openProfileEditor('p1')`);
      await openCropper('tall.png');
      b = await box();
      check('tall picture: starts with the largest centred square', b.W === 600 && b.H === 1200 && b.box.s === 600 && near(b.box.y, 300), JSON.stringify(b.box));
      await drag([300, 600], [300, 0]); // the green top
      await js(`document.querySelector('[data-crop="use"]').click()`);
      await wait(200);
      await js(`document.getElementById('pe-save').click()`);
      await wait(800);
      p1 = data().profiles.find((p) => p.id === 'p1');
      info = await inspect(p1.avatar);
      check('changed picture is the green top, 200 x 200', info.w === 200 && info.rgb[1] > 100 && info.rgb[0] < 60, JSON.stringify(info));
      check('old picture file deleted', p1.avatar !== before && files().length === 1 && files()[0] === p1.avatar, files().join(','));

      // --- A small picture is enlarged to 200 x 200; a broken file gives a message ---
      await js(`openProfileEditor('p2')`);
      await openCropper('small.png');
      b = await box();
      check('small picture: square is its height', b.box.s === 80);
      await js(`document.querySelector('[data-crop="use"]').click()`);
      await wait(200);
      await js(`document.getElementById('pe-save').click()`);
      await wait(800);
      const p2 = data().profiles.find((p) => p.id === 'p2');
      info = await inspect(p2.avatar);
      check('small picture saved at 200 x 200', info && info.w === 200 && info.h === 200, JSON.stringify(info));
      await js(`openProfileEditor('p2')`);
      nextPick = 'bad.jpg';
      await js(`document.getElementById('pe-choose').click()`);
      await wait(800);
      check('a file that isn\'t a picture shows a message and no cropper', !(await js(`!!document.getElementById('crop-ov')`)) && /can't read that picture/i.test(await js(`document.getElementById('toast').textContent`)));
      await js(`closeModal(); document.getElementById('toast').classList.remove('show')`);

      // --- pictures on the profile screen and in Manage profiles; the photo for the screenshot ---
      await js(`openProfileEditor('p2')`);
      await openCropper('photo.jpg');
      await drag([800, 500], [700, 450]);
      await snap('61-cropper-photo');
      await js(`document.querySelector('[data-crop="use"]').click()`);
      await wait(200);
      await snap('62-editor-with-picture');
      await js(`document.getElementById('pe-save').click()`);
      await wait(800);
      await js(`S.profile = null; S.managing = false; render()`);
      await wait(600);
      check('profile tiles show the pictures', (await js(`document.querySelectorAll('.pf .pic img').length`)) === 2);
      await snap('63-profiles-with-pictures');
      await js(`S.managing = true; render()`);
      await wait(300);
      check('Manage profiles shows the pictures too', (await js(`document.querySelectorAll('.pf .pic img').length`)) === 2);
      await js(`S.managing = false; render()`);

      // --- Remove picture, and deleting a profile removes its file ---
      await js(`openProfileEditor('p1')`);
      await js(`document.getElementById('pe-rmpic').click()`);
      await wait(200);
      check('Remove picture shows the coloured letter again', !(await js(`!!document.querySelector('#pe-av img')`)) && (await js(`document.getElementById('pe-av').textContent.trim()`)) === 'S');
      await js(`document.getElementById('pe-save').click()`);
      await wait(800);
      check('removed: profile has no picture and its file is gone', !data().profiles.find((p) => p.id === 'p1').avatar && files().length === 1, files().join(','));
      await js(`window.confirm = () => true; openProfileEditor('p2')`);
      await js(`document.getElementById('pe-del').click()`);
      await wait(800);
      check('deleting a profile deletes its picture file', files().length === 0, files().join(','));
    } catch (e) {
      console.log('FAIL  ' + e.message);
      results.push(false);
    }
    console.log(`\n${results.filter(Boolean).length} passed, ${results.filter((r) => !r).length} failed`);
    console.log('console errors/warnings:', errors.length ? '\n' + errors.join('\n') : 'none');
    app.exit(0);
  });
});

require('../main.js');
