/* What's new: every version and what it added (from CHANGELOG.md), in Settings, App, and a
   one-time card after an update. */
const WhatsNew = (() => {
  let data = null; // { entries, current, whatsNew }
  let showAll = false;
  const GROUPS = [['New', 'new'], ['Improved', 'imp'], ['Fixed', 'fix']];

  async function load() {
    if (!data) data = await cb.changelog();
    return data;
  }

  function entryHTML(e) {
    const groups = GROUPS.filter(([g]) => e.groups[g] && e.groups[g].length)
      .map(([g, cls]) => `<div class="wn-grp ${cls}">${g}</div><ul>${e.groups[g].map((i) => `<li>${esc(i)}</li>`).join('')}</ul>`)
      .join('');
    return `<div class="wn-ver"><div class="wn-head"><span class="wn-num">${esc(e.version)}</span><span class="wn-date">${esc(e.date)}</span>${e.version === data.current ? '<span class="wn-you">You have this</span>' : ''}</div>
      <div class="wn-line">${esc(e.headline)}</div>${groups}</div>`;
  }

  // Settings, App: the newest three, then the rest on request.
  async function renderSettings() {
    const box = $('#settings-whatsnew');
    if (!box) return;
    await load();
    const list = showAll ? data.entries : data.entries.slice(0, 3);
    const older = data.entries.slice(3);
    box.innerHTML = list.map(entryHTML).join('') +
      (older.length ? `<button class="link wn-more" data-act="wn-more">${showAll ? 'Show fewer' : `Show older versions (${older[0].version} to ${older[older.length - 1].version})`}</button>` : '');
  }

  // After an update: a card with that version's headline and what's new, once.
  async function maybeShowCard() {
    await load();
    if (!data.whatsNew || $('#wn-card')) return;
    const e = data.entries.find((x) => x.version === data.whatsNew);
    if (!e) return;
    const items = [...(e.groups.New || []), ...(e.groups.Improved || [])];
    const shown = items.slice(0, 4);
    const el = document.createElement('div');
    el.id = 'wn-card';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', `What's new in ${e.version}`);
    el.innerHTML = `<div class="wn-card-title">What's new in ${esc(e.version)}</div>
      <div class="wn-card-head">${esc(e.headline)}</div>
      <ul>${shown.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>
      ${items.length > shown.length ? `<div class="wn-card-more">and ${items.length - shown.length} more</div>` : ''}
      <div class="wn-card-btns"><button class="btn btn-sm btn-accent" data-act="wn-all">See all versions</button><button class="btn btn-sm btn-ghost" data-act="wn-ok">Got it</button></div>`;
    document.body.appendChild(el);
  }

  function closeCard() {
    $('#wn-card')?.remove();
    if (data && data.whatsNew) {
      data.whatsNew = null;
      cb.changelogSeen();
    }
  }

  function act(a) {
    if (a === 'wn-more') {
      showAll = !showAll;
      renderSettings();
    } else if (a === 'wn-ok') closeCard();
    else if (a === 'wn-all') {
      closeCard();
      openSettings(null, 'app');
      setTimeout(() => $('#settings-whatsnew')?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 80);
    } else return false;
    return true;
  }

  return { renderSettings, maybeShowCard, act };
})();
