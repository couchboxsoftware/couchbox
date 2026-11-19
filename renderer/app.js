/* Couchbox renderer: screens, rows, details, profiles and settings. */
const S = {
  settings: null,
  profiles: [],
  profile: null,
  model: { films: [], series: [], status: { phase: 'idle' } },
  progress: {},
  list: [],
  introData: { episodes: {} }, // intros found automatically, per episode (src/main/intros.js)
  tab: 'home',
  query: '',
  managing: false,
  featured: {},
  details: null, // { id, season }
  settingsTab: null, // the Settings tab used last, until Couchbox closes
  pendingRender: false,
  conv: null, // the conversion queue (see conv-ui.js and src/main/converter.js)
  warnings: [], // things that need attention: a yellow "!" on the menu, Settings, the tab and section
  dl: { files: {} }, // files still downloading or unfinished (see dl-ui.js and src/main/downloads.js)
  copies: null, // spare copies and different versions (see copies-ui.js and src/main/copies.js)
  collections: [], // your own collections, as this profile sees them (collections-ui.js)
  cwHidden: {}, // titles taken out of Continue watching: { id: progress time when removed }
};

/* ================= derived data ================= */
const isWatched = (p) => !!p && p.d > 0 && (p.t / p.d >= 0.95 || (p.d > 600 && p.d - p.t < 120));
const allItems = () => [...S.model.series, ...S.model.films];
const kidsOk = (i) => (S.kidsAllow && i.id in S.kidsAllow ? S.kidsAllow[i.id] : i.kidsSafe);
const visible = () => (S.profile && S.profile.kids ? allItems().filter(kidsOk) : allItems());
const byId = (id) => allItems().find((i) => i.id === id);
const epCode = (e) => (e.season === 0 ? 'Special ' + e.episode : `S${e.season}:E${e.episode}`);
const isNew = (i) => Date.now() - i.added < 14 * 864e5;

function allEpisodes(series) {
  return series.seasons.flatMap((s) => s.episodes);
}

function findEpisode(id) {
  for (const s of S.model.series) for (const se of s.seasons) for (const e of se.episodes) if (e.id === id) return { ep: e, series: s };
  return null;
}

function nextEpisode(series, ep) {
  const eps = allEpisodes(series);
  const i = eps.findIndex((e) => e.id === ep.id);
  return i >= 0 ? eps[i + 1] || null : null;
}

// What pressing Play on a series should do for this profile.
function nextUp(series) {
  const all = allEpisodes(series);
  const main = all.filter((e) => e.season !== 0);
  const eps = main.length ? main : all;
  let last = null;
  for (const e of all) {
    const p = S.progress[e.id];
    if (p && (!last || p.u > last.p.u)) last = { e, p };
  }
  if (!last) return { ep: eps[0], state: 'start' };
  if (!isWatched(last.p) && last.p.t > 10) return { ep: last.e, state: 'resume', p: last.p, u: last.p.u };
  const idx = eps.indexOf(last.e);
  const next = idx >= 0 ? eps[idx + 1] : eps.find((e) => !isWatched(S.progress[e.id]));
  if (next) return { ep: next, state: 'next', u: last.p.u };
  return { ep: eps[0], state: 'done', u: last.p.u };
}

function playInfo(item) {
  if (item.kind === 'film') {
    const p = S.progress[item.id];
    if (p && !isWatched(p) && p.t > 30) return { file: item, startAt: Math.max(0, p.t - 3), label: 'Resume', pct: p.t / p.d, p };
    return { file: item, startAt: 0, label: 'Play', pct: 0 };
  }
  const nu = nextUp(item);
  if (!nu.ep) return null;
  if (nu.state === 'resume') return { file: nu.ep, series: item, startAt: Math.max(0, nu.p.t - 3), label: 'Resume ' + epCode(nu.ep), pct: nu.p.t / nu.p.d, p: nu.p, state: nu.state };
  return { file: nu.ep, series: item, startAt: 0, label: (nu.state === 'next' ? 'Play ' : 'Play ') + epCode(nu.ep), pct: 0, state: nu.state };
}

// Titles taken out of the row stay out until any part of them is played again (which saves a
// newer progress time than the one recorded when it was removed).
function continueWatching(kind) {
  const out = [];
  const hidden = S.cwHidden || {};
  const add = (e) => !(hidden[e.item.id] >= e.u) && out.push(e);
  for (const it of visible()) {
    if (kind && it.kind !== kind) continue;
    if (it.kind === 'film') {
      const p = S.progress[it.id];
      if (p && p.t > 30 && !isWatched(p)) add({ item: it, u: p.u, pct: p.t / p.d });
    } else {
      const nu = nextUp(it);
      if (nu.state === 'resume') add({ item: it, u: nu.u, pct: nu.p.t / nu.p.d, label: epCode(nu.ep) });
      else if (nu.state === 'next') add({ item: it, u: nu.u, pct: 0, label: 'Next: ' + epCode(nu.ep) });
    }
  }
  return out.sort((a, b) => b.u - a.u);
}

// "Remove from Continue watching" (hover card and title page), with Undo. Progress is kept.
async function hideFromCw(id) {
  const entry = continueWatching(null).find((x) => x.item.id === id);
  if (!entry) return;
  S.cwHidden = await cb.cwHide(S.profile.id, id, entry.u);
  hideHover();
  renderContent(true);
  if (S.details) renderDetails();
  toast('Removed from Continue watching', 6000, {
    label: 'Undo',
    onClick: async () => {
      S.cwHidden = await cb.cwUnhide(S.profile.id, id);
      renderContent(true);
      if (S.details) renderDetails();
    },
  });
}

function metaBits(item) {
  const bits = [];
  if (item.rating) bits.push(`<span class="rating">${ICON.star}${item.rating.toFixed(1)}</span>`);
  if (item.year) bits.push(`<span>${item.year}</span>`);
  if (item.certification) bits.push(`<span class="badge">${esc(item.certification)}</span>`);
  if (item.kind === 'series') {
    const n = item.seasons.filter((s) => s.number !== 0).length;
    bits.push(`<span>${n > 1 ? n + ' seasons' : item.episodeCount + ' episode' + (item.episodeCount === 1 ? '' : 's')}</span>`);
  } else if (item.duration) bits.push(`<span>${fmtDuration(item.duration)}</span>`);
  return bits.join('');
}

/* ================= boot ================= */
async function boot() {
  const init = await cb.init();
  S.settings = init.settings;
  S.avatarBase = init.avatarBase;
  S.profiles = init.profiles;
  S.introData = init.introData || { episodes: {} };
  S.introAskMs = init.introAskMs;
  cb.onIntros((d) => {
    S.introData = d;
    if (Player.isOpen()) Player.introsChanged();
  });
  S.kidsAllow = init.kidsAllow || {};
  S.model = init.model;
  S.lastProfile = init.lastProfile;
  S.conv = init.conversions;
  S.warnings = init.warnings || [];
  cb.onConversions(Conv.onState);
  cb.onConvProgress(Conv.onProgress);
  cb.onWarnings(Conv.onWarnings);
  S.dl = init.downloads || { files: {} };
  cb.onDownloads(DL.onState);
  S.copies = init.copies;
  cb.onCopies(Copies.onState);
  // Hidden to the tray: a playing video pauses.
  cb.onWindowHidden(() => Player.isOpen() && Player.pause());
  // A notification asked for a Settings tab (e.g. "Choose a Couchbox folder first").
  cb.onOpenSettings((tab) => S.profile && openSettings(null, tab));
  cb.onLibrary((m) => {
    S.model = m;
    if (Player.isOpen()) Player.convChanged(); // a converted file may be ready now
    scheduleRender();
  });
  cb.onStatus(showStatus);
  // Shows merged from season folders: settings moved to the combined show (see main.js).
  cb.onPrefsChanged(async (p) => {
    S.kidsAllow = p.kidsAllow || {};
    if (S.profile) S.list = await cb.getList(S.profile.id);
    // A converted file got a new name: its progress moved to the new id.
    if (S.profile && p.progress) S.progress = await cb.getProgress(S.profile.id);
    // Ids changed: collections and "Remove from Continue watching" followed them.
    if (S.profile && p.collections) {
      [S.collections, S.cwHidden] = await Promise.all([cb.collectionsGet(S.profile.id), cb.cwGet(S.profile.id)]);
      if (Coll.isOpen()) Coll.renderPage();
    }
    scheduleRender();
  });
  showStatus(S.model.status || { phase: 'idle' });
  // body.is-full shows the "exit full screen" button in the top bar and lets Esc leave fullscreen.
  cb.onFullscreen((on) => document.body.classList.toggle('is-full', on));
  // The "warm bloom" as the main window appears (it overlaps the splash organ's tail on purpose).
  cb.onAppShown((s) => s.openingSounds && Sounds.play('bloom', s.soundVolume));
  cb.windowState().then((w) => document.body.classList.toggle('is-full', w.fullscreen));
  Updates.init();
  render();
  setTimeout(() => cb.ready(), 0); // the window is still hidden here, so no rAF
}

