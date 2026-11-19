/* The two small dropdown menus on hover cards, title pages and episode rows (look B, "ticks in
   the menu", chosen by the user):
   - the + menu: My list and each of your collections tick on and off, plus New collection (and,
     for a series, More choices… for a season or some episodes);
   - the cog menu: Reset intro skips… (series) and Delete from Couchbox… (grown-up profiles).
   Reset and Delete open a small window to choose and confirm (Delete: type DELETE). Deleted
   videos go to the 7-day bin with their subtitles (src/main/converter.js), restorable in
   Settings, Playback. */
const Menus = (() => {
  let open = null; // { el, anchor, render }
  const kids = () => !!(S.profile && S.profile.kids);
  const keyOf = (it) => Coll.keyOf(it);
  const fmtSize = (n) => (n >= 1024 ** 3 ? (n / 1024 ** 3).toFixed(1) + ' GB' : Math.max(1, Math.round(n / 1024 ** 2)) + ' MB');

  function close() {
    if (!open) return;
    const fromHover = open.anchor && open.anchor.closest('#hovercard');
    open.el.remove();
    if (open.anchor) open.anchor.classList.remove('on');
    open = null;
    // Opened from a hover card: it can go once the mouse isn't on it.
    if (fromHover && !$('#hovercard').matches(':hover')) hideHover();
  }
  const isOpen = () => !!open;
  const holdsHover = () => !!(open && open.anchor && open.anchor.closest('#hovercard'));

  // Shows a menu under (or above) its button.
  function show(anchor, render) {
    const same = open && open.anchor === anchor;
    close();
    if (same) return;
    const el = document.createElement('div');
    el.className = 'tmenu';
    el.setAttribute('role', 'menu');
    document.body.appendChild(el);
    anchor.classList.add('on');
    open = { el, anchor, render };
    draw();
  }
  function draw() {
    if (!open) return;
    open.el.innerHTML = open.render();
    const r = open.anchor.getBoundingClientRect();
    const w = open.el.offsetWidth;
    const h = open.el.offsetHeight;
    const left = Math.min(Math.max(8, r.left), innerWidth - w - 8);
    const below = r.bottom + 6 + h < innerHeight - 8;
    open.el.style.left = left + 'px';
    open.el.style.top = (below ? r.bottom + 6 : Math.max(8, r.top - h - 6)) + 'px';
  }

  /* ---------- the + menu ---------- */
  // what: { kind: 'film' | 'series' | 'episode', id }
  function plusHTML(what) {
    const cols = Coll.mineList();
    const it = { kind: what.kind, id: what.id };
    const inList = S.list.includes(what.id);
    const tick = (on) => `<span class="tm-tick">${on ? ICON.check : ''}</span>`;
    return `${what.kind !== 'episode' ? `<button class="tm-item" role="menuitemcheckbox" aria-checked="${inList}" data-m="list">${ICON.list}<span>My list</span>${tick(inList)}</button><div class="tm-sep"></div>` : ''}
      <div class="tm-head">Collections</div>
      ${cols.map((c) => {
        const on = c.items.some((x) => keyOf(x) === keyOf(it));
        return `<button class="tm-item" role="menuitemcheckbox" aria-checked="${on}" data-m="coll" data-cid="${esc(c.id)}"><span>${esc(c.name)}</span>${tick(on)}</button>`;
      }).join('')}
      ${what.kind === 'series' ? '<button class="tm-item" role="menuitem" data-m="more"><span>A season or some episodes…</span></button>' : ''}
      <button class="tm-item tm-accent" role="menuitem" data-m="new">${ICON.plus}<span>New collection</span></button>`;
  }
  async function openPlus(anchor, what) {
    // The first time: a hint about what the + holds (Settings, App, Hints).
    if (!Hints.isOff('plus-menu') && !(open && open.anchor === anchor)) {
      const fromHover = !!anchor.closest('#hovercard');
      await Hints.show('plus-menu');
      // The hint closes the hover card (the mouse leaves it to reach OK): open it again for
      // the same title, then the menu on its +.
      if (!document.contains(anchor) && fromHover) {
        const card = [...document.querySelectorAll('.card')].find((c) => c.dataset.id === what.id);
        if (card) showHover(card);
        anchor = document.querySelector('#hovercard [data-act="menu-plus"]');
      }
      if (!anchor || !document.contains(anchor)) return;
    }
    show(anchor, () => plusHTML(what));
    open.el.onclick = async (e) => {
      const b = e.target.closest('[data-m]');
      if (!b) return;
      e.stopPropagation();
      const m = b.dataset.m;
      if (m === 'list') {
        await toggleList(what.id);
        return draw();
      }
      if (m === 'coll') {
        await Coll.toggleItem(b.dataset.cid, { kind: what.kind, id: what.id });
        return draw();
      }
      if (m === 'more') {
        close();
        return Coll.pick({ kind: 'series', id: what.id }, { scopes: true, season: S.details && S.details.id === what.id ? S.details.season : undefined });
      }
      if (m === 'new') {
        close();
        return Coll.createWith({ kind: what.kind, id: what.id });
      }
    };
  }

  /* ---------- the cog menu ---------- */
  // target: { kind: 'film' | 'series' | 'episode', id }
  function cogItems(target) {
    const out = [];
    if (target.kind === 'series') out.push(['reset', ICON.rotate, 'Reset intro skips…']);
    if (!kids()) out.push(['delete', ICON.trash, target.kind === 'episode' ? 'Delete this episode…' : 'Delete from Couchbox…']);
    return out;
  }
  const hasCog = (target) => cogItems(target).length > 0;
  function openCog(anchor, target) {
    show(anchor, () => cogItems(target).map(([m, icon, label]) => `<button class="tm-item ${m === 'delete' ? 'tm-danger' : ''}" role="menuitem" data-m="${m}">${icon}<span>${label}</span></button>`).join(''));
    open.el.onclick = (e) => {
      const b = e.target.closest('[data-m]');
      if (!b) return;
      e.stopPropagation();
      close();
      if (b.dataset.m === 'reset') return resetWindow(target.id);
      if (b.dataset.m === 'delete') return Hints.show('delete-bin').then(() => deleteWindow(target));
    };
  }

  /* ---------- the windows (Reset, Delete) ---------- */
  let layer = null;
  let onKey = null;
  function win(html) {
    if (!layer) {
      layer = document.createElement('div');
      layer.id = 'menu-layer';
      document.body.appendChild(layer);
    }
    closeWin();
    layer.innerHTML = `<div class="pin-overlay"><div class="pin-window cpk" role="dialog">${html}</div></div>`;
    onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      e.preventDefault();
      closeWin();
    };
    document.addEventListener('keydown', onKey, true);
    return layer;
  }
  function closeWin() {
    if (onKey) document.removeEventListener('keydown', onKey, true);
    onKey = null;
    if (layer) layer.innerHTML = '';
  }
  const seasonName = (s) => (s.number === 0 ? 'Specials' : s.name || 'Season ' + s.number);
  const nEps = (n) => `${n} episode${n === 1 ? '' : 's'}`;

  // Reset intro skips: the whole series or one season, then Reset (the "are you sure?").
  function resetWindow(seriesId) {
    hideHover();
    const s = byId(seriesId);
    if (!s || s.kind !== 'series') return;
    const L = win(`<h2 class="pin-title">Reset intro skips</h2>
      <p class="pin-note">Reset intro skips for ${esc(s.title)}? Skip intro is found again from scratch, as if the episodes were new.</p>
      <div class="cpk-scope" role="radiogroup" aria-label="What to reset">
        <label><input type="radio" name="rs-scope" value="" checked /> The whole series</label>
        ${s.seasons.map((x) => `<label><input type="radio" name="rs-scope" value="${x.number}" /> ${esc(seasonName(x))} <small style="color:var(--faint)">${nEps(x.episodes.length)}</small></label>`).join('')}
      </div>
      <div class="row-btns"><button class="btn btn-sm btn-ghost" id="rs-cancel">Cancel</button><button class="btn btn-sm btn-accent" id="rs-go">Reset</button></div>`);
    $('#rs-cancel', L).onclick = closeWin;
    $('#rs-go', L).onclick = async () => {
      const v = $('input[name="rs-scope"]:checked', L).value;
      const season = v === '' ? null : Number(v);
      await cb.introReset(s.id, season);
      closeWin();
      const what = season == null ? s.title : `${s.title}, ${seasonName(s.seasons.find((x) => x.number === season))}`;
      toast(`Intro skips reset for ${what}. They'll be found again.`, 4000);
    };
  }

  // Delete from Couchbox: what goes, its size, the bin; type DELETE to enable Delete.
  function deleteWindow(target) {
    hideHover();
    let t = { ...target };
    const series = t.kind === 'series' ? byId(t.id) : null;
    const L = win(`<h2 class="pin-title">Delete from Couchbox</h2>
      ${series ? `<div class="cpk-scope" role="radiogroup" aria-label="What to delete">
        <label><input type="radio" name="dl-scope" value="" checked /> The whole series</label>
        ${series.seasons.map((x) => `<label><input type="radio" name="dl-scope" value="${x.number}" /> ${esc(seasonName(x))} <small style="color:var(--faint)">${nEps(x.episodes.length)}</small></label>`).join('')}
      </div>` : ''}
      <p class="pin-note" id="dl-what">Checking…</p>
      <label class="dl-type"><span>Type <b>DELETE</b> to confirm</span><input class="input" id="dl-word" autocomplete="off" spellcheck="false" aria-label="Type DELETE to confirm" /></label>
      <div class="err" id="dl-err" hidden></div>
      <div class="row-btns"><button class="btn btn-sm btn-ghost" id="dl-cancel">Cancel</button><button class="btn btn-sm btn-danger" id="dl-go" disabled>Delete</button></div>`);
    const word = $('#dl-word', L);
    const go = $('#dl-go', L);
    const err = (m) => {
      $('#dl-err', L).hidden = !m;
      $('#dl-err', L).textContent = m || '';
    };
    let info = null;
    const describe = async () => {
      info = await cb.deleteInfo(S.profile.id, t);
      if (!$('#dl-what', L)) return;
      if (info.error) {
        $('#dl-what', L).textContent = '';
        err(info.error);
      } else {
        err('');
        const files = `${info.count} video${info.count === 1 ? '' : 's'}${info.subs ? `, with ${info.subs} subtitle file${info.subs === 1 ? '' : 's'}` : ''}`;
        $('#dl-what', L).innerHTML = `Delete <b>${esc(info.label)}</b>? ${files}, ${fmtSize(info.size)}. It goes to the bin for 7 days and can be put back in Settings, Playback, until then.`;
      }
      check();
    };
    const check = () => (go.disabled = !(info && !info.error && word.value.trim().toUpperCase() === 'DELETE'));
    word.addEventListener('input', check);
    word.addEventListener('keydown', (e) => e.key === 'Enter' && !go.disabled && go.click());
    $$('input[name="dl-scope"]', L).forEach((r) => r.addEventListener('change', () => {
      t = r.value === '' ? { kind: 'series', id: series.id } : { kind: 'season', id: series.id, season: Number(r.value) };
      describe();
    }));
    $('#dl-cancel', L).onclick = closeWin;
    go.onclick = async () => {
      go.disabled = true;
      const r = await cb.deleteTitle(S.profile.id, t);
      if (r.error) {
        err(r.error);
        return check();
      }
      closeWin();
      // Its page closes if the title has gone completely.
      if (S.details && (t.kind === 'film' || t.kind === 'series') && S.details.id === t.id) closeModal();
      toast(`${r.label} is in the bin. You can put it back in Settings, Playback.`, 5000);
    };
    describe();
    word.focus();
  }

  /* ---------- buttons (data-act="menu-…", from app.js) ---------- */
  function act(a, el) {
    if (a === 'menu-plus') {
      const it = byId(el.dataset.id);
      if (it) openPlus(el, { kind: it.kind, id: it.id });
    } else if (a === 'menu-plus-ep') openPlus(el, { kind: 'episode', id: el.dataset.file });
    else if (a === 'menu-cog') {
      const it = byId(el.dataset.id);
      if (it) openCog(el, { kind: it.kind, id: it.id });
    } else if (a === 'menu-cog-ep') openCog(el, { kind: 'episode', id: el.dataset.file });
  }

  // Closes on a click outside it (press and release both outside), Esc, or scrolling the page.
  document.addEventListener('click', (e) => {
    if (open && clickedOff(e, open.el) && !open.anchor.contains(e.target)) close();
  }, true);
  document.addEventListener('keydown', (e) => {
    if (open && e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  }, true);
  window.addEventListener('resize', close);

  // The buttons, for a card or a page. cls: the button style ('round' on cards and pages).
  function buttonsHTML(item, cls = 'round') {
    const plus = `<button class="${cls}" data-act="menu-plus" data-id="${esc(item.id)}" aria-haspopup="menu" aria-label="Add to My list or a collection" title="My list and collections">${ICON.plus}</button>`;
    const cog = hasCog({ kind: item.kind, id: item.id }) ? `<button class="${cls}" data-act="menu-cog" data-id="${esc(item.id)}" aria-haspopup="menu" aria-label="More options" title="More options">${ICON.cog}</button>` : '';
    return plus + cog;
  }
  function episodeButtonsHTML(e) {
    return `<button class="ep-add" data-act="menu-plus-ep" data-file="${esc(e.id)}" aria-haspopup="menu" title="Add to a collection" aria-label="Add to a collection">${ICON.plus}</button>${
      kids() ? '' : `<button class="ep-add" data-act="menu-cog-ep" data-file="${esc(e.id)}" aria-haspopup="menu" title="More options" aria-label="More options">${ICON.cog}</button>`}`;
  }

  return { act, close, isOpen, holdsHover, buttonsHTML, episodeButtonsHTML, resetWindow, deleteWindow };
})();
