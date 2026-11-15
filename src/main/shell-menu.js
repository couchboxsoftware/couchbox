// "Couchbox > Copy to Couchbox / Move to Couchbox" in File Explorer's right-click menu, for videos
// and folders. On Windows 11 it's under "Show more options" (the short menu needs a signed,
// packaged app).
//
// The menu is a few per-user registry keys (no admin), written in one go with "reg import":
//   HKCU\Software\Classes\SystemFileAssociations\<.ext>\shell\Couchbox   (each video type)
//   HKCU\Software\Classes\Directory\shell\Couchbox                       (folders)
// each with Copy and Move commands that start Couchbox with "--add copy|move <path>". They're
// rewritten every time the installed app starts (so the exe path stays right after updates),
// removed when the switch in Settings, App is turned off, and by the uninstaller
// (build/installer.nsh). Portable copies get no menu (the exe moves around).
//
// Explorer starts Couchbox once per selected item. The one already running (or the first one)
// gathers them for 1.5 seconds into one job, adds them like Find videos does (TMDB, already in
// Couchbox, best copy, tidy names, never overwrite), and reports with Windows notifications.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { app, Notification } = require('electron');
const { Finder } = require('./finder');

const EXTS = ['.mp4', '.mkv', '.avi', '.mov', '.wmv', '.m4v', '.webm', '.ts', '.mpg', '.mpeg', '.flv'];
const GATHER_MS = Number(process.env.COUCHBOX_ADD_GATHER_MS) || 1500;

// Where the keys go: the real per-user classes, or (tests) a throwaway key.
const classesRoot = () => process.env.COUCHBOX_REG_ROOT || 'HKEY_CURRENT_USER\\Software\\Classes';
const keys = () => [...EXTS.map((e) => `${classesRoot()}\\SystemFileAssociations\\${e}\\shell\\Couchbox`), `${classesRoot()}\\Directory\\shell\\Couchbox`];

// Installed copies only (tests can switch it on).
const available = () => !!process.env.COUCHBOX_SHELL_MENU_TEST || (app.isPackaged && !process.env.PORTABLE_EXECUTABLE_DIR);

function regString(s) {
  return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

function regImport(text) {
  const file = path.join(os.tmpdir(), `couchbox-menu-${process.pid}-${Date.now()}.reg`);
  // .reg files are UTF-16 LE with a byte-order mark.
  fs.writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text.replace(/\n/g, '\r\n'), 'utf16le')]));
  return new Promise((resolve) => {
    execFile('reg.exe', ['import', file], { windowsHide: true }, (err) => {
      fs.rmSync(file, { force: true });
      resolve(err ? "Windows didn't accept the change: " + (err.message.split('\n')[0] || 'reg.exe failed') : '');
    });
  });
}

// Writes the menu, pointing at this Couchbox. Returns a problem in words, or ''.
function register(exe = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath) {
  const icon = `"${exe}",0`;
  const lines = ['Windows Registry Editor Version 5.00', ''];
  for (const key of keys()) {
    lines.push(`[${key}]`, `"MUIVerb"=${regString('Couchbox')}`, `"Icon"=${regString(icon)}`, '"SubCommands"=""', '');
    for (const [sub, label, mode] of [['1copy', 'Copy to Couchbox', 'copy'], ['2move', 'Move to Couchbox', 'move']]) {
      lines.push(`[${key}\\shell\\${sub}]`, `@=${regString(label)}`, `"Icon"=${regString(icon)}`, '"MultiSelectModel"="Player"', '');
      lines.push(`[${key}\\shell\\${sub}\\command]`, `@=${regString(`"${exe}" --add ${mode} "%1"`)}`, '');
    }
  }
  return regImport(lines.join('\n'));
}

function unregister() {
  return regImport(['Windows Registry Editor Version 5.00', '', ...keys().map((k) => `[-${k}]`), ''].join('\n'));
}