function scheduleRender() {
  if (!$('#hovercard').hidden || Player.isOpen()) {
    S.pendingRender = true;
    return;
  }
  S.pendingRender = false;
  if (S.settings.libraryPath && S.profile) {
    renderContent(true);
    if (S.details) renderDetails();
  } else render();
}

function showStatus(s) {
  const el = $('#statuspill');
  const labels = {
    scanning: 'Scanning your folder',
    reading: 'Reading videos',
    matching: 'Fetching posters and info',
    episodes: 'Fetching episode details',
    frames: 'Making thumbnails',
  };
  if (s.phase === 'error') {
    toast(s.message, 6000);
    return;
  }
  if (!labels[s.phase]) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.innerHTML = `<span class="spinner"></span>${labels[s.phase]}${s.total ? ` ${s.done}/${s.total}` : ''}`;
}

/* ================= top-level render ================= */
function render() {
  hideHover();
  stopHeroVideo();
  const app = $('#app');
  if (!S.settings.libraryPath) return renderSetup(app);
  if (!S.profile) return renderProfiles(app);
  renderBrowse(app);
}

/* ---------- setup ---------- */
function renderSetup(app, err) {
  const folder = S.settings.libraryPath;
  app.innerHTML = `
  <div class="screen">
    <div class="brand">${brandHTML()}</div>
    <div class="setup">
      <h1>Welcome to Couchbox</h1>
      <p class="lead">Your films and series, on your own computer. Two quick steps and you're watching.</p>
      <div class="step">
        <h3><span class="n ${folder ? 'ok' : ''}">${folder ? ICON.check : '1'}</span>Choose your video folder</h3>
        <p>Put films and series in one folder. Couchbox works out which is which from the names, and it's happiest with this layout:</p>
        <div class="tree">Videos\\
  Films\\
    Night Train (2019).mp4
  Series\\
    The Long Coast\\
      Season 01\\
        S01E01 - Pilot.mp4
        S01E01 - Pilot.srt   (subtitles, optional)</div>
        ${folder ? `<div class="path">${esc(folder)}</div>` : ''}
        <button class="btn btn-sm ${folder ? 'btn-ghost' : 'btn-accent'}" data-act="choose-folder">${ICON.folder}${folder ? 'Change folder' : 'Choose folder'}</button>
      </div>
      <div class="step">
        <h3><span class="n ${S.settings.hasTmdbKey ? 'ok' : ''}">${S.settings.hasTmdbKey ? ICON.check : '2'}</span>Posters and descriptions</h3>
        <p>Couchbox gets posters, descriptions and episode names from The Movie Database (TMDB). It needs a free API key: <span class="link" data-act="open-tmdb">get one here</span>, then paste the "API Key" or "API Read Access Token" below.</p>
        <div class="inline">
          <input class="input" id="tmdbkey" placeholder="${S.settings.hasTmdbKey ? 'Key saved. Paste a new one to replace it' : 'Paste your TMDB key'}" spellcheck="false" />
          <button class="btn btn-sm btn-ghost" data-act="save-key">Save key</button>
        </div>
        ${err ? `<div class="err">${esc(err)}</div>` : ''}
      </div>
      <div class="row-btns">
        <button class="btn btn-accent" data-act="setup-done" ${folder ? '' : 'disabled style="opacity:.4;pointer-events:none"'}>Continue</button>
      </div>
    </div>
  </div>`;
}

/* ---------- profiles ---------- */
// A profile's picture (if it has one) or its coloured letter.
const avatarUrl = (p) => (p.avatar ? S.avatarBase + encodeURIComponent(p.avatar) : null);
function avatarInner(p) {
  const url = avatarUrl(p);
  return url ? `<img class="av-img" src="${url}" alt="" draggable="false" />` : esc((p.name || '?').trim().charAt(0).toUpperCase());
}
function avatarHTML(p, cls = 'avatar') {
  return `<div class="${cls}" style="background:${p.color}">${avatarInner(p)}</div>`;
}

function renderProfiles(app) {
  if (!S.profiles.length) {
    app.innerHTML = `<div class="screen"><div class="brand">${brandHTML()}</div></div>`;
    openProfileEditor(null, true);
    return;
  }
  app.innerHTML = `
  <div class="screen">
    <div class="brand">${brandHTML()}</div>
    <h1 class="who">${S.managing ? 'Manage profiles' : "Who's watching?"}</h1>
    <div class="profiles">
      ${S.profiles
        .map(
          (p) => `<button class="pf" data-act="${S.managing ? 'edit-profile' : 'pick-profile'}" data-pid="${p.id}">
            <div class="pic" style="background:${p.color}">${avatarInner(p)}${p.kids ? '<span class="kids">KIDS</span>' : ''}${p.locked ? `<span class="lock" title="Has a PIN">${ICON.lock}</span>` : ''}${S.managing ? `<div class="edit">${ICON.pencil}</div>` : ''}</div>
            <span>${esc(p.name)}</span></button>`
        )
        .join('')}
      ${S.profiles.length < 8 ? `<button class="pf add" data-act="add-profile"><div class="pic">${ICON.plus}</div><span>Add profile</span></button>` : ''}
    </div>
    <button class="manage ${S.managing ? 'done' : ''}" data-act="toggle-manage">${S.managing ? 'DONE' : 'MANAGE PROFILES'}</button>
  </div>`;
}

