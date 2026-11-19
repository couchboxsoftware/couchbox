// Running in the background: the close button hides Couchbox to the tray (by the clock) instead
// of quitting, so conversions, download checks and folder watching carry on.
//
// - Tray icon: the sofa, grey when idle (light on a dark taskbar, dark on a light one), orange
//   while converting, yellow when there's a warning. Double-click opens the window; right-click
//   has the status, Open Couchbox, Pause/Resume conversions and Quit.
// - Quit asks first if conversions are running. Windows shutting down never waits for that.
// - While anything converts, Windows isn't allowed to sleep (the screen can still turn off).
// - "Start with Windows" (off by default) starts Couchbox hidden in the tray.
const path = require('path');
const { app, Tray, Menu, nativeImage, nativeTheme, Notification, dialog, powerSaveBlocker } = require('electron');

// booting(): true while the splash is still up (it shows the window itself when it's done).
function create({ getWindow, store, getConverter, showWindow, saveWindowState, send, booting = () => false }) {
  let tray = null;
  let quitting = false;
  let shownOnce = false; // the first showing does the full opening (window mode, opening chord)
  let wasFull = false; // hidden while full screen: full screen again when shown
  let blocker = null;
  let lastView = null; // the conversion queue, as last reported
  let warnings = [];
  const fakeLogin = { openAtLogin: false }; // tests and the unpackaged app don't touch Windows

  /* ---------- hiding and showing ---------- */
  function attach(win) {
    win.on('show', () => (shownOnce = true));
    win.on('close', (e) => {
      if (quitting) return;
      e.preventDefault();
      hide();
    });
    // Windows is logging off or shutting down: quit straight away, never ask.
    win.on('session-end', () => (quitting = true));
  }

  function hide() {
    const win = getWindow();
    if (!win || win.isDestroyed() || !win.isVisible()) return;
    saveWindowState();
    send('window-hidden'); // a playing video pauses
    wasFull = win.isFullScreen();
    win.hide();
    if (!store.data.settings.trayHintShown && Notification.isSupported()) {
      store.data.settings.trayHintShown = true;
      store.save();
      const n = new Notification({ title: 'Couchbox is still running', body: 'Find it by the clock to open it or quit.', icon: iconPath('busy') });
      n.on('click', show);
      n.show();
    }
  }

  function show() {
    const win = getWindow();
    if (!win || win.isDestroyed() || booting()) return;
    if (!win.isVisible()) {
      if (!shownOnce) showWindow(); // first time (started hidden): window mode and opening chord
      else {
        win.show();
        if (wasFull && !win.isFullScreen()) win.setFullScreen(true);
      }
    }
    if (win.isMinimized()) win.restore();
    win.focus();
  }

  /* ---------- quitting ---------- */
  app.on('before-quit', () => (quitting = true)); // app.quit(), updates installing, and so on

  async function requestQuit() {
    const conv = getConverter();
    const running = conv ? conv.running.size : 0;
    if (running) {
      const win = getWindow();
      const opts = {
        type: 'question',
        buttons: ['Quit', 'Keep running'],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
        title: 'Couchbox',
        message: `${running === 1 ? '1 conversion is' : running + ' conversions are'} running. Quit anyway?`,
        detail: "They'll start again next time Couchbox opens.",
      };
      const { response } = await (win && win.isVisible() ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts));
      if (response !== 0) return false;
    }
    quitting = true;
    app.quit();
    return true;
  }

  /* ---------- the tray ---------- */
  const trayDir = path.join(__dirname, '..', '..', 'build', 'tray');
  function iconPath(state) {
    if (state === 'idle') {
      const dark = nativeTheme.shouldUseDarkColorsForSystemIntegratedUI ?? nativeTheme.shouldUseDarkColors;
      state = dark ? 'idle-dark' : 'idle-light';
    }
    return path.join(trayDir, state + '.png');
  }

  function state() {
    if (warnings.length) return 'warn';
    if (lastView && lastView.converting > 0) return 'busy';
    return 'idle';
  }

  function statusLine() {
    const v = lastView;
    if (warnings.length) return warnings[0].title || 'Needs attention';
    if (!v || !v.enabled) return 'Conversions are off';
    if (v.paused) return v.waiting + v.converting ? `Paused, ${v.waiting + v.converting} to convert` : 'Paused';
    if (v.converting || v.waiting) return [v.converting ? `Converting ${v.converting}` : '', v.waiting ? `${v.waiting} waiting` : ''].filter(Boolean).join(', ');
    return 'Nothing to convert';
  }

  function menu() {
    const v = lastView || {};
    return Menu.buildFromTemplate([
      { label: statusLine(), enabled: false },
      { type: 'separator' },
      { label: 'Open Couchbox', click: show },
      {
        label: v.paused ? 'Resume conversions' : 'Pause conversions',
        enabled: !!v.enabled,
        click: () => getConverter() && getConverter().setPaused(!v.paused),
      },
      { type: 'separator' },
      { label: 'Quit', click: requestQuit },
    ]);
  }

  function refresh() {
    if (!tray) return;
    tray.setImage(nativeImage.createFromPath(iconPath(state())));
    tray.setToolTip(`Couchbox: ${statusLine().replace(/^./, (c) => c.toLowerCase())}`);
    tray.setContextMenu(menu());
  }

  function startTray() {
    tray = new Tray(nativeImage.createFromPath(iconPath('idle')));
    tray.on('double-click', show);
    tray.on('click', show);
    nativeTheme.on('updated', refresh);
    refresh();
  }

  /* ---------- told by the app ---------- */
  function conversions(view) {
    lastView = view;
    // Keep the computer awake while converting (the screen may still turn off).
    const busy = view.converting > 0;
    if (busy && blocker == null) blocker = powerSaveBlocker.start('prevent-app-suspension');
    if (!busy && blocker != null) {
      powerSaveBlocker.stop(blocker);
      blocker = null;
    }
    refresh();
  }

  function setWarnings(list) {
    warnings = list;
    refresh();
  }

  /* ---------- Start with Windows ---------- */
  // Uses the installed exe, and starts hidden with --background. Tests and the unpackaged app
  // keep it in memory instead.
  const real = () => app.isPackaged && !process.env.COUCHBOX_NO_LOGIN_ITEM;
  const exe = () => process.execPath;
  function setStartWithWindows(on) {
    if (real()) app.setLoginItemSettings({ openAtLogin: !!on, path: exe(), args: ['--background'] });
    else fakeLogin.openAtLogin = !!on;
  }
  function loginItem() {
    return real() ? app.getLoginItemSettings({ path: exe(), args: ['--background'] }) : { ...fakeLogin };
  }

  return {
    attach, hide, show, requestQuit, startTray, conversions, setWarnings, setStartWithWindows, loginItem,
    isQuitting: () => quitting, keepingAwake: () => blocker != null, trayState: state, trayStatus: statusLine,
    trayMenu: () => menu().items.map((i) => ({ label: i.label, enabled: i.enabled, type: i.type, click: i.click })),
  };
}

module.exports = { create };
