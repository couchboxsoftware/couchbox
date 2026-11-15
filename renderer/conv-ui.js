/* Conversions in the app: the grey "Converting" look on cards and episodes, the line on the
   details page, the Conversions section in Settings -> Playback, the player's "not ready yet"
   screen, and the yellow "!" warnings. The queue itself runs in src/main/converter.js. */
const Conv = (() => {
  const LIVE = ['converting', 'finishing', 'waiting'];
  let lastSig = '';
  let showAll = false;

  const state = () => S.conv || { files: {}, queue: [], failed: [], skipped: [], bin: [], renamed: {} };
  const of = (fileId) => state().files[fileId] || null;
  const pctOf = (c) => (c.s === 'finishing' ? 100 : Math.floor((c.p || 0) * 100));

  function text(c) {
    if (!c) return '';
    return {
      converting: `Converting ${pctOf(c)}%`,
      finishing: 'Finishing',
      waiting: 'Waiting to convert',
      failed: "Couldn't convert",
      skipped: 'Kept as original',
    }[c.s] || '';
  }

  // Where a waiting file is in the queue ("3rd in line").
  function place(fileId) {
    const waiting = state().queue.filter((r) => r.s === 'waiting');
    const i = waiting.findIndex((r) => r.id === fileId);
    if (i < 0) return '';
    const n = i + 1;
    const suf = n % 100 >= 11 && n % 100 <= 13 ? 'th' : { 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th';
    return n === 1 ? 'next in line' : `${n}${suf} in line`;
  }

  // The grey cover with the orange line rising from the bottom (cards and episode pictures).
  function overlay(fileId) {
    const c = of(fileId);
    if (!c || !LIVE.includes(c.s)) return '';
    const p = c.s === 'waiting' ? 0 : c.s === 'finishing' ? 1 : c.p || 0;
    return `<div class="convov ${c.s === 'waiting' ? 'wait' : ''}" data-conv-file="${esc(fileId)}">
      <b class="cv-grey" style="height:${(1 - p) * 100}%"></b><i class="cv-line" style="bottom:${p * 100}%"></i>
      <span>${c.s === 'waiting' ? 'Waiting' : 'Converting'}</span></div>`;
  }

  // A series: what its episodes are doing, for the details page.
  function seriesSummary(series) {
    const eps = allEpisodes(series)
      .map((e) => ({ e, c: of(e.id) }))
      .filter((x) => x.c);
    if (!eps.length) return null;
    return {
      current: eps.find((x) => x.c.s === 'converting' || x.c.s === 'finishing'),
      waiting: eps.filter((x) => x.c.s === 'waiting'),
      failed: eps.filter((x) => x.c.s === 'failed'),
      skipped: eps.filter((x) => x.c.s === 'skipped'),
    };
  }

  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

  // The block under the title on the details page.
  function detailsHTML(item) {
    if (item.kind === 'film') {
      const c = of(item.id);
      if (!c) return !item.playable && !state().enabled ? `<div class="d-conv"><span>Needs converting to play. Conversions are off in Settings, Playback.</span></div>` : '';
      if (c.s === 'converting' || c.s === 'finishing')
        return `<div class="d-conv"><b>Converting</b><div class="bar"><i data-conv-bar="${esc(item.id)}" style="width:${pctOf(c)}%"></i></div><span data-conv-pct="${esc(item.id)}">${pctOf(c)}%</span></div>`;
      if (c.s === 'waiting') return `<div class="d-conv"><b>Waiting to convert</b><span>${esc(place(item.id))}</span>${queueNextBtn(item.id)}</div>`;
      if (c.s === 'failed') {
        const f = state().failed.find((r) => r.id === item.id);
        return `<div class="d-conv bad"><b>Couldn't convert</b><span>${esc(f ? f.reason : '')}</span><button class="btn btn-sm btn-ghost" data-act="conv-retry" data-file="${esc(item.id)}">Try again</button></div>`;
      }
      if (c.s === 'skipped') return `<div class="d-conv"><b>Kept as original</b><span>It doesn't play here as it is.</span><button class="btn btn-sm btn-ghost" data-act="conv-retry" data-file="${esc(item.id)}">Convert</button></div>`;
      return '';
    }
    const sum = seriesSummary(item);
    if (!sum) return '';
    const bits = [];
    if (sum.current) {
      const c = sum.current.c;
      bits.push(`<b>Converting ${esc(epCode(sum.current.e))}</b><div class="bar"><i data-conv-bar="${esc(sum.current.e.id)}" style="width:${pctOf(c)}%"></i></div><span data-conv-pct="${esc(sum.current.e.id)}">${pctOf(c)}%</span>`);
    }
    if (sum.waiting.length) bits.push(`<span>${plural(sum.waiting.length, 'episode', 'episodes')} waiting</span>${queueNextBtn(item.id)}`);
    let out = bits.length ? `<div class="d-conv">${bits.join('')}</div>` : '';
    if (sum.failed.length)
      out += `<div class="d-conv bad"><b>${plural(sum.failed.length, "episode couldn't", "episodes couldn't")} convert</b><button class="btn btn-sm btn-ghost" data-act="conv-retry-all" data-id="${esc(item.id)}">Try again</button></div>`;
    return out;
  }

  const queueNextBtn = (key) => `<button class="btn btn-sm btn-ghost" data-act="conv-next" data-key="${esc(key)}">Queue next</button>`;

  // The small status on an episode row.
  function episodeTag(e, series) {
    const c = of(e.id);
    if (c) return `<small class="ep-conv ${c.s}" data-conv-pct="${esc(e.id)}" data-conv-word="1">${esc(text(c))}</small>`;
    return seriesSummary(series) && e.playable ? '<small class="ep-conv ready">Ready to play</small>' : '';
  }

  /* ---------- warnings ---------- */
  const warnings = () => S.warnings || [];
  const dot = () => '<span class="warn-dot" title="Needs attention" aria-label="Needs attention">!</span>';
  const tabHasWarning = (tab) => warnings().some((w) => w.tab === tab);
  function warnBox(section, kids) {
    return warnings()
      .filter((w) => w.section === section)
      .map(
        (w) => `<div class="warnbox">${dot()}<div><b>${esc(w.title)}</b><p>${esc(w.text)}</p>
          ${kids ? '<p>Ask a grown-up to sort this out from their profile.</p>' : w.action ? `<button class="btn btn-sm btn-ghost" data-act="${esc(w.action.act)}">${esc(w.action.label)}</button>` : ''}</div></div>`
      )
      .join('');
  }

  // Puts the "!" on the menu button and on the Settings tabs, or takes it off.
  function updateDots() {
    const any = warnings().length > 0;
    const btn = $('.profile-menu-btn');
    if (btn) {
      const d = btn.querySelector('.warn-dot');
      if (any && !d) btn.insertAdjacentHTML('beforeend', dot());
      if (!any && d) d.remove();
    }
    const item = $('#pmenu [data-act="settings"]');
    if (item) {
      const d = item.querySelector('.warn-dot');
      if (any && !d) item.insertAdjacentHTML('beforeend', dot());
      if (!any && d) d.remove();
    }
    $$('.stabs [data-tab]').forEach((b) => {
      const d = b.querySelector('.warn-dot');
      const on = tabHasWarning(b.dataset.tab);
      if (on && !d) b.insertAdjacentHTML('beforeend', dot());
      if (!on && d) d.remove();
    });
  }

  /* ---------- Settings -> Playback -> Conversions ---------- */
  function sectionHTML() {
    const kids = !!(S.profile && S.profile.kids);
    const warn = warnings().some((w) => w.section === 'conversions');
    if (kids) return warn ? `<div class="settings-section" id="conv-section"><h3>Conversions ${dot()}</h3>${warnBox('conversions', true)}</div>` : '';
    return `<div class="settings-section" id="conv-section">${sectionInner()}</div>`;
  }

  const fmtSize = (n) => (n >= 1024 ** 3 ? (n / 1024 ** 3).toFixed(1) + ' GB' : Math.max(1, Math.round(n / 1024 ** 2)) + ' MB');
  const fmtDay = (t) => new Date(t).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  function fmtEta(s) {
    if (s == null) return '';
    if (s < 90) return 'about a minute left';
    const m = Math.round(s / 60);
    if (m < 60) return `about ${m} minutes left`;
    const h = Math.round(m / 60);
    return h === 1 ? 'about an hour left' : `about ${h} hours left`;
  }

  function sectionInner() {
    const st = state();
    const warn = warnings().some((w) => w.section === 'conversions');
    const rows = showAll ? st.queue : st.queue.slice(0, 5);
    let summary;
    if (!st.enabled) summary = 'Conversions are off.';
    else if (st.paused) summary = `Paused. ${plural(st.waiting + st.converting, 'video', 'videos')} to convert.`;
    else if (st.blocked && !st.converting) summary = `Stopped until there's more space. ${plural(st.waiting, 'video', 'videos')} waiting.`;
    else if (!st.queue.length) summary = 'Nothing to convert. Everything in your folder plays as it is.';
    else summary = [st.converting ? `${st.converting} converting` : '', st.waiting ? `${st.waiting} waiting` : '', fmtEta(st.eta)].filter(Boolean).join(', ') + '.';
    const pauseBtn = st.enabled && (st.queue.length || st.paused) ? `<button class="btn btn-sm btn-ghost" data-act="conv-pause" data-paused="${st.paused ? '' : '1'}">${st.paused ? 'Resume' : 'Pause all'}</button>` : '';
    const row = (r) => `<div class="conv-row">
        <span class="cr-name">${esc(r.label)}</span><span class="cr-tag ${r.lane}">${r.lane === 'fast' ? 'Fast' : 'Slow'}</span>
        ${r.s === 'converting' || r.s === 'finishing'
          ? `<span class="cr-bar"><i data-conv-bar="${esc(r.id)}" style="width:${pctOf(r)}%"></i></span><span class="cr-pct" data-conv-pct="${esc(r.id)}">${pctOf(r)}%</span>`
          : `<span class="cr-wait">Waiting</span><button class="btn btn-sm btn-ghost" data-act="conv-next" data-key="${esc(r.id)}">Queue next</button>`}
      </div>`;
    const failed = st.failed.length
      ? `<h4>Couldn't convert</h4>${st.failed.map((r) => `<div class="conv-row"><span class="cr-name">${esc(r.label)}<small>${esc(r.reason)}</small></span><button class="btn btn-sm btn-ghost" data-act="conv-retry" data-file="${esc(r.id)}">Try again</button></div>`).join('')}`
      : '';
    const skipped = st.skipped.length
      ? `<h4>Skipped</h4><p class="conv-note">Kept as they are, so they may not play here.</p>${st.skipped.map((r) => `<div class="conv-row"><span class="cr-name">${esc(r.label)}</span><button class="btn btn-sm btn-ghost" data-act="conv-retry" data-file="${esc(r.id)}">Convert</button></div>`).join('')}`
      : '';
    const bin = st.bin.length
      ? `<h4>Bin</h4><p class="conv-note">${plural(st.bin.length, 'original', 'originals')}, ${fmtSize(st.binSize)}. Each is deleted once its new copy has been watched, or after 7 days.</p>
         <div class="inline"><button class="btn btn-sm btn-ghost" data-act="conv-open-bin">Open bin</button><button class="btn btn-sm btn-ghost" data-act="conv-empty-bin">Empty now</button></div>
         ${st.bin.map((b) => `<div class="conv-row"><span class="cr-name">${esc(b.label)}<small>Deleted ${esc(fmtDay(b.deleteAt))}</small></span>${b.kind === 'copy'
           ? `<button class="btn btn-sm btn-ghost" data-act="conv-restore" data-key="${esc(b.key)}" data-mode="copy">Restore</button>`
           : `<button class="btn btn-sm btn-ghost" data-act="conv-restore" data-key="${esc(b.key)}" data-mode="retry">Restore and retry</button><button class="btn btn-sm btn-ghost" data-act="conv-restore" data-key="${esc(b.key)}" data-mode="skip">Restore and skip</button>`}</div>`).join('')}`
      : '';
    return `<h3>Conversions${warn ? ' ' + dot() : ''}</h3>
      ${warnBox('conversions', false)}
      <label class="toggle"><span class="t-text"><b>Convert videos that won't play</b><small>Converted in the background, in the order they were added. The original goes to a bin until the new copy has been watched.</small></span><span class="switch"><input type="checkbox" id="set-autoconvert" ${S.settings.autoConvert ? 'checked' : ''} /><span></span></span></label>
      <div class="conv-sum"><span>${esc(summary)}</span>${pauseBtn}</div>
      ${rows.length ? `<div class="conv-list">${rows.map(row).join('')}</div>` : ''}
      ${st.queue.length > 5 ? `<button class="link conv-more" data-act="conv-show-all">${showAll ? 'Show fewer' : `Show all ${st.queue.length}`}</button>` : ''}
      ${failed}${skipped}${bin}`;
  }

  function bindSection() {
    const sw = $('#set-autoconvert');
    if (sw)
      sw.addEventListener('change', async () => {
        S.settings = await cb.setSettings({ autoConvert: sw.checked });
        renderSection();
      });
  }

  function renderSection() {
    const box = $('#conv-section');
    if (!box) return;
    if (S.profile && S.profile.kids) {
      box.outerHTML = sectionHTML() || '<div id="conv-section"></div>';
      return;
    }
    box.innerHTML = sectionInner();
    bindSection();
  }

  /* ---------- keeping the screen up to date ---------- */
  // A structural change (something started, finished, failed...) redraws what shows it; plain
  // progress only moves the lines and numbers.
  function onState(snap) {
    S.conv = snap;
    const sig = JSON.stringify([Object.entries(snap.files).map(([k, v]) => k + v.s), snap.bin.length, snap.enabled, snap.paused, !!snap.blocked]);
    const changed = sig !== lastSig;
    lastSig = sig;
    renderSection();
    if (Player.isOpen()) Player.convChanged();
    if (!changed) return;
    if (S.details) renderDetails();
    if (S.profile && S.settings.libraryPath) scheduleRender();
  }

  function onProgress(map) {
    for (const [id, p] of Object.entries(map)) {
      const c = state().files[id];
      if (!c) continue;
      c.p = p;
      const row = state().queue.find((r) => r.id === id);
      if (row) row.p = p; // so a redraw of Settings shows the latest figure
      const pct = pctOf(c);
      $$(`[data-conv-file="${CSS.escape(id)}"]`).forEach((el) => {
        el.querySelector('.cv-grey').style.height = (1 - p) * 100 + '%';
        el.querySelector('.cv-line').style.bottom = p * 100 + '%';
      });
      $$(`[data-conv-bar="${CSS.escape(id)}"]`).forEach((el) => (el.style.width = pct + '%'));
      $$(`[data-conv-pct="${CSS.escape(id)}"]`).forEach((el) => (el.textContent = el.dataset.convWord ? text(c) : pct + '%'));
    }
  }

  function onWarnings(list) {
    S.warnings = list;
    updateDots();
    renderSection();
    if (typeof Copies !== 'undefined') Copies.renderSection();
  }

  /* ---------- buttons ---------- */
  async function act(a, el) {
    switch (a) {
      case 'conv-next':
        await cb.convQueueNext(el.dataset.key);
        toast('Moved to the front of the queue', 1800);
        return true;
      case 'conv-retry':
        await cb.convRetry(el.dataset.file);
        return true;
      case 'conv-retry-all': {
        const s = byId(el.dataset.id);
        const sum = s && seriesSummary(s);
        if (sum) for (const x of sum.failed.slice().reverse()) await cb.convRetry(x.e.id);
        return true;
      }
      case 'conv-pause':
        await cb.convPause(!!el.dataset.paused);
        return true;
      case 'conv-show-all':
        showAll = !showAll;
        renderSection();
        return true;
      case 'conv-empty-bin':
        if (!confirm('Delete every original in the bin now? This can\'t be undone.')) return true;
        const err = await cb.convEmptyBin();
        toast(err || 'Bin emptied', err ? 5000 : 3000);
        return true;
      case 'conv-open-bin':
        cb.convOpenBin().then((err) => err && toast(err, 4000));
        return true;
      case 'conv-restore': {
        const err = await cb.convRestore(el.dataset.key, el.dataset.mode);
        toast(err || (el.dataset.mode === 'copy' ? 'Put back where it was.' : el.dataset.mode === 'skip' ? 'Original put back. It will be left as it is.' : 'Original put back. It will be converted again.'), err ? 5000 : 3000);
        return true;
      }
    }
    return false;
  }

  return { of, text, place, overlay, detailsHTML, episodeTag, sectionHTML, bindSection, renderSection, onState, onProgress, onWarnings, updateDots, act, dot, tabHasWarning, state, warnBox };
})();