function openProfileEditor(pid, first = false) {
  const existing = S.profiles.find((p) => p.id === pid);
  const p = existing ? { ...existing } : { id: 'p' + Date.now().toString(36), name: '', color: PROFILE_COLOURS[S.profiles.length % PROFILE_COLOURS.length], kids: false };
  const root = $('#modal-root');
  // The picture being edited: undefined = unchanged, null = removed, a data URL = newly cropped.
  // Nothing is saved until Save.
  let pending;
  let pendingPin = null; // a new profile's PIN, added once it's saved
  const showsPicture = () => (pending === undefined ? !!p.avatar : !!pending);
  const lockedNow = () => !!(existing && (S.profiles.find((x) => x.id === p.id) || {}).locked);
  // Profile lock: grown-up profiles only (kids profiles can't have a PIN).
  const lockHTML = () => {
    if (first) return '';
    const row = (sub, buttons) => `<div class="pe-lock"><span class="t-text"><b>Profile lock</b><small>${sub}</small></span>${buttons}</div>`;
    if (p.kids) return lockedNow() ? `<p class="pe-note" style="color:var(--text-2);margin:8px 0 0">Kids profiles can't have a PIN, so this profile's PIN is removed when you save.</p>` : '';
    if (lockedNow()) return row('A PIN is asked for to open this profile, change it or open Settings.', '<button class="btn btn-sm btn-ghost" id="pe-pin-change">Change PIN</button><button class="btn btn-sm btn-ghost" id="pe-pin-remove">Remove PIN</button>');
    if (pendingPin) return row('The PIN is added when you save.', `<button class="btn btn-sm btn-ghost" id="pe-pin-undo">Don't add it</button>`);
    return row('Ask for a 4-number PIN to open this profile.', '<button class="btn btn-sm btn-ghost" id="pe-pin-add">Add PIN</button>');
  };
  const avInner = () =>
    typeof pending === 'string' ? `<img class="av-img" src="${pending}" alt="" />` : pending === null ? esc((p.name || '?').charAt(0).toUpperCase()) : avatarInner(p);
  const draw = (err) => {
    root.innerHTML = `
    <div class="overlay" data-close="${first ? '' : '1'}">
      <div class="dialog" role="dialog" aria-label="Profile">
        <h2>${first ? 'Create your profile' : existing ? 'Edit profile' : 'Add profile'}</h2>
        <p>${first ? 'Each person gets their own Continue watching, progress and list.' : 'Profiles keep progress and lists separate.'}</p>
        <div style="display:flex;gap:20px;align-items:flex-start">
          <div class="pe-left">
            <div class="avatar" id="pe-av" style="width:96px;height:96px;font-size:44px;background:${p.color};border-radius:8px">${avInner()}</div>
            <button class="pe-link" id="pe-choose">${ICON.image}${showsPicture() ? 'Change picture' : 'Choose picture…'}</button>
            ${showsPicture() ? '<button class="pe-link" id="pe-rmpic">Remove picture</button>' : ''}
          </div>
          <div style="flex:1">
            <div class="field"><label for="pe-name">Name</label><input class="input" id="pe-name" maxlength="20" value="${esc(p.name)}" placeholder="Sam" /></div>
            ${err ? `<div class="err" style="margin:-10px 0 12px">${esc(err)}</div>` : ''}
            <div class="field"><label>Colour</label><div class="swatches">${PROFILE_COLOURS.map((c) => `<button class="swatch ${c === p.color ? 'on' : ''}" style="background:${c}" data-colour="${c}" aria-label="Colour"></button>`).join('')}</div></div>
          </div>
        </div>
        <label class="toggle"><span class="t-text"><b>Kids profile</b><small>Only shows titles rated U, PG or family-friendly on TMDB.</small></span><span class="switch"><input type="checkbox" id="pe-kids" ${p.kids ? 'checked' : ''} /><span></span></span></label>
        ${lockHTML()}
        <div class="row-btns">
          ${existing ? '<button class="btn btn-sm btn-ghost" id="pe-del" style="margin-right:auto">Delete profile</button>' : ''}
          ${first ? '' : '<button class="btn btn-sm btn-ghost" id="pe-cancel">Cancel</button>'}
          <button class="btn btn-sm btn-accent" id="pe-save">Save</button>
        </div>
      </div>
    </div>`;
    const name = $('#pe-name');
    name.focus();
    name.addEventListener('input', () => {
      p.name = name.value;
      if (!showsPicture()) $('#pe-av').textContent = (p.name || '?').charAt(0).toUpperCase();
    });
    $('#pe-choose').onclick = async () => {
      const r = await cb.chooseAvatar();
      if (!r) return;
      if (r.error) return toast(r.error, 5000);
      const out = await Cropper.open(r.dataUrl);
      if (out && out.error) return toast(out.error, 5000);
      if (typeof out === 'string') {
        p.name = name.value;
        pending = out;
        draw();
      }
    };
    if ($('#pe-rmpic'))
      $('#pe-rmpic').onclick = () => {
        p.name = name.value;
        pending = null;
        draw();
      };
    name.addEventListener('keydown', (e) => e.key === 'Enter' && $('#pe-save').click());
    $$('.swatch', root).forEach((b) =>
      b.addEventListener('click', () => {
        p.color = b.dataset.colour;
        $$('.swatch', root).forEach((x) => x.classList.toggle('on', x === b));
        $('#pe-av').style.background = p.color;
      })
    );
    $('#pe-kids').addEventListener('change', (e) => {
      p.kids = e.target.checked;
      p.name = name.value;
      draw(); // shows or hides Profile lock
    });
    // Profile lock buttons. Changing or removing a PIN asks for the current one first.
    const fresh = () => S.profiles.find((x) => x.id === p.id) || p;
    const pinDone = (r, msg) => {
      if (!r || !r.ok) return draw(r && r.error);
      Pin.syncProfiles(r.profiles);
      toast(msg, 2200);
      draw();
    };
    if ($('#pe-pin-add'))
      $('#pe-pin-add').onclick = async () => {
        p.name = name.value;
        const pin = await Pin.choose({ profile: { ...p, name: p.name || 'this profile' } });
        if (!pin) return draw();
        if (!existing) {
          pendingPin = pin;
          return draw();
        }
        pinDone(await cb.pinSet(p.id, pin, null), 'PIN added');
      };
    if ($('#pe-pin-undo'))
      $('#pe-pin-undo').onclick = () => {
        p.name = name.value;
        pendingPin = null;
        draw();
      };
    if ($('#pe-pin-change'))
      $('#pe-pin-change').onclick = async () => {
        p.name = name.value;
        const cur = await Pin.ask({ profile: fresh(), title: 'Enter the current PIN', wantPin: true });
        if (!cur) return draw(); // cancelled (or Forgot PIN? removed it)
        const pin = await Pin.choose({ profile: fresh() });
        if (!pin) return draw();
        pinDone(await cb.pinSet(p.id, pin, cur), 'PIN changed');
      };
    if ($('#pe-pin-remove'))
      $('#pe-pin-remove').onclick = async () => {
        p.name = name.value;
        const cur = await Pin.ask({ profile: fresh(), title: 'Enter the current PIN', note: 'to remove it', wantPin: true });
        if (!cur) return draw();
        pinDone(await cb.pinSet(p.id, null, cur), 'PIN removed');
      };
    if ($('#pe-cancel')) $('#pe-cancel').onclick = closeModal;
    $('#pe-save').onclick = async () => {
      p.name = name.value.trim();
      if (!p.name) return draw('Enter a name');
      // Turning Kids off, once any profile has a PIN, needs a grown-up's PIN.
      if (existing && existing.kids && !p.kids && S.profiles.some((x) => x.locked) && !(await Pin.ask({ note: 'to turn Kids off' }))) return;
      if (typeof pending === 'string') {
        const file = await cb.saveAvatar(p.id, pending);
        if (!file) return draw("Couldn't save the picture. Try another one.");
        p.avatar = file;
      } else if (pending === null) delete p.avatar;
      const list = existing ? S.profiles.map((x) => (x.id === p.id ? p : x)) : [...S.profiles, p];
      const saved = await cb.saveProfiles(list);
      if (!Array.isArray(saved)) return draw(saved.error); // a PIN was needed (pins.js)
      S.profiles = saved;
      if (pendingPin) {
        const r = await cb.pinSet(p.id, pendingPin, null);
        if (r.ok) S.profiles = r.profiles;
      }
      if (S.profile && S.profile.id === p.id) S.profile = S.profiles.find((x) => x.id === p.id) || p;
      closeModal();
      if (first) return pickProfile(p.id);
      render();
    };
    if ($('#pe-del'))
      $('#pe-del').onclick = async () => {
        if (!confirm(`Delete ${existing.name}? Their progress and list will be removed.`)) return;
        const saved = await cb.saveProfiles(S.profiles.filter((x) => x.id !== p.id));
        if (!Array.isArray(saved)) return draw(saved.error);
        S.profiles = saved;
        if (S.profile && S.profile.id === p.id) S.profile = null;
        closeModal();
        render();
      };
  };
  draw();
}

async function pickProfile(pid) {
  let p = S.profiles.find((x) => x.id === pid);
  if (!p) return;
  // A locked profile asks for its PIN (full screen) every time it's picked.
  if (p.locked && !(S.profile && S.profile.id === p.id) && !(await Pin.ask({ profile: p, full: true }))) return;
  p = S.profiles.find((x) => x.id === pid) || p; // Forgot PIN? may have changed it
  S.profile = p;
  S.managing = false;
  S.tab = 'home';
  S.query = '';
  S.featured = {};
  [S.progress, S.list, S.collections, S.cwHidden] = await Promise.all([cb.getProgress(p.id), cb.getList(p.id), cb.collectionsGet(p.id), cb.cwGet(p.id)]);
  cb.setLastProfile(p.id);
  render();
}

/* ---------- browse ---------- */
function renderBrowse(app) {
  const tabs = [
    ['home', 'Home'],
    ['series', 'Series'],
    ['films', 'Films'],
    ['list', 'My list'],
    ['collections', 'Collections'],
  ];
  app.innerHTML = `
  <header class="nav" id="nav">
    <div class="brand" data-act="tab" data-tab="home">${brandHTML()}</div>
    <nav class="tabs">${tabs.map(([k, l]) => `<button class="tab ${S.tab === k && !S.query ? 'active' : ''}" data-act="tab" data-tab="${k}">${l}</button>`).join('')}<button class="tab ${S.tab === 'unmatched' && !S.query ? 'active' : ''}" data-act="tab" data-tab="unmatched" hidden>Unmatched <span class="tab-count"></span></button></nav>
    <div class="nav-right">
      <label class="searchbox ${S.query ? 'open' : ''}" id="searchbox">${ICON.search}<input id="search" placeholder="Titles, episodes, genres" value="${esc(S.query)}" spellcheck="false" /></label>
      <button class="exit-full" data-act="exit-full" aria-label="Exit full screen" title="Exit full screen (Esc)">${ICON.unfull}</button>
      ${S.profile.kids ? '<span class="badge" style="border-color:var(--accent);color:var(--accent)">KIDS</span>' : ''}
      <button class="profile-menu-btn" data-act="profile-menu" aria-label="Profile menu">${avatarHTML(S.profile)}${ICON.down}${S.warnings.length ? Conv.dot() : ''}</button>
    </div>
  </header>
  <main id="content"></main>`;
  const search = $('#search');
  const box = $('#searchbox');
  box.querySelector('svg').addEventListener('click', () => {
    box.classList.add('open');
    search.focus();
  });
  search.addEventListener('focus', () => box.classList.add('open'));
  search.addEventListener('blur', () => !search.value && box.classList.remove('open'));
  search.addEventListener(
    'input',
    debounce(() => {
      S.query = search.value.trim();
      $$('.tab').forEach((t) => t.classList.toggle('active', !S.query && t.dataset.tab === S.tab));
      renderContent();
    }, 180)
  );
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      search.value = '';
      S.query = '';
      search.blur();
      renderContent();
    }
  });
  renderContent();
  WhatsNew.maybeShowCard(); // once, after an update
}

function rowHTML(key, title, entries) {
  if (!entries.length) return '';
  return `<section class="row" data-row="${key}"><h2>${esc(title)}</h2>
    <div class="row-wrap"><button class="arrow l" data-act="row-l" aria-label="Scroll left">${ICON.left}</button>
    <div class="track">${entries.map((e) => cardHTML(e.item || e, e)).join('')}</div>
    <button class="arrow r" data-act="row-r" aria-label="Scroll right">${ICON.right}</button></div></section>`;
}