/* ---------- --add copy|move <path> ---------- */
// The paths asked for in a command line: [{ mode, path }].
function parseAdds(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--add') continue;
    const mode = argv[i + 1] === 'move' ? 'move' : 'copy';
    const p = argv[i + 2];
    if (p && !p.startsWith('--')) out.push({ mode, path: p });
  }
  return out;
}

class AddQueue {
  // notify({ title, body, onClick }) shows a Windows notification. showWindow(tab?) opens Couchbox.
  constructor({ getLibrary, notify, showWindow }) {
    this.lib = getLibrary;
    this.notify = notify;
    this.showWindow = showWindow;
    this.pending = { copy: [], move: [] };
    this.timer = null;
    this.busy = Promise.resolve();
  }

  // From Explorer (first start or another launch): gather for a moment, then one job per mode.
  add(items) {
    if (!items.length) return;
    for (const it of items) this.pending[it.mode].push(it.path);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), GATHER_MS);
  }

  flush() {
    for (const mode of ['copy', 'move']) {
      const paths = [...new Set(this.pending[mode])];
      this.pending[mode] = [];
      if (paths.length) this.busy = this.busy.then(() => this.run(mode, paths)).catch((e) => console.error('[add]', e));
    }
    return this.busy;
  }

  async run(mode, paths) {
    const lib = this.lib();
    if (!lib.root) {
      this.notify({ title: 'Choose a Couchbox folder first', body: 'Couchbox needs to know where your videos live before it can add these.', onClick: () => this.showWindow('library') });
      return { error: 'no folder' };
    }
    // Compare against the library as it is (wait for the first scan if Couchbox has just started).
    if (lib.running) await lib.running;
    if (!lib.everScanned) await lib.refresh();
    const started = Date.now();
    const finder = new Finder({ getLibrary: () => lib, send: () => {}, getExcluded: () => [] });
    let told = false;
    const count = await finder.collect(paths);
    // Only say "Adding…" if it's going to take a while.
    const slow = setTimeout(() => {
      told = true;
      this.notify({ title: `Adding ${count === 1 ? '1 video' : count + ' videos'} to Couchbox…`, body: mode === 'move' ? 'Each is copied and checked before the original is removed.' : 'Your originals stay where they are.', onClick: () => this.showWindow() });
    }, Math.max(0, 2000 - (Date.now() - started)));
    if (!count) {
      clearTimeout(slow);
      this.notify({ title: 'No videos to add', body: 'Couchbox didn\'t find any video files in what you chose.', onClick: () => this.showWindow() });
      return { added: 0, already: 0, failed: 0 };
    }
    const already = finder.results.filter((r) => r.state === 'inLibrary' || r.state === 'copy').length;
    const summary = await finder.add(mode, () => {});
    clearTimeout(slow);
    if (summary.error) {
      this.notify({ title: "Couldn't add to Couchbox", body: summary.error, onClick: () => this.showWindow() });
      return { error: summary.error };
    }
    const sameBatch = summary.skipped.filter((s) => s.reason === 'already added in this batch').length;
    const clashes = summary.skipped.filter((s) => s.reason === 'a file with that name is already there').length;
    const res = { added: summary.added, already: already + sameBatch, failed: clashes + summary.failed.length, told };
    const parts = [`${res.added === 1 ? 'Added 1 video' : `Added ${res.added} videos`} to Couchbox`];
    if (res.already) parts.push(`${res.already} already there`);
    if (res.failed) parts.push(`${res.failed} couldn't be added`);
    this.notify({ title: parts[0], body: parts.slice(1).join(' · ') || (mode === 'move' ? 'Moved into your Couchbox folder.' : 'Copied into your Couchbox folder.'), onClick: () => this.showWindow() });
    this.last = res;
    return res;
  }
}

// A real Windows notification (clicking it opens Couchbox).
function windowsNotify({ title, body, onClick }) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, icon: path.join(__dirname, '..', '..', 'build', 'icon.png') });
  if (onClick) n.on('click', onClick);
  n.show();
}

module.exports = { register, unregister, available, keys, parseAdds, AddQueue, windowsNotify, EXTS };
