/* Settings -> "Find videos": search the computer, review the results, add them to Couchbox.
   The searching, TMDB checks, duplicate rules and copying live in src/main/finder.js. */
const FinderUI = (() => {
  const TYPES = ['mp4', 'mkv', 'avi', 'mov', 'wmv', 'm4v', 'webm'];
  let places = null;
  let where = null; // { whole, quick: [], folders: [] }, remembered by the app
  let filters = null; // reset every time the tab opens
  let data = { status: { phase: 'idle' }, results: [] };
  let recognisedOnly = false;
  let progress = null; // while adding
  let listening = false;

  const root = () => $('#finder-root');
  const fmtBytes = (n) => (n >= 1e9 ? (n / 1e9).toFixed(1) + ' GB' : Math.max(1, Math.round(n / 1e6)) + ' MB');
  const fmtLen = (s) => fmtDuration(s).trim();
  const running = () => ['searching', 'comparing'].includes(data.status.phase);
  const count = (fn) => data.results.filter(fn).length;
  const selected = () => data.results.filter((r) => r.selected && r.canSelect);

  function listen() {
    if (listening) return;
    listening = true;
    cb.onFinder((s) => {
      data = s;
      if (root()) {
        renderList();
        renderStatus();
        renderControls();
      }
    });
    cb.onFinderProgress((p) => {
      if (summary || !plan) return; // a late update after it finished
      progress = p;
      renderPop();
    });
  }

  async function open(container) {
    listen();
    filters = { min: 20, max: '', types: [...TYPES] };
    container.innerHTML = '<div class="spinner" style="margin:40px auto"></div>';
    places = await cb.finderPlaces();
    where = JSON.parse(JSON.stringify(places.last));
    data = places.state;
    container.innerHTML = `<div id="finder-root" class="finder">
      <div class="f-side">
        <h3>Where to look</h3>
        <div id="f-where"></div>
        <h3>Length</h3>
        <label class="f-num">Longer than <input type="number" min="0" step="1" id="f-min" value="${filters.min}" /> minutes</label>
        <label class="f-num">Shorter than <input type="number" min="0" step="1" id="f-max" value="" placeholder="any" /> minutes</label>
        <h3>File types</h3>
        <div class="f-types">${TYPES.map((t) => `<label class="f-check"><input type="checkbox" data-type="${t}" checked /> ${t.toUpperCase()}</label>`).join('')}</div>
        <div class="f-go" id="f-go"></div>
        ${places.hasTmdbKey ? '' : '<p class="f-hint">No TMDB key is saved, so videos can\'t be recognised or pre-ticked. Add one in the General tab.</p>'}
        ${places.hasLibrary ? '' : '<p class="f-hint">Choose your Couchbox video folder in the General tab before adding videos.</p>'}
      </div>
      <div class="f-main">
        <div class="f-status" id="f-status"></div>
        <div class="f-list" id="f-list"></div>
        <div class="f-foot">
          <button class="btn btn-sm btn-ghost" data-f="all">Select all</button>
          <button class="btn btn-sm btn-ghost" data-f="none">Select none</button>
          <label class="f-check"><input type="checkbox" id="f-recog" ${recognisedOnly ? 'checked' : ''} /> Show recognised only</label>
          <span style="flex:1"></span>
          <button class="btn btn-sm btn-accent" data-f="add" id="f-add">Add selected</button>
        </div>
      </div>
    </div>`;
    const r = root();
    $('#f-min', r).addEventListener('input', (e) => (filters.min = Number(e.target.value) || 0));
    $('#f-max', r).addEventListener('input', (e) => (filters.max = e.target.value));
    $$('[data-type]', r).forEach((c) =>
      c.addEventListener('change', () => {
        filters.types = $$('[data-type]', r).filter((x) => x.checked).map((x) => x.dataset.type);
        renderControls();
      })
    );
    $('#f-recog', r).addEventListener('change', (e) => {
      recognisedOnly = e.target.checked;
      renderList();
    });
    r.addEventListener('click', onClick);
    r.addEventListener('change', onChange);
    renderWhere();
    renderControls();
    renderStatus();
    renderList();
  }

  function renderWhere() {
    const el = $('#f-where');
    if (!el) return;
    const drives = places.drives.map((d) => d.replace('\\', '')).join(', ');
    el.innerHTML = `
      <label class="f-check"><input type="checkbox" data-where="whole" ${where.whole ? 'checked' : ''} /> Whole computer <small>(${esc(drives)})</small></label>
      ${places.quick
        .filter((q) => q.exists)
        .map((q) => `<label class="f-check ${where.whole ? 'off' : ''}"><input type="checkbox" data-where="quick" data-key="${q.key}" ${where.quick.includes(q.key) ? 'checked' : ''} ${where.whole ? 'disabled' : ''} /> ${esc(q.label)}</label>`)
        .join('')}
      ${where.folders
        .map((f, i) => `<div class="f-folder ${where.whole ? 'off' : ''}"><span title="${esc(f)}">${esc(f)}</span><button data-f="rm-folder" data-i="${i}" aria-label="Remove folder">${ICON.x}</button></div>`)
        .join('')}
      <button class="link f-addfolder" data-f="add-folder" ${where.whole ? 'disabled' : ''}>+ Add folder…</button>`;
  }

  function renderControls() {
    const go = $('#f-go');
    if (!go) return;
    const nothingWhere = !where.whole && !where.quick.length && !where.folders.length;
    go.innerHTML = running()
      ? '<button class="btn btn-sm btn-ghost" data-f="stop">Stop</button>'
      : `<button class="btn btn-sm btn-accent" data-f="search" ${nothingWhere || !filters.types.length ? 'disabled' : ''}>${ICON.search}Search</button>`;
    const n = selected().length;
    const add = $('#f-add');
    add.textContent = `Add selected (${n})`;
    add.disabled = !n || running() || !places.hasLibrary;
  }

  function renderStatus() {
    const el = $('#f-status');
    if (!el) return;
    const s = data.status;
    const found = data.results.length;
    const recog = count((r) => ['match', 'version'].includes(r.state) || (r.state === 'copy' && r.label && r.label !== 'Not recognised'));
    const checking = count((r) => r.state === 'checking');
    const inLib = count((r) => r.state === 'inLibrary');
    const bits = [`${found} video${found === 1 ? '' : 's'} found`];
    if (s.tmdb) bits.push(`${recog} recognised`);
    if (inLib) bits.push(`${inLib} already in Couchbox`);
    if (checking) bits.push(`checking ${checking}…`);
    let text;
    if (s.phase === 'idle') text = 'Choose where to look, then press Search.';
    else if (s.phase === 'searching') text = `<span class="spinner"></span> Searching… ${s.folders.toLocaleString()} folders · ${bits.join(' · ')}`;
    else if (s.phase === 'comparing') text = `<span class="spinner"></span> Comparing with your library… ${bits.join(' · ')}`;
    else text = (s.phase === 'stopped' ? 'Stopped. ' : '') + bits.join(' · ');
    el.innerHTML = text;
  }

  function rowIcon(r) {
    if (r.state === 'checking') return '<span class="spinner"></span>';
    if (r.state === 'match') return '<span class="f-ico ok" title="Recognised">✓</span>';
    if (r.state === 'version') return '<span class="f-ico warn" title="Possibly a different version">!</span>';
    if (r.state === 'nomatch') return '<span class="f-ico none" title="Not recognised">–</span>';
    return '<span class="f-ico gone">✓</span>';
  }

  function renderList() {
    const el = $('#f-list');
    if (!el) return;
    const top = el.scrollTop;
    let rows = data.results;
    if (recognisedOnly) rows = rows.filter((r) => ['match', 'version'].includes(r.state));
    // Recognised and versions first, then unrecognised, then copies / already in Couchbox.
    const order = { match: 0, version: 1, checking: 2, nomatch: 3, copy: 4, inLibrary: 5 };
    rows = [...rows].sort((a, b) => order[a.state] - order[b.state] || (a.label || a.name).localeCompare(b.label || b.name, undefined, { numeric: true }));
    if (!rows.length) {
      el.innerHTML = `<div class="f-empty">${data.status.phase === 'idle' ? 'Results will appear here.' : running() ? 'Looking…' : 'No videos matched.'}</div>`;
      return;
    }
    el.innerHTML = rows
      .map((r) => {
        const sub = r.note || (r.state === 'match' ? '' : r.label);
        const title = r.state === 'match' || r.state === 'version' || (r.state === 'inLibrary' && r.label && r.label !== 'Not recognised') ? r.label : r.name;
        return `<div class="f-row s-${r.state}${r.selected ? ' sel' : ''}">
          <span class="f-cb">${r.canSelect ? `<input type="checkbox" data-sel="${r.id}" ${r.selected ? 'checked' : ''} aria-label="Select ${esc(r.name)}" />` : ''}</span>
          <span class="f-st">${rowIcon(r)}</span>
          <span class="f-name" title="${esc(r.name + (sub ? ' · ' + sub : ''))}"><b>${esc(title)}</b><small>${esc([sub, title !== r.name ? r.name : ''].filter(Boolean).join(' · '))}</small></span>
          <span class="f-len">${esc(fmtLen(r.duration))}</span>
          <span class="f-type">${esc(r.ext)}${r.height ? `<small>${r.height}p</small>` : ''}</span>
          <span class="f-dir"><span title="${esc(r.dir)}">${esc(r.dir)}</span><span class="f-acts"><button class="link" data-f="reveal" data-file="${esc(r.file)}">Show in folder</button>${r.state === 'copy' ? `<button class="link" data-f="use-copy" data-id="${r.id}">Use this copy</button>` : ''}</span></span>
        </div>`;
      })
      .join('');
    el.scrollTop = top;
    renderControls();
  }

  async function onClick(e) {
    const b = e.target.closest('[data-f]');
    if (!b) return;
    const f = b.dataset.f;
    if (f === 'search') {
      const where2 = { whole: where.whole, quick: where.quick, folders: where.folders };
      await cb.finderSearch(where2, { minMinutes: Number(filters.min) || 0, maxMinutes: Number(filters.max) || 0, types: filters.types });
    } else if (f === 'stop') cb.finderStop();
    else if (f === 'add-folder') {
      const p = await cb.finderChooseFolder();
      if (p && !where.folders.includes(p)) where.folders.push(p);
      renderWhere();
      renderControls();
    } else if (f === 'rm-folder') {
      where.folders.splice(Number(b.dataset.i), 1);
      renderWhere();
      renderControls();
    } else if (f === 'reveal') cb.finderReveal(b.dataset.file);
    else if (f === 'use-copy') data = await cb.finderUseCopy(b.dataset.id);
    else if (f === 'all' || f === 'none') {
      const ids = data.results.filter((r) => r.canSelect && (!recognisedOnly || ['match', 'version'].includes(r.state))).map((r) => r.id);
      data = await cb.finderSelect(ids, f === 'all');
    } else if (f === 'add') openPop();
    if (root()) {
      renderList();
      renderStatus();
      renderControls();
    }
  }

  async function onChange(e) {
    const t = e.target;
    if (t.dataset.sel) data = await cb.finderSelect([t.dataset.sel], t.checked);
    else if (t.dataset.where === 'whole') {
      where.whole = t.checked;
      renderWhere();
    } else if (t.dataset.where === 'quick') {
      const k = t.dataset.key;
      where.quick = t.checked ? [...new Set([...where.quick, k])] : where.quick.filter((x) => x !== k);
    } else return;
    renderList();
    renderControls();
  }

  /* ---------- the "Add selected" pop-up ---------- */
  let plan = null;
  let summary = null;

  async function openPop() {
    summary = null;
    progress = null;
    const [copy, move] = await Promise.all([cb.finderPlan('copy'), cb.finderPlan('move')]);
    plan = { copy, move };
    let pop = $('#finder-pop');
    if (!pop) {
      pop = document.createElement('div');
      pop.id = 'finder-pop';
      pop.className = 'overlay';
      pop.dataset.close = '';
      pop.style.zIndex = 90;
      $('#modal-root').appendChild(pop);
      pop.addEventListener('click', onPopClick);
    }
    renderPop();
  }

  function renderPop() {
    const pop = $('#finder-pop');
    if (!pop || !plan) return;
    const p = plan.copy;
    let body;
    if (summary) {
      const skipped = summary.skipped.reduce((n, s) => n + (s.count || 1), 0);
      const verb = summary.mode === 'move' ? 'moved' : 'copied';
      body = `<h2>${summary.stopped ? 'Stopped' : 'Done'}</h2>
        <p>${summary.added} video${summary.added === 1 ? '' : 's'} ${verb} to Couchbox${skipped ? ` · ${skipped} skipped` : ''}${summary.failed.length ? ` · ${summary.failed.length} failed` : ''}.</p>
        ${summary.skipped.length || summary.failed.length ? `<ul class="f-sum">${[
          ...summary.skipped.map((s) => `<li>${s.count ? `${s.count} skipped: ${esc(s.reason)}` : `${esc(s.file.split(/[\\/]/).pop())}: ${esc(s.reason)}`}</li>`),
          ...summary.failed.map((s) => `<li>${esc(s.file.split(/[\\/]/).pop())}: ${esc(s.reason)}</li>`),
        ].join('')}</ul>` : ''}
        <p>Your library is updating with the new videos.</p>
        <div class="row-btns"><button class="btn btn-sm btn-accent" data-p="done">Done</button></div>`;
    } else if (progress) {
      const pct = progress.totalBytes ? Math.min(100, Math.round((progress.bytes / progress.totalBytes) * 100)) : 0;
      body = `<h2>${progress.mode === 'move' ? 'Moving' : 'Copying'} videos</h2>
        <p>${progress.index} of ${progress.count} · ${esc(progress.label)}</p>
        <div class="f-bar"><i style="width:${pct}%"></i></div>
        <p class="f-small">${fmtBytes(progress.bytes)} of ${fmtBytes(progress.totalBytes)} · ${pct}%</p>
        <div class="row-btns"><button class="btn btn-sm btn-ghost" data-p="stop">Stop</button></div>`;
    } else {
      const space = (need) => (need ? `Needs about ${fmtBytes(need)}${p.free != null ? ` (you have ${fmtBytes(p.free)} free)` : ''}.` : 'No extra space needed.');
      const short = (need) => p.free != null && need > p.free;
      body = `<h2>Add ${p.count} video${p.count === 1 ? '' : 's'} to Couchbox</h2>
        <p>They'll go into your Couchbox folder:</p>
        <div class="path">${esc(p.root || '')}</div>
        <button class="f-choice" data-p="copy" ${short(plan.copy.needCopy) ? 'disabled' : ''}><b>Copy to the Couchbox folder</b><small>The originals stay where they are. ${space(plan.copy.needCopy)}${short(plan.copy.needCopy) ? ' Not enough space.' : ''}</small></button>
        <button class="f-choice" data-p="move" ${short(plan.move.needMove) ? 'disabled' : ''}><b>Move to the Couchbox folder</b><small>The originals are moved, not duplicated. Each one is copied and checked before the original is removed. ${space(plan.move.needMove)}${short(plan.move.needMove) ? ' Not enough space.' : ''}</small></button>
        <div class="row-btns"><button class="btn btn-sm btn-ghost" data-p="cancel">Cancel</button></div>`;
    }
    pop.innerHTML = `<div class="dialog f-pop" role="dialog">${body}</div>`;
  }

  async function onPopClick(e) {
    const b = e.target.closest('[data-p]');
    if (!b) return;
    const a = b.dataset.p;
    if (a === 'cancel' || a === 'done') {
      $('#finder-pop').remove();
      plan = summary = progress = null;
      data = await cb.finderState();
      if (root()) {
        renderList();
        renderStatus();
      }
    } else if (a === 'stop') {
      cb.finderAddStop();
      b.disabled = true;
      b.textContent = 'Stopping…';
    } else if (a === 'copy' || a === 'move') {
      progress = { index: 0, count: plan.copy.count, label: 'Starting…', bytes: 0, totalBytes: plan.copy.total, mode: a };
      renderPop();
      const r = await cb.finderAdd(a);
      if (r && r.error) {
        progress = null;
        renderPop();
        toast(r.error, 5000);
        return;
      }
      summary = r;
      progress = null;
      renderPop();
    }
  }

  return { open };
})();