function cardHTML(item, extra = {}) {
  let inner;
  if (item.poster) inner = `<img src="${item.poster}" loading="lazy" alt="" draggable="false" />`;
  else if (item.backdrop)
    inner = `<div class="gen"><img src="${item.backdrop}" loading="lazy" alt="" draggable="false" /><span>${esc(item.title)}</span><small>${item.kind === 'series' ? 'Series' : item.year || 'Film'}</small></div>`;
  else {
    const h = hashHue(item.title);
    inner = `<div class="gen" style="background:linear-gradient(160deg,hsl(${h} 45% 32%),hsl(${(h + 40) % 360} 50% 14%))"><span>${esc(item.title)}</span><small>${item.kind === 'series' ? 'Series' : item.year || 'Film'}</small></div>`;
  }
  const tag = extra.pct == null && isNew(item) ? '<span class="newtag">NEW</span>' : '';
  const label = extra.label ? `<span class="eplabel">${esc(extra.label)}</span>` : '';
  const bar = extra.pct > 0 ? `<div class="pbar"><i style="width:${Math.round(extra.pct * 100)}%"></i></div>` : '';
  // A film being converted (or waiting) is grey, with an orange line rising as it goes. Series
  // cards stay as they are; their episodes show it inside.
  // A film still downloading: the same look in purple ("Downloading 38%"), or an Incomplete tag.
  const conv = item.kind === 'film' ? DL.overlay(item.id) || Conv.overlay(item.id) : '';
  // A new version gets a yellow "!" (compare); versions kept side by side show their length.
  const ver = item.kind === 'film' ? Copies.cardBits(item.id) : '';
  return `<div class="card" data-act="open" data-id="${esc(item.id)}" tabindex="0" aria-label="${esc(item.title)}">${inner}${conv}${conv ? '' : tag}${label}${bar}${ver}</div>`;
}

function genreRows(list, prefix) {
  const counts = new Map();
  for (const it of list) for (const g of it.genres) counts.set(g, (counts.get(g) || 0) + 1);
  return [...counts.entries()]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([g]) => rowHTML(prefix + g, g, list.filter((i) => i.genres.includes(g))))
    .join('');
}

const az = (a, b) => a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: 'base' });
const newest = (a, b) => b.added - a.added;

function renderContent(keepScroll = false) {
  hideHover();
  const content = $('#content');
  if (!content) return;
  const app = $('#app');
  const saved = keepScroll ? { top: app.scrollTop, rows: Object.fromEntries($$('.row').map((r) => [r.dataset.row, $('.track', r).scrollLeft])) } : null;

  const vis = visible();
  Unmatched.updateTab();
  if (S.query) {
    content.innerHTML = searchHTML(vis);
  } else if (S.tab === 'unmatched') {
    stopHeroVideo();
    content.innerHTML = Unmatched.pageHTML();
  } else if (S.tab === 'collections') {
    stopHeroVideo();
    content.innerHTML = Coll.pageHTML();
  } else if (!allItems().length) {
    stopHeroVideo();
    const scanning = S.model.status && S.model.status.phase !== 'idle';
    content.innerHTML = `<div class="empty" style="padding-top:200px"><h2>${scanning ? 'Looking for videos…' : 'No videos found yet'}</h2>
      <p>${scanning ? 'This only takes a moment.' : `Add films or series to <b>${esc(S.settings.libraryPath)}</b> and they'll appear here.`}</p>
      ${scanning ? '' : `<button class="btn btn-sm btn-ghost" data-act="settings">${ICON.gear}Settings</button>`}</div>`;
  } else if (!vis.length) {
    stopHeroVideo();
    content.innerHTML = `<div class="empty" style="padding-top:200px"><h2>Nothing here for kids yet</h2><p>Kids profiles show titles TMDB rates as U, PG or family-friendly.<br>From a grown-up profile, open any title and choose "Show on kids profiles" to add it here.</p></div>`;
  } else if (S.tab === 'list') {
    stopHeroVideo();
    const items = S.list.map(byId).filter((i) => i && vis.includes(i));
    content.innerHTML = `<div class="rows flat"><h1 class="page-title">My list</h1>${
      items.length ? `<div class="grid">${items.map((i) => cardHTML(i)).join('')}</div>` : `<div class="empty"><h2>Your list is empty</h2><p>Press + on any film or series to save it here.</p></div>`
    }</div>`;
  } else {
    const kind = S.tab === 'series' ? 'series' : S.tab === 'films' ? 'film' : null;
    const pool = kind ? vis.filter((i) => i.kind === kind) : vis;
    if (!pool.length) {
      stopHeroVideo();
      content.innerHTML = `<div class="empty" style="padding-top:200px"><h2>No ${kind === 'film' ? 'films' : 'series'} yet</h2><p>Add some to your folder and they'll show up here.</p></div>`;
    } else {
      const cw = continueWatching(kind);
      const featured = pickFeatured(S.tab, pool, cw);
      const myList = S.list.map(byId).filter((i) => i && pool.includes(i));
      let rows = '';
      rows += rowHTML('cw', `Continue watching for ${S.profile.name}`, cw);
      if (!kind) rows += rowHTML('list', 'My list', myList);
      // Your collections: all of them on Home; in Films / Series, those at least half that kind.
      if (!kind) rows += Coll.rowHTML('coll', 'Your collections', Coll.forTab(null));
      rows += rowHTML('new', 'Recently added', [...pool].sort(newest).slice(0, 24));
      if (kind) rows += Coll.rowHTML('coll', 'Collections', Coll.forTab(kind));
      if (!kind) {
        rows += rowHTML('series', 'Series', vis.filter((i) => i.kind === 'series').sort(az));
        rows += rowHTML('films', 'Films', vis.filter((i) => i.kind === 'film' && !i.imported).sort(az));
        rows += rowHTML('imported', 'Imported', vis.filter((i) => i.imported).sort(newest));
      }
      rows += genreRows(pool, (kind || 'all') + ':');
      if (kind) rows += rowHTML('az', kind === 'film' ? 'All films A to Z' : 'All series A to Z', [...pool].sort(az));
      const heroKeep = keepScroll && $('.hero') && $('.hero').dataset.id === featured.id;
      if (heroKeep) {
        $('.rows', content).innerHTML = rows;
      } else {
        stopHeroVideo();
        content.innerHTML = heroHTML(featured) + `<div class="rows">${rows}</div>`;
        startHeroTimer(featured);
      }
    }
  }
  if (saved) {
    app.scrollTop = saved.top;
    for (const r of $$('.row')) if (saved.rows[r.dataset.row] != null) $('.track', r).scrollLeft = saved.rows[r.dataset.row];
  } else app.scrollTop = 0;
}

function pickFeatured(tab, pool, cw) {
  const cur = S.featured[tab] && byId(S.featured[tab]);
  if (cur && pool.includes(cur)) return cur;
  const withArt = pool.filter((i) => i.backdrop);
  const fromCw = cw.find((c) => c.item.backdrop);
  const pick = fromCw ? fromCw.item : withArt.length ? withArt[Math.floor(Math.random() * withArt.length)] : pool[0];
  S.featured[tab] = pick.id;
  return pick;
}

function heroHTML(item) {
  const info = playInfo(item);
  const ov = item.overview || (item.kind === 'series' ? `${item.episodeCount} episodes in your library.` : 'From your library.');
  return `<section class="hero" data-id="${esc(item.id)}">
    <div class="hero-media">${item.backdrop ? `<img src="${item.backdrop}" alt="" draggable="false" />` : `<div style="position:absolute;inset:0;background:linear-gradient(120deg,hsl(${hashHue(item.title)} 40% 22%),#121212)"></div>`}</div>
    <div class="hero-info">
      <div class="hero-kind">${item.kind === 'series' ? 'SERIES' : 'FILM'}</div>
      <h1 class="hero-title">${esc(item.title)}</h1>
      <div class="hero-meta">${metaBits(item)}</div>
      <p class="hero-overview">${esc(ov)}</p>
      <div class="hero-actions">
        <button class="btn btn-light" data-act="play" data-id="${esc(item.id)}">${ICON.play}${esc(info ? info.label : 'Play')}</button>
        <button class="btn btn-grey" data-act="open" data-id="${esc(item.id)}">${ICON.info}More info</button>
      </div>
    </div>
    <div class="hero-side">
      <button class="round" id="hero-mute" data-act="hero-mute" hidden aria-label="Toggle sound">${ICON.mute}</button>
      ${item.certification ? `<div class="cert">${esc(item.certification)}</div>` : '<div style="width:24px"></div>'}
    </div>
  </section>`;
}

/* ---------- hero preview ---------- */
let heroTimer = null;
let heroVideo = null;
function startHeroTimer(item) {
  clearTimeout(heroTimer);
  if (!S.settings.previews) return;
  const info = playInfo(item);
  if (!info || !info.file.playable || !info.file.duration) return;
  heroTimer = setTimeout(() => {
    const media = $('.hero-media');
    if (!media || Player.isOpen() || S.details || $('#app').scrollTop > 300) return;
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.src = info.file.video;
    v.addEventListener('loadedmetadata', () => {
      v.currentTime = info.startAt > 60 ? info.startAt : v.duration * 0.3;
      v.play().catch(() => {});
    });
    v.addEventListener('playing', () => {
      v.classList.add('on');
      const m = $('#hero-mute');
      if (m) m.hidden = false;
    });
    v.addEventListener('error', stopHeroVideo);
    media.appendChild(v);
    heroVideo = v;
    // Show about a minute, then fade back to the still.
    setTimeout(() => heroVideo === v && stopHeroVideo(), 60000);
  }, 4000);
}
function stopHeroVideo() {
  clearTimeout(heroTimer);
  if (heroVideo) {
    const v = heroVideo;
    heroVideo = null;
    v.classList.remove('on');
    setTimeout(() => {
      v.pause();
      v.removeAttribute('src');
      v.load();
      v.remove();
    }, 600);
    const m = $('#hero-mute');
    if (m) m.hidden = true;
  }
}

