// What's new: CHANGELOG.md follows the template, the release notes tool picks the right entry
// (and refuses a version with none), Settings, App lists the versions, and the one-time card
// shows after an update but not on a brand-new install.
// Usage: npx electron test/whatsnew-check.js   (screenshots go to COUCHBOX_SNAP_OUT, or a temp folder)
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');
const { app } = require('electron');
const { TEST_SETTINGS } = require('./quiet');
const changelog = require('../src/main/changelog');

const FRESH = process.env.WN_FRESH === '1';
const current = require('../package.json').version;
// The version before this one (the entry after it in the file): "updating from" that.
const all = changelog.load();
const previous = (all[all.findIndex((e) => e.version === current) + 1] || {}).version || '0.0.0';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'couchbox-wn-'));
const out = process.env.COUCHBOX_SNAP_OUT || path.join(tmp, 'snaps');
fs.mkdirSync(out, { recursive: true });
process.env.COUCHBOX_DATA_DIR = tmp;
fs.writeFileSync(path.join(tmp, 'couchbox-data.json'), JSON.stringify(FRESH
  ? { settings: { ...TEST_SETTINGS } } // brand new: no folder, no profiles
  : { settings: { libraryPath: tmp, ...TEST_SETTINGS }, profiles: [{ id: 'p1', name: 'Sam', color: '#2E9E6B', kids: false }], lastSeenVersion: previous }));

let failed = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${FRESH ? '[new install] ' : ''}${name}${detail !== '' ? '  -- ' + detail : ''}`);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

if (!FRESH) {
  // The file and the release notes tool.
  const text = fs.readFileSync(changelog.FILE, 'utf8');
  const problems = changelog.problems(text);
  check('CHANGELOG.md follows the template', problems.length === 0, problems.join(' | '));
  const entries = changelog.parse(text);
  // (The newest entry can be the version about to be released, one ahead of package.json.)
  check('it has every version from 0.3.0 to this one', entries.some((e) => e.version === current) && changelog.compare(entries[0].version, current) >= 0 && entries[entries.length - 1].version === '0.3.0', entries.map((e) => e.version).join(', '));
  const node = process.env.NODE_EXE || 'node';
  const r = spawnSync(node, [path.join(__dirname, '..', 'tools', 'release.js'), '--notes', '0.3.7'], { encoding: 'utf8' });
  check('release notes for 0.3.7: headline then New, Improved, Fixed', r.status === 0 && /^Couchbox spots videos[\s\S]*### New[\s\S]*### Improved[\s\S]*### Fixed/.test(r.stdout), r.stderr);
  const h = spawnSync(node, [path.join(__dirname, '..', 'tools', 'release.js'), '--notes', current, '--headline'], { encoding: 'utf8' });
  check('the banner gets just the headline', h.status === 0 && h.stdout.trim() === entries.find((e) => e.version === current).headline);
  const miss = spawnSync(node, [path.join(__dirname, '..', 'tools', 'release.js'), '--notes', '9.9.9'], { encoding: 'utf8' });
  check('a version with no entry is refused', miss.status === 1 && /no entry for 9\.9\.9/.test(miss.stderr));
  const bad = changelog.problems('## 1.0.0 · 15 Nov 2026\nNo full stop\n\n### Fixed\n- One.\n\n### New\n- Two.\n');
  check('the template check catches mistakes (headline, group order)', bad.length === 2, bad.join(' | '));
}

app.on('browser-window-created', (_e, win) => {
  win.webContents.once('did-finish-load', async () => {
    if (win.webContents.getURL().includes('splash.html')) return;
    const js = (code) => win.webContents.executeJavaScript(code);
    const snap = async (name) => {
      await wait(500);
      fs.writeFileSync(path.join(out, name + '.png'), (await win.webContents.capturePage()).toPNG());
      console.log('snap', path.join(out, name + '.png'));
    };
    try {
      win.setSize(1400, 900);
      for (let i = 0; i < 100 && !win.isVisible(); i++) await wait(100);
      if (FRESH) {
        const d = await js('cb.changelog()');
        check('no "What\'s new" card on a brand-new install', d.whatsNew === null);
        check('...and it won\'t show later either', (await js('cb.changelog()')).whatsNew === null);
      } else {
        await js(`document.querySelector('[data-pid="p1"]').click()`);
        await wait(1500);
        check(`after updating from ${previous}: the "What's new in ${current}" card`, await js(`!!document.querySelector('#wn-card') && /What's new in ${current.replace(/\./g, '\\.')}/i.test(document.querySelector('#wn-card').innerText)`));
        await snap('97-whatsnew-card');
        await js(`document.querySelector('#wn-card [data-act="wn-all"]').click()`);
        await wait(700);
        check('See all versions opens Settings, App at What\'s new', await js(`!document.querySelector('#wn-card') && !!document.querySelector('#settings-whatsnew .wn-ver')`));
        check('the newest three, with "You have this" on the current one', await js(`document.querySelectorAll('#settings-whatsnew .wn-ver').length === 3 && [...document.querySelectorAll('#settings-whatsnew .wn-ver')].filter(v => /You have this/.test(v.innerText)).length === 1`));
        await snap('98-whatsnew-settings');
        await js(`document.querySelector('[data-act="wn-more"]').click()`);
        await wait(300);
        check('Show older versions lists them all', await js(`document.querySelectorAll('#settings-whatsnew .wn-ver').length`) === changelog.load().length);
        await js('closeModal()');
        check('the card doesn\'t come back', (await js('cb.changelog()')).whatsNew === null && JSON.parse(fs.readFileSync(path.join(tmp, 'couchbox-data.json'), 'utf8')).lastSeenVersion === current);
      }
    } catch (e) {
      failed++;
      console.log('FAIL  ' + e.stack);
    }
    if (!FRESH) {
      const f = spawnSync(process.execPath, ['--mute-audio', __filename], { env: { ...process.env, WN_FRESH: '1' }, encoding: 'utf8', timeout: 60000 });
      process.stdout.write((f.stdout || '').split('\n').filter((l) => /^(PASS|FAIL)/.test(l)).join('\n') + '\n');
      if (/FAIL/.test(f.stdout || '') || f.status !== 0) failed++;
    }
    console.log(`\n${FRESH ? '[new install] ' : ''}${failed ? failed + ' failed' : 'all passed'}`);
    app.exit(failed ? 1 : 0);
  });
});

require('../main.js');
