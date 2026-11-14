/* In-app updates: the "Update available" banner and the Settings "Updates" section.
   The main process (src/main/updater.js) does the checking and downloading. */
const Updates = (() => {
  let st = { status: 'off' };
  let dismissed = null; // version the user said "Later" to (until next launch)

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const banner = () => document.getElementById('update-banner');
  const arrow = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>';

  function renderBanner() {
    const el = banner();
    const show =
      (st.status === 'available' && st.version !== dismissed) || st.status === 'downloading' || st.status === 'ready' || (st.status === 'error' && st.version);
    el.hidden = !show;
    if (!show) return;
    let body;
    if (st.status === 'available') {
      body = `<div class="ub-title"><span class="ub-icon">${arrow}</span>Update available: Couchbox ${esc(st.version)}</div>
        ${st.notes ? `<div class="ub-notes">${esc(st.notes)}</div>` : ''}
        <div class="ub-actions"><button class="btn btn-sm btn-accent" data-ub="now">${st.portable ? 'Get the new version' : 'Update now'}</button><button class="btn btn-sm ub-later" data-ub="later">Later</button></div>
        ${st.portable ? '<div class="ub-small">You\'re using the portable version, so this opens the download page.</div>' : ''}`;
    } else if (st.status === 'downloading') {
      body = `<div class="ub-title"><span class="ub-icon">${arrow}</span>Downloading Couchbox ${esc(st.version)}…</div>
        <div class="ub-progress"><div class="ub-bar"><i style="width:${st.percent || 0}%"></i></div><span>${st.percent || 0}%</span></div>`;
    } else if (st.status === 'ready') {
      body = `<div class="ub-title"><span class="ub-icon">${arrow}</span>Restarting to update…</div>
        <div class="ub-progress"><div class="ub-bar"><i style="width:100%"></i></div><span>100%</span></div>`;
    } else {
      body = `<div class="ub-title"><span class="ub-icon ub-err">!</span>The update didn't download</div>
        <div class="ub-small" title="${esc(st.error || '')}">Check your internet connection and try again.</div>
        <div class="ub-actions"><button class="btn btn-sm btn-accent" data-ub="now">Try again</button><button class="btn btn-sm ub-later" data-ub="later">Later</button></div>`;
    }
    el.innerHTML = body;
  }

  function renderSettings() {
    const box = document.getElementById('settings-updates');
    if (!box) return;
    const line = {
      off: 'Updates are checked in the installed app.',
      idle: st.error ? `Couldn't check for updates: ${esc(st.error)}` : 'Couchbox checks for updates when it starts.',
      checking: 'Checking for updates…',
      latest: "You're on the latest version.",
      available: `Couchbox ${esc(st.version)} is available.`,
      downloading: `Downloading Couchbox ${esc(st.version)}… ${st.percent || 0}%`,
      ready: 'Restarting to update…',
      error: `The update didn't download: ${esc(st.error)}`,
    }[st.status] || '';
    const btn =
      st.status === 'available' || st.status === 'error'
        ? `<button class="btn btn-sm btn-accent" data-ub="now">${st.portable ? 'Get the new version' : 'Update now'}</button>`
        : `<button class="btn btn-sm btn-ghost" data-ub="check" ${st.status === 'off' || st.status === 'checking' || st.status === 'downloading' || st.status === 'ready' ? 'disabled' : ''}>Check for updates</button>`;
    box.innerHTML = `<p style="margin:0 0 10px;font-size:14px">Version ${esc(st.current || '')}. ${line}</p><div class="inline">${btn}</div>`;
  }

  function apply(next) {
    st = next;
    renderBanner();
    renderSettings();
  }

  document.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-ub]');
    if (!b) return;
    e.stopPropagation();
    if (b.dataset.ub === 'later') {
      dismissed = st.version;
      if (st.status === 'error') st = { ...st, status: 'available' };
      renderBanner();
    } else if (b.dataset.ub === 'now') {
      dismissed = null;
      apply(await cb.downloadUpdate());
    } else if (b.dataset.ub === 'check') {
      dismissed = null;
      apply({ ...st, status: 'checking', error: null });
      apply(await cb.checkForUpdate());
    }
  }, true);

  async function init() {
    cb.onUpdate(apply);
    apply(await cb.updateState());
  }

  return { init, renderSettings };
})();