/* ---------- search ---------- */
function searchHTML(vis) {
  const q = S.query.toLowerCase();
  const items = vis.filter((i) => i.title.toLowerCase().includes(q) || i.genres.some((g) => g.toLowerCase().includes(q)) || (i.overview || '').toLowerCase().includes(q));
  items.sort((a, b) => (b.title.toLowerCase().startsWith(q) - a.title.toLowerCase().startsWith(q)) || az(a, b));
  const eps = [];
  for (const s of vis) if (s.kind === 'series') for (const e of allEpisodes(s)) if (e.title.toLowerCase().includes(q)) eps.push({ e, s });
  if (!items.length && !eps.length)
    return `<div class="empty" style="padding-top:200px"><h2>No matches for "${esc(S.query)}"</h2><p>Try a different title, episode name or genre.</p></div>`;
  return `<div class="rows flat"><h1 class="page-title" style="font-size:20px;color:#aaa;font-weight:500">Results for "${esc(S.query)}"</h1>
    ${items.length ? `<div class="grid">${items.map((i) => cardHTML(i)).join('')}</div>` : ''}
    ${
      eps.length
        ? `<h2 style="margin:40px var(--gutter) 10px;font-size:20px">Episodes</h2><div style="padding:0 var(--gutter);max-width:1000px">${eps
            .slice(0, 30)
            .map(({ e, s }) => episodeRowHTML(e, `${esc(s.title)} · ${epCode(e)}`))
            .join('')}</div>`
        : ''
    }</div>`;
}

/* ---------- hover card ---------- */
let hoverTimer = null;
let hoverVideoTimer = null;
let hoverCard = null;
function scheduleHover(card) {
  clearTimeout(hoverTimer);
  hoverTimer = setTimeout(() => showHover(card), 520);
}
function showHover(card) {
  const item = byId(card.dataset.id);
  if (!item || !document.contains(card)) return;
  const hc = $('#hovercard');
  const info = playInfo(item);
  const inList = S.list.includes(item.id);
  const r = card.getBoundingClientRect();
  const w = Math.max(r.width * 1.95, 320);
  hc.style.width = w + 'px';
  const img = item.backdrop || item.poster;
  hc.innerHTML = `
    <div class="hc-media" data-act="open" data-id="${esc(item.id)}">${img ? `<img src="${img}" alt="" />` : `<div style="position:absolute;inset:0;background:hsl(${hashHue(item.title)} 40% 25%)"></div>`}<div class="hc-title">${esc(item.title)}</div></div>
    <div class="hc-body">
      <div class="hc-actions">
        <button class="round solid" data-act="play" data-id="${esc(item.id)}" aria-label="Play">${ICON.play}</button>
        ${Menus.buttonsHTML(item)}
        ${card.closest('[data-row="cw"]') ? `<button class="round" data-act="cw-hide" data-id="${esc(item.id)}" aria-label="Remove from Continue watching" title="Remove from Continue watching">${ICON.x}</button>` : ''}
        <span class="spacer"></span>
        <button class="round" data-act="open" data-id="${esc(item.id)}" aria-label="More info" title="More info">${ICON.down}</button>
      </div>
      ${info && info.pct > 0 ? `<div class="hc-progress"><div class="bar"><i style="width:${Math.round(info.pct * 100)}%"></i></div>${info.p ? fmtDuration(info.p.d - info.p.t) + ' left' : ''}</div>` : ''}
      ${info && info.series && info.state !== 'start' ? `<div class="hc-meta" style="color:#fff;font-weight:600">${epCode(info.file)} · ${esc(info.file.title)}</div>` : ''}
      <div class="hc-meta">${metaBits(item)}</div>
      <div class="hc-genres">${item.genres.slice(0, 3).map(esc).join(' <span style="color:#666">•</span> ')}</div>
    </div>`;
  hc.hidden = false;
  const h = hc.offsetHeight;
  const left = Math.min(Math.max(12, r.left + r.width / 2 - w / 2), innerWidth - w - 24);
  const top = Math.min(Math.max(72, r.top + r.height / 2 - h / 2), innerHeight - h - 12);
  hc.style.left = left + 'px';
  hc.style.top = top + 'px';
  hoverCard = item.id;
  clearTimeout(hoverVideoTimer);
  if (S.settings.previews && info && info.file.playable && info.file.duration) {
    hoverVideoTimer = setTimeout(() => {
      if (hoverCard !== item.id) return;
      const v = document.createElement('video');
      v.muted = true;
      v.src = info.file.video;
      v.addEventListener('loadedmetadata', () => {
        v.currentTime = info.startAt > 60 ? info.startAt : v.duration * 0.3;
        v.play().catch(() => {});
      });
      v.addEventListener('playing', () => v.classList.add('on'));
      $('.hc-media', hc).insertBefore(v, $('.hc-title', hc));
    }, 900);
  }
}
function hideHover() {
  if (typeof Menus !== 'undefined' && Menus.holdsHover()) return; // its + or cog menu is open
  clearTimeout(hoverTimer);
  clearTimeout(hoverVideoTimer);
  const hc = $('#hovercard');
  if (hc.hidden) return;
  for (const v of $$('video', hc)) {
    v.pause();
    v.removeAttribute('src');
    v.load();
  }
  hc.hidden = true;
  hc.innerHTML = '';
  hoverCard = null;
  if (S.pendingRender) setTimeout(scheduleRender, 50);
}

/* ================= details modal ================= */
function openDetails(id, season) {
  hideHover();
  stopHeroVideo();
  const item = byId(id);
  if (!item) return;
  let s = season;
  if (s == null && item.kind === 'series') {
    const info = playInfo(item);
    s = info ? info.file.season : item.seasons[0].number;
  }
  S.details = { id, season: s };
  $('#modal-root').innerHTML = `<div class="overlay" data-close="1" id="details-overlay"><div class="details" role="dialog" aria-label="${esc(item.title)}"></div></div>`;
  renderDetails();
}

function episodeRowHTML(e, label, series) {
  const p = S.progress[e.id];
  const watched = isWatched(p);
  const pct = p ? Math.min(1, p.t / p.d) : 0;
  return `<div class="ep" data-act="play-file" data-file="${esc(e.id)}">
    <div class="ep-num">${e.episode}</div>
    <div class="ep-thumb">${e.still ? `<img src="${e.still}" loading="lazy" alt="" />` : ''}${DL.overlay(e.id) || Conv.overlay(e.id)}<div class="playov"><span>${ICON.play}</span></div>${pct > 0 ? `<div class="pbar"><i style="width:${Math.round(pct * 100)}%"></i></div>` : ''}</div>
    <div><div class="ep-title"><span>${label ? label + ' · ' : ''}${esc(e.title)}${Copies.lengthSuffix(e.id)}</span>${(S.copies && S.copies.versionOf[e.id]) ? Copies.cardBits(e.id) : ''}${DL.episodeTag(e) || (series ? Conv.episodeTag(e, series) : '')}<small>${e.duration ? fmtDuration(e.duration) : ''}</small></div>
    <p class="ep-ov">${esc(e.overview || (watched ? 'Watched' : p && p.t > 10 ? fmtDuration(p.d - p.t) + ' left' : ''))}</p></div>
    <div class="ep-btns">${Menus.episodeButtonsHTML(e)}
    <button class="ep-mark ${watched ? 'on' : ''}" data-act="mark" data-file="${esc(e.id)}" title="${watched ? 'Mark as unwatched' : 'Mark as watched'}" aria-label="${watched ? 'Mark as unwatched' : 'Mark as watched'}">${ICON.check}</button></div>
  </div>`;
}

