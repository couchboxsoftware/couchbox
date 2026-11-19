/* Your own collections (stored by src/main/collections.js). Made by hand from films, whole
   series, single seasons and single episodes. Each profile has its own and can share one with
   everyone, or everyone except kids; only its maker changes it.
   - Card: a 2x2 grid of the first four posters, with the name and count under it.
   - Shown in a "Your collections" row on Home, a Collections tab, rows in Films and Series (when
     at least half of what's in it is films, or series/seasons/episodes), and on a title's page.
   - The collection page is a poster wall (episodes as wide stills), with no Play button. Edit
     (maker only): rename, share, delete, order, remove, drag to rearrange, search to add.
   - "Add to collection": on a title's page (whole series, a season or some episodes), the hover
     card, each episode row, and the search in Edit.
   - Titles whose files are gone are hidden, and come back if the file does. Kids only ever see
     kids-safe titles. */
const Coll = (() => {
  const keyOf = (it) => `${it.kind}:${it.id}${it.kind === 'season' ? ':' + it.season : ''}`;
  const all = () => S.collections || [];
  const mine = () => all().filter((c) => c.mine);
  const find = (id) => all().find((c) => c.id === id);
  const kidsView = () => !!(S.profile && S.profile.kids);
  const pad = (n) => String(n).padStart(3, '0');

  // An item as it shows now, or null if it isn't in the library (or isn't for kids).
  function resolve(it) {
    const key = keyOf(it);
    if (it.kind === 'film') {
      const f = byId(it.id);
      if (!f || f.kind !== 'film' || (kidsView() && !kidsOk(f))) return null;
      return { key, it, kind: 'film', open: f.id, title: f.title, sub: f.year || '', pic: f.poster || f.backdrop, year: f.year || 0, sort: f.title };
    }
    if (it.kind === 'series' || it.kind === 'season') {
      const s = byId(it.id);
      if (!s || s.kind !== 'series' || (kidsView() && !kidsOk(s))) return null;
      if (it.kind === 'series') return { key, it, kind: 'series', open: s.id, title: s.title, sub: 'Series', pic: s.poster || s.backdrop, year: s.year || 0, sort: s.title };
      const se = s.seasons.find((x) => x.number === it.season);
      if (!se) return null;
      return { key, it, kind: 'season', open: s.id, season: se.number, title: s.title, sub: se.name, pic: s.poster || s.backdrop, year: s.year || 0, sort: s.title + ' ' + pad(se.number) };
    }
    if (it.kind === 'episode') {
      const f = findEpisode(it.id);
      if (!f || (kidsView() && !kidsOk(f.series))) return null;
      const s = f.series;
      return { key, it, kind: 'episode', open: s.id, season: f.ep.season, title: f.ep.title, sub: `${s.title} · ${epCode(f.ep)}`, pic: f.ep.still || s.backdrop || s.poster, wide: true, year: s.year || 0, sort: s.title + ' ' + pad(f.ep.season) + pad(f.ep.episode) };
    }
    return null;
  }

  // What's in a collection that this profile can see, in the collection's order.
  function itemsOf(c) {
    const list = c.items.map(resolve).filter(Boolean);
    const az = (a, b) => a.sort.localeCompare(b.sort, undefined, { numeric: true, sensitivity: 'base' });
    if (c.order === 'az') list.sort(az);
    else if (c.order === 'release') list.sort((a, b) => a.year - b.year || az(a, b));
    return list;
  }

  // The collections this profile sees (kids: not someone else's with nothing for them).
  const seen = () => all().filter((c) => c.mine || !kidsView() || itemsOf(c).length);

  // Home: all of them. Films / Series: at least half of what's in it is that kind.
  function forTab(kind) {
    return seen().filter((c) => {
      if (!kind) return true;
      const list = itemsOf(c);
      if (!list.length) return false;
      const films = list.filter((e) => e.kind === 'film').length;
      return kind === 'film' ? films * 2 >= list.length : (list.length - films) * 2 >= list.length;
    });
  }

  /* ---------- cards ---------- */
  function grid(c, list = itemsOf(c)) {
    const cells = [0, 1, 2, 3].map((i) => {
      const e = list[i];
      if (!e) return '<i class="empty"></i>';
      if (e.pic) return `<i><img src="${e.pic}" alt="" loading="lazy" draggable="false" /></i>`;
      const h = hashHue(e.title);
      return `<i style="background:linear-gradient(160deg,hsl(${h} 45% 32%),hsl(${(h + 40) % 360} 50% 14%))"></i>`;
    });
    return `<div class="coll-grid">${cells.join('')}</div>`;
  }
  const count = (n) => `${n} title${n === 1 ? '' : 's'}`;
  const shareLabel = (c) => (c.share === 'all' ? 'Shared with everyone' : c.share === 'grownups' ? 'Shared with grown-ups' : 'Only you');
  function cardHTML(c) {
    const list = itemsOf(c);
    return `<div class="coll" data-act="coll-open" data-cid="${esc(c.id)}" tabindex="0" aria-label="${esc(c.name)}, ${count(list.length)}">
      <div class="coll-pic">${grid(c, list)}${c.share !== 'none' ? '<span class="coll-shared">Shared</span>' : ''}</div>
      <div class="coll-name">${esc(c.name)}</div><div class="coll-count">${count(list.length)}${c.mine ? '' : ' · ' + esc(c.ownerName)}</div></div>`;
  }
  function rowHTML(key, title, cols) {
    if (!cols.length) return '';
    return `<section class="row coll-row" data-row="${key}"><h2>${esc(title)}</h2>
      <div class="row-wrap"><button class="arrow l" data-act="row-l" aria-label="Scroll left">${ICON.left}</button>
      <div class="track">${cols.map(cardHTML).join('')}</div>
      <button class="arrow r" data-act="row-r" aria-label="Scroll right">${ICON.right}</button></div></section>`;
  }
  // The Collections tab.
  function pageHTML() {
    const cols = seen();
    const add = `<button class="coll coll-new" data-act="coll-new"><div class="coll-pic">${ICON.plus}</div><div class="coll-name">New collection</div><div class="coll-count">Films, series, seasons or episodes</div></button>`;
    return `<div class="rows flat"><h1 class="page-title">Collections</h1>
      ${cols.length ? '' : '<p class="um-intro">Make your own collections of films, series, seasons and episodes. Use Add to collection on any title, or start one here.</p>'}
      <div class="coll-wall">${add}${cols.map(cardHTML).join('')}</div></div>`;
  }
  // On a title's page: the collections it's in (a series counts its seasons and episodes too).
  function inLine(item) {
    const ids = new Set([item.id]);
    if (item.kind === 'series') for (const e of allEpisodes(item)) ids.add(e.id);
    const cols = seen().filter((c) => c.items.some((it) => ids.has(it.id)));
    if (!cols.length) return '';
    return `<div><span>In your collections: </span>${cols.map((c) => `<button class="link-btn" data-act="coll-open" data-cid="${esc(c.id)}">${esc(c.name)}</button>`).join(', ')}</div>`;
  }

  /* ---------- the collection page ---------- */
  let open = null; // { id, editing, query }
  function openPage(cid, editing = false) {
    if (!find(cid)) return;
    hideHover();
    stopHeroVideo();
    S.details = null;
    open = { id: cid, editing, query: '' };
    $('#modal-root').innerHTML = '<div class="overlay" data-close="1" id="coll-overlay"><div class="details coll-page" role="dialog"></div></div>';
    renderPage();
  }
  const isOpen = () => !!(open && $('#modal-root .coll-page'));

  function tileHTML(e, ed, drag) {
    const pic = e.pic ? `<img src="${e.pic}" alt="" loading="lazy" draggable="false" />` : `<div class="cp-gen" style="background:hsl(${hashHue(e.title)} 40% 26%)"><span>${esc(e.title)}</span></div>`;
    const tag = e.kind === 'season' ? `<span class="cp-tag">${esc(e.sub)}</span>` : e.kind === 'episode' ? `<span class="cp-tag">${esc(e.sub.split(' · ').pop())}</span>` : '';
    return `<div class="cp-tile ${e.wide ? 'wide' : ''}" data-act="coll-item" data-key="${esc(e.key)}" ${drag ? 'draggable="true"' : ''}>
      <div class="cp-pic">${pic}${tag}${ed ? `<button class="cp-x" data-act="coll-remove" data-key="${esc(e.key)}" title="Remove from this collection" aria-label="Remove ${esc(e.title)}">${ICON.x}</button>` : ''}${drag ? `<span class="cp-grip" aria-hidden="true">${ICON.grip}</span>` : ''}</div>
      <div class="cp-title">${esc(e.kind === 'episode' ? e.sub.split(' · ')[0] : e.title)}</div><div class="cp-sub">${esc(e.kind === 'episode' ? e.title : e.kind === 'season' ? e.sub : String(e.sub))}</div></div>`;
  }

  function renderPage() {
    const box = $('#modal-root .coll-page');
    if (!box || !open) return;
    const c = find(open.id);
    if (!c) return closeModal();
    const list = itemsOf(c);
    const ed = open.editing && c.mine;
    const drag = ed && c.order === 'manual';
    const orders = [['manual', 'Your order'], ['release', 'Release order'], ['az', 'A to Z']];
    const orderBar = c.mine
      ? `<div class="cp-order" role="radiogroup" aria-label="Order">${orders.map(([k, l]) => `<button role="radio" aria-checked="${c.order === k}" class="chip ${c.order === k ? 'on' : ''}" data-act="coll-order" data-order="${k}">${l}</button>`).join('')}</div>`
      : `<div class="cp-order"><span class="chip on">${orders.find(([k]) => k === c.order)[1]}</span></div>`;
    box.innerHTML = `
      <button class="d-close" data-act="close-modal" aria-label="Close">${ICON.x}</button>
      <div class="cp-head">
        <div class="coll-pic big">${grid(c, list)}</div>
        <div class="cp-info">
          ${ed ? `<input class="input cp-name" id="cp-name" maxlength="60" value="${esc(c.name)}" aria-label="Collection name" />` : `<h2 class="d-title">${esc(c.name)}</h2>`}
          <div class="d-meta"><span>${count(list.length)}</span><span>${c.mine ? shareLabel(c) : 'Made by ' + esc(c.ownerName)}</span></div>
          ${orderBar}
          ${c.mine ? `<div class="cp-actions"><button class="btn btn-sm ${ed ? 'btn-accent' : 'btn-ghost'}" data-act="coll-edit">${ed ? 'Done' : ICON.pencil + 'Edit'}</button>
            ${ed ? `<select class="select" id="cp-share" aria-label="Sharing"><option value="none" ${c.share === 'none' ? 'selected' : ''}>Don't share</option><option value="all" ${c.share === 'all' ? 'selected' : ''}>Share with everyone (kids too)</option><option value="grownups" ${c.share === 'grownups' ? 'selected' : ''}>Share with everyone except kids</option></select>
              <button class="btn btn-sm btn-ghost" data-act="coll-delete">Delete collection</button>` : ''}</div>` : ''}
        </div>
      </div>
      ${ed ? `<div class="cp-search"><label class="searchbox open">${ICON.search}<input id="cp-q" placeholder="Add a title: type its name" value="${esc(open.query)}" spellcheck="false" /></label><div id="cp-results"></div></div>` : ''}
      ${list.length ? `<div class="cp-wall">${list.map((e) => tileHTML(e, ed, drag)).join('')}</div>` : `<div class="empty"><h2>Nothing here yet</h2><p>${c.mine ? 'Use "Add to collection" on any title or episode, or Edit to search for titles.' : 'There is nothing in this collection for you yet.'}</p></div>`}`;
    if (ed) wireEdit(c);
  }

  function wireEdit(c) {
    const name = $('#cp-name');
    name.addEventListener('change', () => save(cb.collectionUpdate(S.profile.id, c.id, { name: name.value })));
    name.addEventListener('keydown', (e) => e.key === 'Enter' && name.blur());
    $('#cp-share').addEventListener('change', (e) => save(cb.collectionUpdate(S.profile.id, c.id, { share: e.target.value })));
    const q = $('#cp-q');
    const results = () => {
      open.query = q.value;
      const t = q.value.trim().toLowerCase();
      const box = $('#cp-results');
      if (!box) return; // the page closed while the search was waiting
      if (!t) return (box.innerHTML = '');
      const have = new Set(c.items.map(keyOf));
      const hits = visible().filter((i) => i.title.toLowerCase().includes(t)).sort((a, b) => (b.title.toLowerCase().startsWith(t) - a.title.toLowerCase().startsWith(t)) || a.title.localeCompare(b.title)).slice(0, 8);
      box.innerHTML = hits.length
        ? hits
            .map((i) => {
              const k = keyOf({ kind: i.kind, id: i.id });
              return `<div class="cp-hit">${i.poster ? `<img src="${i.poster}" alt="" />` : '<span class="noimg"></span>'}<span class="t">${esc(i.title)}${i.year ? ` <small>${i.year}</small>` : ''}</span><span class="fm-tag">${i.kind === 'series' ? 'Series' : 'Film'}</span>
                ${have.has(k) ? '<span class="cp-added">Added</span>' : `<button class="btn btn-sm btn-ghost" data-act="coll-search-add" data-id="${esc(i.id)}">${ICON.plus}Add</button>`}</div>`;
            })
            .join('')
        : '<p style="color:var(--text-2);margin:6px 0">No titles match.</p>';
    };
    q.addEventListener('input', debounce(results, 120));
    if (open.query) {
      results();
      q.focus();
      q.setSelectionRange(q.value.length, q.value.length);
    }
    // Dragging to rearrange (your own order).
    let dragKey = null;
    $$('.cp-tile[draggable="true"]').forEach((t) => {
      t.addEventListener('dragstart', (e) => {
        dragKey = t.dataset.key;
        t.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', dragKey);
      });
      t.addEventListener('dragend', () => t.classList.remove('dragging'));
      t.addEventListener('dragover', (e) => {
        if (!dragKey || dragKey === t.dataset.key) return;
        e.preventDefault();
        t.classList.add('drop-here');
      });
      t.addEventListener('dragleave', () => t.classList.remove('drop-here'));
      t.addEventListener('drop', (e) => {
        e.preventDefault();
        t.classList.remove('drop-here');
        const to = c.items.findIndex((x) => keyOf(x) === t.dataset.key);
        if (dragKey && to >= 0) moveTo(c, dragKey, to);
        dragKey = null;
      });
    });
  }
  function moveTo(c, key, to) {
    return save(cb.collectionMove(S.profile.id, c.id, key, to));
  }

  // Applies a result from the main process ({ collections } or { error }).
  async function save(p) {
    const r = await p;
    if (!r || r.error) {
      toast((r && r.error) || "Couldn't change the collection.", 4000);
      return null;
    }
    S.collections = r.collections;
    refresh();
    return r;
  }
  // Everything that shows collections, after a change.
  function refresh() {
    if (isOpen()) renderPage();
    if (S.details) renderDetails();
    if (!$('#modal-root .coll-page')) renderContent(true);
    else scheduleContent();
  }
  // The rows behind the page update once it's closed (no jumping while it's open).
  let pending = false;
  function scheduleContent() {
    pending = true;
  }
  function afterClose() {
    open = null;
    if (pending) {
      pending = false;
      renderContent(true);
    }
  }

  /* ---------- "Add to collection" ---------- */
  let layer = null;
  function ensureLayer() {
    if (!layer) {
      layer = document.createElement('div');
      layer.id = 'coll-layer';
      document.body.appendChild(layer);
    }
    return layer;
  }
  let onKey = null;
  function closePicker() {
    if (onKey) document.removeEventListener('keydown', onKey, true);
    onKey = null;
    ensureLayer().innerHTML = '';
  }

  // what: { kind: 'film' | 'series' | 'episode', id }. For a series on its page, it can be the
  // whole series, one season, or some episodes (season: the one showing).
  function pick(what, opts = {}) {
    hideHover();
    let scope = 'whole';
    let season = opts.season;
    let picked = new Set(); // episode ids, for "some episodes"
    let series = null;
    let label = '';
    if (what.kind === 'film') label = (byId(what.id) || {}).title || '';
    else if (what.kind === 'series') {
      series = byId(what.id);
      if (!series) return;
      label = series.title;
      if (season == null || !series.seasons.some((s) => s.number === season)) season = series.seasons[0].number;
    } else if (what.kind === 'episode') {
      const f = findEpisode(what.id);
      if (!f) return;
      label = `${f.series.title} · ${epCode(f.ep)} · ${f.ep.title}`;
    }
    const items = () => {
      if (what.kind !== 'series') return [{ kind: what.kind, id: what.id }];
      if (scope === 'season') return [{ kind: 'season', id: series.id, season }];
      if (scope === 'episodes') return [...picked].map((id) => ({ kind: 'episode', id }));
      return [{ kind: 'series', id: series.id }];
    };
    const has = (c) => {
      const want = items();
      return want.length > 0 && want.every((it) => c.items.some((x) => keyOf(x) === keyOf(it)));
    };
    const draw = (err) => {
      const scopeHTML = series && opts.scopes !== false
        ? `<div class="cpk-scope" role="radiogroup" aria-label="What to add">
            <label><input type="radio" name="cpk-scope" value="whole" ${scope === 'whole' ? 'checked' : ''} /> The whole series</label>
            ${series.seasons.length ? `<label><input type="radio" name="cpk-scope" value="season" ${scope === 'season' ? 'checked' : ''} /> One season</label>` : ''}
            <label><input type="radio" name="cpk-scope" value="episodes" ${scope === 'episodes' ? 'checked' : ''} /> Some episodes</label>
            ${scope !== 'whole' ? `<select class="select" id="cpk-season" aria-label="Season">${series.seasons.map((s) => `<option value="${s.number}" ${s.number === season ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select>` : ''}
            ${scope === 'episodes' ? `<div class="cpk-eps">${series.seasons.find((s) => s.number === season).episodes.map((e) => `<label><input type="checkbox" data-ep="${esc(e.id)}" ${picked.has(e.id) ? 'checked' : ''} /> ${esc(epCode(e))} · ${esc(e.title)}</label>`).join('')}</div>` : ''}
          </div>`
        : '';
      const cols = mine();
      const noEps = scope === 'episodes' && !picked.size;
      ensureLayer().innerHTML = `<div class="pin-overlay"><div class="pin-window cpk" role="dialog" aria-label="Add to collection">
        <h2 class="pin-title">Add to collection</h2><p class="pin-note">${esc(label)}</p>
        ${scopeHTML}
        <div class="cpk-list">${cols.length ? cols.map((c) => `<label class="cpk-row"><input type="checkbox" data-cid="${esc(c.id)}" ${has(c) ? 'checked' : ''} ${noEps ? 'disabled' : ''} /><span>${esc(c.name)}</span><small>${count(itemsOf(c).length)}</small></label>`).join('') : '<p class="cpk-none">You have no collections yet. Make one below.</p>'}</div>
        ${noEps ? '<p class="cpk-hint">Tick some episodes first.</p>' : ''}
        <div class="cpk-new"><input class="input" id="cpk-name" maxlength="60" placeholder="New collection name" /><button class="btn btn-sm btn-ghost" id="cpk-create" ${noEps ? 'disabled' : ''}>${ICON.plus}Create</button></div>
        ${err ? `<div class="err">${esc(err)}</div>` : ''}
        <div class="row-btns"><button class="btn btn-sm btn-accent" id="cpk-done">Done</button></div></div></div>`;
      const L = ensureLayer();
      $$('input[name="cpk-scope"]', L).forEach((r) => r.addEventListener('change', () => {
        scope = r.value;
        draw();
      }));
      if ($('#cpk-season', L))
        $('#cpk-season', L).addEventListener('change', (e) => {
          season = Number(e.target.value);
          picked = new Set();
          draw();
        });
      $$('[data-ep]', L).forEach((b) => b.addEventListener('change', () => {
        if (b.checked) picked.add(b.dataset.ep);
        else picked.delete(b.dataset.ep);
        draw();
      }));
      $$('[data-cid]', L).forEach((b) => b.addEventListener('change', async () => {
        const c = find(b.dataset.cid);
        if (!c) return;
        for (const it of items()) {
          const k = keyOf(it);
          const inIt = c.items.some((x) => keyOf(x) === k);
          if (b.checked && !inIt) await save(cb.collectionAdd(S.profile.id, c.id, it));
          if (!b.checked && inIt) await save(cb.collectionRemoveItem(S.profile.id, c.id, k));
        }
        draw();
      }));
      const create = async () => {
        const name = $('#cpk-name', L).value.trim();
        if (!name) return draw('Type a name for the new collection.');
        const r = await save(cb.collectionCreate(S.profile.id, name));
        if (!r) return;
        for (const it of items()) await save(cb.collectionAdd(S.profile.id, r.id, it));
        toast(`Added to ${name}`, 2200);
        draw();
      };
      $('#cpk-create', L).onclick = create;
      $('#cpk-name', L).addEventListener('keydown', (e) => e.key === 'Enter' && create());
      $('#cpk-done', L).onclick = closePicker;
    };
    closePicker();
    draw();
    onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      e.preventDefault();
      closePicker();
    };
    document.addEventListener('keydown', onKey, true);
  }

  // The + menu (menus.js): ticks a title in or out of one of your collections.
  async function toggleItem(cid, it) {
    const c = find(cid);
    if (!c) return;
    const k = keyOf(it);
    if (c.items.some((x) => keyOf(x) === k)) await save(cb.collectionRemoveItem(S.profile.id, cid, k));
    else await save(cb.collectionAdd(S.profile.id, cid, it));
  }
  // The + menu's New collection: makes it with this title in it.
  const createWith = (it) => createNew(it);

  // "New collection": asks for a name, then opens it in Edit (from the Collections tab), or
  // puts `withItem` in it (from the + menu).
  function createNew(withItem = null) {
    closePicker();
    ensureLayer().innerHTML = `<div class="pin-overlay"><div class="pin-window cpk" role="dialog" aria-label="New collection">
      <h2 class="pin-title">New collection</h2><p class="pin-note">Films, series, seasons or episodes, in any mix.</p>
      <div class="cpk-new"><input class="input" id="cpk-name" maxlength="60" placeholder="Christmas, Disney nights, …" /></div><div class="err" id="cpk-err" hidden></div>
      <div class="row-btns"><button class="btn btn-sm btn-ghost" id="cpk-cancel">Cancel</button><button class="btn btn-sm btn-accent" id="cpk-make">Create</button></div></div></div>`;
    const L = ensureLayer();
    const go = async () => {
      const name = $('#cpk-name', L).value.trim();
      if (!name) {
        $('#cpk-err', L).hidden = false;
        $('#cpk-err', L).textContent = 'Type a name for the collection.';
        return;
      }
      const r = await save(cb.collectionCreate(S.profile.id, name));
      if (!r) return;
      closePicker();
      if (!withItem) return openPage(r.id, true);
      await save(cb.collectionAdd(S.profile.id, r.id, withItem));
      toast(`Added to ${name}`, 2200);
    };
    $('#cpk-make', L).onclick = go;
    $('#cpk-cancel', L).onclick = closePicker;
    $('#cpk-name', L).addEventListener('keydown', (e) => e.key === 'Enter' && go());
    $('#cpk-name', L).focus();
    onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      closePicker();
    };
    document.addEventListener('keydown', onKey, true);
  }

  /* ---------- clicks (data-act="coll-…", from app.js) ---------- */
  async function act(a, el) {
    const c = open && find(open.id);
    switch (a) {
      case 'coll-open':
        return openPage(el.dataset.cid);
      case 'coll-new':
        return createNew();
      case 'coll-add': {
        const item = byId(el.dataset.id);
        if (!item) return;
        // On a series' page you can choose a season or episodes; from a card it's the whole thing.
        const onPage = item.kind === 'series' && S.details && S.details.id === item.id && !!el.closest('.details');
        return pick({ kind: item.kind, id: item.id }, { season: S.details && S.details.season, scopes: onPage });
      }
      case 'coll-add-ep':
        return pick({ kind: 'episode', id: el.dataset.file });
      case 'coll-edit':
        if (!c) return;
        open.editing = !open.editing;
        open.query = '';
        return renderPage();
      case 'coll-order':
        if (c) return save(cb.collectionUpdate(S.profile.id, c.id, { order: el.dataset.order }));
        return;
      case 'coll-delete':
        if (!c || !confirm(`Delete the collection "${c.name}"? The titles in it aren't touched.`)) return;
        if (await save(cb.collectionDelete(S.profile.id, c.id))) {
          closeModal();
          toast('Collection deleted', 2200);
        }
        return;
      case 'coll-remove':
        if (c) return save(cb.collectionRemoveItem(S.profile.id, c.id, el.dataset.key));
        return;
      case 'coll-search-add': {
        const i = byId(el.dataset.id);
        if (c && i) return save(cb.collectionAdd(S.profile.id, c.id, { kind: i.kind, id: i.id }));
        return;
      }
      case 'coll-item': {
        if (open && open.editing) return; // editing: clicks don't open titles
        const e = c && itemsOf(c).find((x) => x.key === el.dataset.key);
        if (!e) return;
        const back = open.id;
        openDetails(e.open, e.season);
        if (S.details) S.details.fromColl = back; // closing the title goes back to the collection
        return;
      }
    }
  }

  async function load() {
    S.collections = S.profile ? await cb.collectionsGet(S.profile.id) : [];
  }

  return { keyOf, itemsOf, forTab, cardHTML, rowHTML, pageHTML, inLine, openPage, renderPage, isOpen, afterClose, pick, act, load, closePicker, toggleItem, createWith, mineList: mine };
})();
