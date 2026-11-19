/* Hint pop-ups: short tips shown the first time you do something that needs explaining.
   Every hint is listed here, so they can all be found and shown again in Settings, App, Hints.
   A hint you tick "Don't show this again" on is remembered in settings (hintsOff: { id: when }).
   (Endpaper's hints.js, the master copy, in Couchbox's own window style.)

   Adding a hint: give it an id, a title, the text and where it shows, then call
   `await Hints.show('id')` just before the thing it explains. */
const Hints = (() => {
  const LIST = {
    'plus-menu': {
      title: 'My list and collections',
      text: 'Tick My list and any of your collections here: a title can be in as many as you like. New collection makes one with this title already in it.',
      where: 'The first time you open + on a title',
    },
    'delete-bin': {
      title: 'Deleted videos wait in the bin',
      text: "Deleting moves the video and its subtitles to the bin for 7 days. Until then you can put it back from Settings, Playback, Bin. After 7 days it's gone for good.",
      where: 'The first time you choose Delete from Couchbox',
    },
  };

  const off = () => (S.settings && S.settings.hintsOff) || {};
  const isOff = (id) => !!off()[id];
  async function save(hintsOff) {
    S.settings = await cb.setSettings({ hintsOff });
  }

  let layer = null;
  // Shows a hint unless it's been turned off. Resolves when it's closed (OK, Esc or a click outside).
  function show(id) {
    const h = LIST[id];
    if (!h || isOff(id) || (layer && layer.innerHTML)) return Promise.resolve();
    if (!layer) {
      layer = document.createElement('div');
      layer.id = 'hint-layer';
      document.body.appendChild(layer);
    }
    hideHover();
    layer.innerHTML = `<div class="pin-overlay hint-ov"><div class="pin-window hint-pop" role="dialog" aria-label="${esc(h.title)}">
      <h2 class="pin-title">${esc(h.title)}</h2><p class="hint-text">${esc(h.text)}</p>
      <div class="hint-actions"><label class="hint-off"><input type="checkbox" data-hint-off /> Don't show this again</label><button class="btn btn-sm btn-accent" data-hint-ok>OK</button></div></div></div>`;
    return new Promise((resolve) => {
      const close = async () => {
        document.removeEventListener('keydown', onKey, true);
        const turnOff = layer.querySelector('[data-hint-off]').checked;
        layer.innerHTML = '';
        if (turnOff) await save({ ...off(), [id]: Date.now() });
        resolve();
      };
      const onKey = (e) => {
        if (e.key !== 'Escape' && e.key !== 'Enter') return;
        e.stopPropagation();
        e.preventDefault();
        close();
      };
      document.addEventListener('keydown', onKey, true);
      layer.querySelector('[data-hint-ok]').onclick = close;
      const ov = layer.querySelector('.hint-ov');
      ov.addEventListener('click', (e) => clickedOn(e, ov) && close());
      setTimeout(() => layer.querySelector('[data-hint-ok]').focus(), 0);
    });
  }

  async function reset(id) {
    const next = { ...off() };
    delete next[id];
    await save(next);
  }
  const resetAll = () => save({});

  /* ---------- Settings, App, Hints ---------- */
  const ago = (t) => {
    const d = Math.round((Date.now() - t) / 864e5);
    return d <= 0 ? 'today' : d === 1 ? 'yesterday' : `${d} days ago`;
  };
  function settingsHTML() {
    const ids = Object.keys(LIST);
    const hidden = ids.filter(isOff).length;
    return `<p class="conv-note">Tips that pop up the first time you do something. Ones you've turned off can be shown again here.</p>
      <div class="hint-list">${ids
        .map((id) => {
          const h = LIST[id];
          const when = off()[id];
          return `<div class="hint-row"><div><b>${esc(h.title)}</b><small>${esc(h.where)}</small></div>
            ${when ? `<span class="hint-state">Turned off ${typeof when === 'number' ? ago(when) : ''}</span><button class="btn btn-sm btn-ghost" data-act="hint-reset" data-id="${id}">Show again</button>` : '<span class="hint-state">Showing</span><span></span>'}</div>`;
        })
        .join('')}</div>
      <div class="inline" style="margin-top:10px"><button class="btn btn-sm btn-ghost" data-act="hints-reset-all" ${hidden ? '' : 'disabled'}>Show all hints again</button></div>`;
  }

  return { LIST, show, isOff, reset, resetAll, settingsHTML };
})();