function renderDetails() {
  const box = $('.details');
  if (!box || !S.details) return;
  const item = byId(S.details.id);
  if (!item) return closeModal();
  const info = playInfo(item);
  const inList = S.list.includes(item.id);
  let body = '';
  if (item.kind === 'series') {
    const season = item.seasons.find((s) => s.number === S.details.season) || item.seasons[0];
    const allWatched = season.episodes.every((e) => isWatched(S.progress[e.id]));
    body = `<div class="eps-head"><h3>Episodes</h3><div style="display:flex;gap:10px;align-items:center">
      <button class="btn btn-sm btn-ghost" data-act="mark-season" data-season="${season.number}">${ICON.check}${allWatched ? 'Mark season unwatched' : 'Mark season watched'}</button>
      ${
        item.seasons.length > 1
          ? `<select class="select" id="season-select">${item.seasons.map((s) => `<option value="${s.number}" ${s.number === season.number ? 'selected' : ''}>${esc(s.name)} (${s.episodes.length})</option>`).join('')}</select>`
          : `<span style="color:#aaa">${esc(season.name)}</span>`
      }</div></div>
      <div>${season.episodes.map((e) => episodeRowHTML(e, '', item)).join('')}</div>`;
  }
  const progressBar =
    info && info.pct > 0 && info.p
      ? `<div class="d-progress">${info.series ? `<b>${epCode(info.file)}</b>` : ''}<div class="bar"><i style="width:${Math.round(info.pct * 100)}%"></i></div>${fmtDuration(info.p.d - info.p.t)} left</div>`
      : '';
  const fileItem = item.kind === 'film' ? item : null;
  // Downloading: the Play button becomes the purple pie. For a series it's the episode picked
  // (clicked, or Play pressed on it), else the one Play would start.
  let dlFile = null;
  if (fileItem) dlFile = DL.of(item.id) ? item : null;
  else {
    const picked = S.details.pick && allEpisodes(item).find((e) => e.id === S.details.pick);
    const cand = picked || (info && info.file);
    dlFile = cand && DL.of(cand.id) ? cand : null;
  }
  const pieShown = dlFile && DL.downloading(dlFile.id);
  const dlLine = dlFile ? DL.line(dlFile, fileItem ? '' : epCode(dlFile)) : '';
  box.innerHTML = `
    <button class="d-close" data-act="close-modal" aria-label="Close">${ICON.x}</button>
    <div class="d-hero">${item.backdrop ? `<img src="${item.backdrop}" alt="" />` : `<div style="position:absolute;inset:0;background:linear-gradient(120deg,hsl(${hashHue(item.title)} 40% 24%),#181818)"></div>`}
      <div class="d-hero-info"><h2 class="d-title">${esc(item.title)}${Copies.lengthSuffix(item.id)}</h2>
        <div class="d-actions">
          ${pieShown ? DL.pie(dlFile) : `<button class="btn btn-light" data-act="play" data-id="${esc(item.id)}">${ICON.play}${esc(info ? info.label : 'Play')}</button>`}
          ${info && info.pct > 0 ? `<button class="btn btn-grey btn-sm" style="height:44px" data-act="restart" data-id="${esc(item.id)}">Start over</button>` : ''}
          ${Menus.buttonsHTML(item)}
          ${fileItem ? `<button class="round" data-act="mark" data-file="${esc(item.id)}" title="${isWatched(S.progress[item.id]) ? 'Mark as unwatched' : 'Mark as watched'}" aria-label="Toggle watched" style="${isWatched(S.progress[item.id]) ? 'background:var(--good);border-color:var(--good)' : ''}">${ICON.check}</button>` : ''}
          ${continueWatching(null).some((x) => x.item.id === item.id) ? `<button class="btn btn-grey btn-sm" style="height:44px" data-act="cw-hide" data-id="${esc(item.id)}">${ICON.x}Remove from Continue watching</button>` : ''}
        </div>
      </div>
    </div>
    <div class="d-body">
      <div class="d-cols">
        <div>
          <div class="d-meta">${metaBits(item)}${isNew(item) ? '<span class="badge" style="border-color:var(--accent);color:var(--accent)">NEW</span>' : ''}</div>
          ${progressBar}
          ${Copies.detailsHTML(item)}
          ${dlLine || (fileItem && DL.of(item.id) ? '' : Conv.detailsHTML(item))}
          ${item.tagline ? `<div class="d-tagline">${esc(item.tagline)}</div>` : ''}
          <p class="d-overview">${esc(item.overview || (S.model.tmdb ? 'No description found. If this is the wrong title, use "Fix match" below.' : 'Add a TMDB key in Settings to get descriptions and posters.'))}</p>
        </div>
        <div class="d-side">
          ${item.genres.length ? `<div><span>Genres: </span>${item.genres.map(esc).join(', ')}</div>` : ''}
          ${Coll.inLine(item)}
          ${item.kind === 'series' ? `<div><span>In your library: </span>${item.episodeCount} episode${item.episodeCount === 1 ? '' : 's'}</div>` : ''}
          ${fileItem && fileItem.subs.length ? `<div><span>Subtitles: </span>${fileItem.subs.map((s) => esc(s.label)).join(', ')}</div>` : ''}
        </div>
      </div>
      ${body}
      <div class="d-foot">
        ${S.model.tmdb ? `<button data-act="fix-match" data-id="${esc(item.id)}">Wrong title or poster? Fix match</button>` : ''}
        ${fileItem ? `<button data-act="reveal" data-file="${esc(item.id)}">Show file in folder</button>` : ''}
        ${S.profile.kids ? '' : `<button data-act="kids-toggle" data-id="${esc(item.id)}">${kidsOk(item) ? 'Hide from kids profiles' : 'Show on kids profiles'}</button>`}
      </div>
    </div>`;
  const sel = $('#season-select');
  if (sel)
    sel.addEventListener('change', () => {
      S.details.season = Number(sel.value);
      renderDetails();
    });
}

function closeModal() {
  const hadDetails = !!S.details;
  const backTo = S.details && S.details.fromColl; // a title opened from a collection's page
  const hadColl = Coll.isOpen();
  S.details = null;
  $('#modal-root').innerHTML = '';
  if (hadColl) Coll.afterClose();
  if (backTo) return Coll.openPage(backTo);
  if (hadDetails && S.pendingRender) scheduleRender();
}

/* ---------- fix match ---------- */
// The Fix match window lives in unmatched-ui.js (shared with the Unmatched tab).
function openFixMatch(id) {
  Unmatched.openFix(id);
}

