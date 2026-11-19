// In-app updates via electron-updater. New versions are published to GitHub Releases
// (see "build.publish" in package.json and "Publishing an update" in the README).
//
// Flow: check quietly as soon as Couchbox is up, then every 6 hours -> tell the window "update available"
// -> the user clicks "Update now" -> download with progress -> restart into the new version.
// Nothing is downloaded until the user asks for it.
//
// Testing: set COUCHBOX_UPDATE_URL to a local folder server (http://localhost:PORT/) that holds
// latest.yml and the installer. Only localhost addresses are accepted.
const path = require('path');
const { app } = require('electron');

const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

// canInstall(): false while conversions are running; the downloaded update then waits for them
// ("Will update when conversions finish"), and onWaiting() stops new ones starting meanwhile.
function create({ send, canInstall = () => true, onWaiting = () => {} }) {
  const testUrl = (process.env.COUCHBOX_UPDATE_URL || '').trim();
  const useTestUrl = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//i.test(testUrl);
  const enabled = app.isPackaged || useTestUrl;

  // Couchbox's own version (app.getVersion() reports Electron's when run from source).
  const current = require('../../package.json').version;
  const state = { status: enabled ? 'idle' : 'off', current, version: null, notes: '', percent: 0, error: null };
  const emit = (patch) => {
    Object.assign(state, patch);
    send('update', { ...state });
  };

  let autoUpdater = null;
  if (enabled) {
    ({ autoUpdater } = require('electron-updater'));
    autoUpdater.autoDownload = false; // ask first
    autoUpdater.autoInstallOnAppQuit = false; // only update when the user says so
    autoUpdater.allowPrerelease = false;
    autoUpdater.logger = null;
    if (useTestUrl) {
      autoUpdater.forceDevUpdateConfig = true;
      if (!app.isPackaged) autoUpdater.updateConfigPath = path.join(__dirname, '..', '..', 'dev-app-update.yml');
      autoUpdater.setFeedURL({ provider: 'generic', url: testUrl });
      // Use electron-updater's own copy of semver, or its version comparisons reject the object.
      const semver = require(require.resolve('semver', { paths: [path.dirname(require.resolve('electron-updater'))] }));
      autoUpdater.currentVersion = semver.parse(current);
    }

    autoUpdater.on('checking-for-update', () => emit({ status: 'checking', error: null }));
    autoUpdater.on('update-not-available', () => emit({ status: 'latest' }));
    autoUpdater.on('update-available', (info) =>
      emit({ status: 'available', version: info.version, notes: plainNotes(info.releaseNotes), percent: 0 })
    );
    autoUpdater.on('download-progress', (p) => emit({ status: 'downloading', percent: Math.round(p.percent || 0) }));
    autoUpdater.on('update-downloaded', (info) => {
      state.version = info.version;
      // The user already chose "Update now", so restart into the new version: straight away, or
      // once the conversions that are running have finished.
      if (canInstall()) return installNow();
      emit({ status: 'waiting', percent: 100 });
      onWaiting();
      const t = setInterval(() => {
        if (state.status !== 'waiting') return clearInterval(t);
        if (canInstall()) {
          clearInterval(t);
          installNow();
        }
      }, 2000);
    });
    autoUpdater.on('error', (err) => {
      // A failed background check (offline, GitHub down) isn't worth bothering anyone about.
      const wasDownloading = state.status === 'downloading';
      emit({ status: wasDownloading ? 'error' : state.version ? 'available' : 'idle', error: wasDownloading ? short(err) : null, lastCheckError: short(err) });
    });
  }

  async function check(manual = false) {
    if (!autoUpdater) return { ...state };
    if (['checking', 'downloading', 'waiting', 'ready'].includes(state.status)) return { ...state };
    try {
      await autoUpdater.checkForUpdates();
    } catch (err) {
      emit({ status: 'idle', error: manual ? short(err) : null });
    }
    return { ...state };
  }

  async function download() {
    if (!autoUpdater || !state.version) return { ...state };
    emit({ status: 'downloading', percent: 0, error: null });
    autoUpdater.downloadUpdate().catch((err) => emit({ status: 'error', error: short(err) }));
    return { ...state };
  }

  // Restart into the downloaded update now ("Update now anyway" stops conversions first).
  function installNow() {
    if (!autoUpdater || !['waiting', 'downloading'].includes(state.status)) return { ...state };
    emit({ status: 'ready', percent: 100 });
    setTimeout(() => autoUpdater.quitAndInstall(true, true), 1200);
    return { ...state };
  }

  function start() {
    if (!autoUpdater) return;
    // As soon as the main window is up (or, started hidden in the tray, once it has loaded: the
    // banner is waiting when it's opened). No delay.
    check(false);
    setInterval(() => check(false), CHECK_EVERY_MS).unref?.();
  }

  return { start, check, download, installNow, getState: () => ({ ...state }) };
}

function plainNotes(notes) {
  if (!notes) return '';
  const text = Array.isArray(notes) ? notes.map((n) => n.note || '').join('\n') : String(notes);
  return text.replace(/<[^>]+>/g, ' ').replace(/[ \t]+/g, ' ').trim().slice(0, 600);
}

const short = (err) => String((err && err.message) || err).split('\n')[0].slice(0, 200);

module.exports = { create };