/* ---------- settings ---------- */
// Settings has four tabs: Library, Find videos, Playback and App. Kids profiles see only Playback
// and App, so they can't change the folder, the TMDB key or what's in Couchbox. Settings reopens
// on the last tab used (S.settingsTab), until Couchbox closes.
const SETTINGS_TABS = [
  ['library', 'Library'],
  ['find', 'Find videos'],
  ['playback', 'Playback'],
  ['app', 'App'],
];
function settingsTabs() {
  const kids = !!(S.profile && S.profile.kids);
  return SETTINGS_TABS.filter(([k]) => !kids || k === 'playback' || k === 'app');
}
// A locked profile's PIN is asked every time Settings opens (not when switching its tabs).
async function openSettings(err, tab) {
  if (S.profile && S.profile.locked && !$('#modal-root .settings-dlg')) {
    if (!(await Pin.ask({ profile: S.profile, note: 'to open Settings' }))) return;
  }
  showSettings(err, tab);
}
function showSettings(err, tab) {
  hideHover();
  S.details = null;
  const st = S.settings;
  const tabs = settingsTabs();
  if (err) tab = 'library'; // a TMDB key problem: show it where the key is
  if (!tab) tab = S.settingsTab;
  if (!tabs.some(([k]) => k === tab)) tab = tabs[0][0];
  S.settingsTab = tab;
  const bar = `<div class="stabs" role="tablist">${tabs
    .map(([k, l]) => `<button role="tab" aria-selected="${k === tab}" class="${k === tab ? 'on' : ''}" data-act="settings-tab" data-tab="${k}">${l}${Conv.tabHasWarning(k) ? Conv.dot() : ''}</button>`)
    .join('')}</div>`;
  const head = `<h2 style="margin-bottom:14px">Settings</h2>${bar}`;
  const ov = `<div class="overlay${$('#modal-root .settings-dlg') ? ' no-anim' : ''}" data-close="1">`;
  if (tab === 'find') {
    $('#modal-root').innerHTML = `${ov}<div class="dialog dialog-wide settings-dlg">
      ${head}<div id="finder-host"></div>
      <div class="row-btns" style="margin-top:16px"><button class="btn btn-sm btn-ghost" data-act="close-modal">Close</button></div>
    </div></div>`;
    FinderUI.open($('#finder-host'));
    return;
  }
  const body = {
    library: `
    <div class="settings-section"><h3>Video folder</h3>
      <div class="path">${esc(st.libraryPath || 'Not set')}</div>
      <div class="inline"><button class="btn btn-sm btn-ghost" data-act="choose-folder">${ICON.folder}Change folder</button><button class="btn btn-sm btn-ghost" data-act="rescan">Rescan now</button>${st.libraryPath ? '<button class="btn btn-sm btn-ghost" data-act="open-folder">Open folder</button>' : ''}</div>
    </div>
    <div class="settings-section"><h3>Posters and info (TMDB)</h3>
      <p style="margin:0 0 10px;font-size:14px">${st.hasTmdbKey ? 'A key is saved. Posters and descriptions are on.' : 'No key saved, so Couchbox uses frames from your videos instead of posters.'} <span class="link" data-act="open-tmdb">Get a free key</span></p>
      <div class="inline"><input class="input" id="set-key" placeholder="${st.hasTmdbKey ? 'Paste a new key to replace it' : 'Paste your TMDB key'}" spellcheck="false" /><button class="btn btn-sm btn-ghost" data-act="settings-save-key">Save</button></div>
      ${err ? `<div class="err">${esc(err)}</div>` : ''}
      <div class="inline" style="margin-top:10px">${st.hasTmdbKey ? '<button class="btn btn-sm btn-ghost" data-act="remove-key">Remove key</button><button class="btn btn-sm btn-ghost" data-act="refetch">Fetch all info again</button>' : ''}</div>
    </div>
    ${Copies.sectionHTML()}`,
    playback: `
    <div class="settings-section">
      <label class="toggle"><span class="t-text"><b>Autoplay next episode</b><small>Starts the next episode after a short countdown.</small></span><span class="switch"><input type="checkbox" data-setting="autoplayNext" ${st.autoplayNext ? 'checked' : ''} /><span></span></span></label>
      <label class="toggle"><span class="t-text"><b>Previews</b><small>Plays muted clips when you hover over a title or wait on the banner.</small></span><span class="switch"><input type="checkbox" data-setting="previews" ${st.previews ? 'checked' : ''} /><span></span></span></label>
    </div>
    ${Conv.sectionHTML() || '<div id="conv-section"></div>'}`,
    app: `
    <div class="settings-section"><h3>Sounds</h3>
      <label class="toggle"><span class="t-text"><b>Opening sounds</b><small>An organ while Couchbox starts and a warm chord when it opens.</small></span><span class="switch"><input type="checkbox" data-setting="openingSounds" ${st.openingSounds ? 'checked' : ''} /><span></span></span></label>
      ${S.profile ? `<label class="toggle"><span class="t-text"><b>Click sounds for ${esc(S.profile.name)}</b><small>A quiet tap on buttons, tabs and cards. Each profile has its own setting.</small></span><span class="switch"><input type="checkbox" id="set-clicks" ${S.profile.clicks !== false ? 'checked' : ''} /><span></span></span></label>` : ''}
      <div class="toggle"><span class="t-text"><b>Volume</b><small>For all Couchbox sounds. Videos have their own volume.</small></span><span class="snd-vol"><input type="range" id="set-sound-vol" min="0" max="1" step="0.05" value="${st.soundVolume}" aria-label="Sound volume" /><span id="set-sound-pct">${Math.round(st.soundVolume * 100)}%</span></span></div>
    </div>
    <div class="settings-section"><h3>When Couchbox opens</h3>
      <div class="open-modes" role="radiogroup" aria-label="When Couchbox opens">${[
        ['window', 'Window', 'A 1400 × 860 window in the middle of the screen.'],
        ['maximized', 'Maximised', 'Fills the screen, with the title bar.'],
        ['fullscreen', 'Full screen', 'No title bar or taskbar. Esc or F11 leaves it.'],
        ['remember', 'Remember last', 'Opens exactly as you left it.'],
      ].map(([v, l, d]) => `<label class="open-mode"><input type="radio" name="open-mode" value="${v}" ${st.openMode === v ? 'checked' : ''} /><span><b>${l}</b><small>${d}</small></span></label>`).join('')}</div>
      <label class="toggle" style="margin-top:12px"><span class="t-text"><b>Start with Windows</b><small>Couchbox starts hidden by the clock, ready to convert new videos. Closing the window always keeps it running there.</small></span><span class="switch"><input type="checkbox" data-setting="startWithWindows" ${st.startWithWindows ? 'checked' : ''} /><span></span></span></label>
      ${st.shellMenuAvailable ? `<label class="toggle"><span class="t-text"><b>Show Couchbox in the right-click menu</b><small>Right-click videos or folders in File Explorer and choose Couchbox, then Copy or Move to Couchbox. On Windows 11 it's under Show more options.</small></span><span class="switch"><input type="checkbox" id="set-shellmenu" ${st.shellMenu ? 'checked' : ''} /><span></span></span></label><div class="err" id="shellmenu-err" hidden></div>` : ''}
    </div>
    <div class="settings-section"><h3>Updates</h3><div id="settings-updates"></div></div>
    <div class="settings-section"><h3>What's new</h3><div id="settings-whatsnew"></div></div>`,
  }[tab];
  $('#modal-root').innerHTML = `${ov}<div class="dialog settings-dlg" style="width:min(640px,92vw)">
    ${head}${body}
    <div class="row-btns"><button class="btn btn-sm btn-accent" data-act="close-modal">Done</button></div>
  </div></div>`;
  Updates.renderSettings();
  WhatsNew.renderSettings();
  Conv.bindSection();
  $$('[data-setting]').forEach((c) =>
    c.addEventListener('change', async () => {
      S.settings = await cb.setSettings({ [c.dataset.setting]: c.checked });
    })
  );
  const menuSw = $('#set-shellmenu');
  if (menuSw)
    menuSw.addEventListener('change', async () => {
      const err = await cb.setShellMenu(menuSw.checked);
      const box = $('#shellmenu-err');
      box.hidden = !err;
      box.textContent = err || '';
      if (err) menuSw.checked = !menuSw.checked;
      else S.settings.shellMenu = menuSw.checked;
    });
  const clicks = $('#set-clicks');
  if (clicks)
    clicks.addEventListener('change', async () => {
      const id = S.profile.id;
      S.profiles = await cb.saveProfiles(S.profiles.map((p) => (p.id === id ? { ...p, clicks: clicks.checked } : p)));
      S.profile = S.profiles.find((p) => p.id === id);
    });
  const vol = $('#set-sound-vol');
  if (vol) {
    const saveVol = debounce(async (v) => (S.settings = await cb.setSettings({ soundVolume: v })), 300);
    vol.addEventListener('input', () => {
      const v = Number(vol.value);
      S.settings.soundVolume = v;
      $('#set-sound-pct').textContent = Math.round(v * 100) + '%';
      Sounds.play('tap', v); // a preview at the new level
      saveVol(v);
    });
  }
  $$('input[name="open-mode"]').forEach((r) =>
    r.addEventListener('change', async () => {
      if (r.checked) S.settings = await cb.setSettings({ openMode: r.value });
    })
  );
}

/* ---------- click sounds ---------- */
// The soft tap on buttons, tabs, menus, cards, profiles, My list and Settings toggles. Never while
// the player is open. Uses the current profile's setting (or the last profile's on the profile
// screen). Label + checkbox clicks arrive as two events, so close repeats are ignored.
let lastTap = 0;
function clicksOn() {
  const p = S.profile || S.profiles.find((x) => x.id === S.lastProfile);
  return !p || p.clicks !== false;
}
document.addEventListener(
  'click',
  (e) => {
    if (!S.settings || Player.isOpen()) return;
    const hit = e.target.closest('button, a, [data-act], .card, [role="tab"], label.toggle, label.f-check, label.open-mode, .f-choice, input[type="checkbox"], input[type="radio"]');
    if (!hit || hit.disabled || hit.closest('#player')) return;
    const now = performance.now();
    if (now - lastTap < 80) return;
    lastTap = now;
    if (clicksOn()) Sounds.play('tap', S.settings.soundVolume);
  },
  true
);

/* ---------- profile menu ---------- */
function toggleProfileMenu() {
  const old = $('#pmenu');
  if (old) return old.remove();
  const others = S.profiles.filter((p) => p.id !== S.profile.id);
  const m = document.createElement('div');
  m.className = 'menu';
  m.id = 'pmenu';
  m.innerHTML = `${others.map((p) => `<button data-act="pick-profile" data-pid="${p.id}">${avatarHTML(p)}${esc(p.name)}</button>`).join('')}
    <button data-act="manage-profiles">${ICON.pencil}Manage profiles</button>
    <hr /><button data-act="settings">${ICON.gear}Settings${S.warnings.length ? Conv.dot() : ''}</button><button data-act="switch-profile">${ICON.back}Switch profile</button>
    <hr /><button data-act="quit-app">${ICON.x}Quit Couchbox</button>`;
  $('#app').appendChild(m);
}

/* ================= actions ================= */
async function toggleList(id) {
  S.list = await cb.toggleList(S.profile.id, id);
  const inList = S.list.includes(id);
  toast(inList ? 'Added to My list' : 'Removed from My list', 1800);
  $$(`[data-act="list"][data-id="${CSS.escape(id)}"]`).forEach((b) => {
    b.innerHTML = inList ? ICON.check : ICON.plus;
    b.title = inList ? 'Remove from My list' : 'Add to My list';
  });
  if (!S.details) renderContent(true);
}

async function setWatched(fileIds, watched) {
  const entries = fileIds.map((id) => {
    const f = findEpisode(id)?.ep || byId(id);
    const d = Math.max(1, Math.round(f.duration || 1));
    return watched ? [id, d, d] : [id, null, null];
  });
  S.progress = await cb.bulkProgress(S.profile.id, entries);
  renderDetails();
  renderContent(true);
}

function play(item, fromStart = false) {
  const info = playInfo(item);
  if (!info) return;
  if (fromStart && item.kind === 'series') {
    info.file = allEpisodes(item).find((e) => e.season !== 0) || allEpisodes(item)[0];
    info.series = item;
  }
  startPlayer(info.file, info.series || null, fromStart ? 0 : info.startAt);
}

function playFile(fileId) {
  const found = findEpisode(fileId);
  if (found) {
    const p = S.progress[fileId];
    startPlayer(found.ep, found.series, p && !isWatched(p) && p.t > 30 ? p.t - 3 : 0);
  } else {
    const f = byId(fileId);
    if (f) play(f);
  }
}

// A file still downloading opens its details page (with the pie-shaped Play button) instead;
// `anyway` (the pie itself) plays what's downloaded so far.
function startPlayer(file, series, startAt, anyway = false) {
  hideHover();
  stopHeroVideo();
  if (!anyway && DL.downloading(file.id)) {
    const id = series ? series.id : file.id;
    if (!S.details || S.details.id !== id) openDetails(id, series ? file.season : undefined);
    if (S.details) {
      S.details.pick = file.id;
      renderDetails();
    }
    return;
  }
  Player.open({ file, series, startAt, onClose: afterPlayer });
}

function afterPlayer() {
  if (S.details) renderDetails();
  renderContent(true);
  if (S.pendingRender) scheduleRender();
}

document.addEventListener('click', async (e) => {
  const menu = $('#pmenu');
  if (menu && clickedOff(e, '#pmenu, [data-act="profile-menu"]')) menu.remove();
  const ov = e.target.closest('.overlay');
  if (ov && ov.dataset.close && clickedOn(e, ov)) return closeModal();
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;
  const id = el.dataset.id;
  if (act.startsWith('conv-')) {
    e.stopPropagation();
    return Conv.act(act, el);
  }
  if (act.startsWith('wn-')) return WhatsNew.act(act);
  if (act.startsWith('coll-')) {
    e.stopPropagation();
    return Coll.act(act, el);
  }
  if (act === 'cw-hide') return hideFromCw(id);
  if (act.startsWith('menu-')) {
    e.stopPropagation();
    return Menus.act(act, el);
  }
  if (act.startsWith('copy-') || act.startsWith('version-')) {
    e.stopPropagation();
    return Copies.act(act, el);
  }
  switch (act) {
    case 'choose-folder': {
      const st = await cb.chooseFolder();
      if (st) {
        S.settings = st;
        if (!S.profile) render();
        else openSettings();
      }
      break;
    }
    case 'open-tmdb':
      cb.openTmdb();
      break;
    case 'save-key':
    case 'settings-save-key': {
      const input = act === 'save-key' ? $('#tmdbkey') : $('#set-key');
      const key = input.value.trim();
      if (!key) {
        act === 'save-key' ? renderSetup($('#app'), 'Paste a key first') : openSettings('Paste a key first');
        return;
      }
      el.textContent = 'Checking…';
      const r = await cb.setTmdbKey(key);
      if (!r.ok) return act === 'save-key' ? renderSetup($('#app'), r.error) : openSettings(r.error);
      S.settings = r.settings;
      toast('TMDB key saved. Fetching posters…');
      act === 'save-key' ? renderSetup($('#app')) : openSettings();
      break;
    }
    case 'remove-key': {
      const r = await cb.setTmdbKey('');
      S.settings = r.settings;
      openSettings();
      break;
    }
    case 'refetch':
      cb.clearMetadata();
      toast('Fetching everything again…');
      closeModal();
      break;
    case 'rescan':
      cb.refresh();
      toast('Rescanning your folder…');
      break;
    case 'open-folder':
      cb.openFolder().then((err) => err && toast(err, 5000));
      break;
    case 'setup-done':
      render();
      break;
    case 'pick-profile':
      $('#pmenu') && $('#pmenu').remove();
      pickProfile(el.dataset.pid);
      break;
    case 'add-profile':
      // Once any profile has a PIN, adding one needs a grown-up's PIN (so kids can't get round it).
      if (S.profiles.some((p) => p.locked) && !(await Pin.ask({ full: true, note: 'to add a profile' }))) break;
      openProfileEditor(null);
      break;
    case 'edit-profile': {
      const p = S.profiles.find((x) => x.id === el.dataset.pid);
      if (p && p.locked && !(await Pin.ask({ profile: p, full: true, note: 'to change this profile' }))) break;
      openProfileEditor(el.dataset.pid);
      break;
    }
    case 'toggle-manage':
      S.managing = !S.managing;
      render();
      break;
    case 'manage-profiles':
      S.profile = null;
      S.managing = true;
      render();
      break;
    case 'switch-profile':
      S.profile = null;
      S.managing = false;
      render();
      break;
    case 'profile-menu':
      toggleProfileMenu();
      break;
    case 'settings':
      $('#pmenu') && $('#pmenu').remove();
      openSettings();
      break;
    case 'tab':
      S.tab = el.dataset.tab;
      S.query = '';
      if ($('#search')) {
        $('#search').value = '';
        $('#searchbox').classList.remove('open');
      }
      $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === S.tab));
      renderContent();
      break;
    case 'open':
      openDetails(id);
      break;
    case 'play':
      play(byId(id));
      break;
    case 'restart':
      play(byId(id), true);
      break;
    case 'play-file':
      if (e.target.closest('[data-act="mark"]')) break;
      playFile(el.dataset.file);
      break;
    case 'quit-app':
      $('#pmenu')?.remove();
      cb.quit(); // asks first if conversions are running
      break;
    case 'play-partial': {
      // The pie: play what's downloaded so far.
      const found = findEpisode(el.dataset.file);
      const f = found ? found.ep : byId(el.dataset.file);
      if (f) startPlayer(f, found ? found.series : null, 0, true);
      break;
    }
    case 'list':
      toggleList(id);
      break;
    case 'mark': {
      e.stopPropagation();
      const f = el.dataset.file;
      setWatched([f], !isWatched(S.progress[f]));
      break;
    }
    case 'mark-season': {
      const item = byId(S.details.id);
      const season = item.seasons.find((s) => s.number === Number(el.dataset.season));
      const all = season.episodes.every((x) => isWatched(S.progress[x.id]));
      setWatched(season.episodes.map((x) => x.id), !all);
      break;
    }
    case 'close-modal':
      closeModal();
      break;
    case 'settings-tab':
      openSettings(null, el.dataset.tab);
      break;
    case 'exit-full':
      cb.fullscreen(false);
      break;
    case 'fix-match':
      Unmatched.openFix(id, el.dataset.from === 'tab');
      break;
    case 'reveal':
      cb.reveal(el.dataset.file);
      break;
    case 'kids-toggle': {
      const item = byId(id);
      const allow = !kidsOk(item);
      S.kidsAllow = await cb.setKidsAllow(id, allow === item.kidsSafe ? null : allow);
      toast(allow ? 'Now shown on kids profiles' : 'Hidden from kids profiles', 2200);
      renderDetails();
      break;
    }
    case 'row-l':
    case 'row-r': {
      const track = el.parentElement.querySelector('.track');
      track.scrollBy({ left: (act === 'row-l' ? -1 : 1) * track.clientWidth * 0.85 });
      break;
    }
    case 'hero-mute':
      if (heroVideo) {
        heroVideo.muted = !heroVideo.muted;
        heroVideo.volume = S.settings.volume;
        el.innerHTML = heroVideo.muted ? ICON.mute : ICON.volume;
      }
      break;
  }
});

// Click on the episode tick inside an episode row should not start playback.
document.addEventListener(
  'click',
  (e) => {
    const mark = e.target.closest('.ep [data-act="mark"]');
    if (mark) {
      e.stopPropagation();
      const f = mark.dataset.file;
      setWatched([f], !isWatched(S.progress[f]));
    }
  },
  true
);

document.addEventListener('mouseover', (e) => {
  const card = e.target.closest('.card');
  if (card && !e.relatedTarget?.closest?.('.card')?.isSameNode(card)) scheduleHover(card);
});
document.addEventListener('mouseout', (e) => {
  const card = e.target.closest('.card');
  if (card && !card.contains(e.relatedTarget)) clearTimeout(hoverTimer);
});
$('#hovercard').addEventListener('mouseleave', hideHover);
document.addEventListener('keydown', (e) => {
  if (Player.isOpen()) return;
  if (e.key === 'Escape') {
    if ($('#pmenu')) $('#pmenu').remove();
    else if ($('#modal-root').innerHTML) {
      if (!$('#modal-root .overlay[data-close=""]')) closeModal();
    } else if (document.body.classList.contains('is-full')) cb.fullscreen(false); // nothing open: leave fullscreen
    hideHover();
  }
  if (e.key === 'Enter' && document.activeElement && document.activeElement.classList.contains('card')) openDetails(document.activeElement.dataset.id);
  if (e.key === '/' && document.activeElement.tagName !== 'INPUT' && $('#search')) {
    e.preventDefault();
    $('#searchbox').classList.add('open');
    $('#search').focus();
  }
});
$('#app').addEventListener(
  'scroll',
  () => {
    hideHover();
    const nav = $('#nav');
    if (nav) nav.classList.toggle('solid', $('#app').scrollTop > 40);
    if (heroVideo && $('#app').scrollTop > window.innerHeight * 0.6) stopHeroVideo();
  },
  { passive: true }
);
window.addEventListener('resize', hideHover);

boot();
