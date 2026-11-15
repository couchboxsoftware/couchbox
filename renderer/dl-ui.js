/* Videos still downloading (or never finished), in the app: the purple line rising over the
   poster, "Downloading 38%" on episodes, the grey Incomplete tag, and the pie-shaped Play button
   on the details page. The checks themselves run in src/main/downloads.js. */
const DL = (() => {
  let lastSig = '';
  const of = (id) => (S.dl && S.dl.files && S.dl.files[id]) || null;
  const downloading = (id) => (of(id) || {}).s === 'downloading';
  const pct = (d) => (d && d.p != null ? Math.floor(d.p * 100) : null);
  const fmtSize = (n) => (n >= 1024 ** 3 ? (n / 1024 ** 3).toFixed(1) + ' GB' : Math.max(1, Math.round(n / 1024 ** 2)) + ' MB');

  function word(d) {
    if (!d) return '';
    if (d.s === 'incomplete') return 'Incomplete';
    const n = pct(d);
    return n != null ? `Downloading ${n}%` : 'Downloading';
  }

  // Cards and episode pictures: grey above a purple line that rises as it downloads. With no
  // percentage, the line sits at the bottom. Incomplete files get a grey tag instead.
  function overlay(id) {
    const d = of(id);
    if (!d) return '';
    if (d.s === 'incomplete') return '<span class="inctag">Incomplete</span>';
    const p = d.p || 0;
    return `<div class="convov dl" data-dl-file="${esc(id)}">
      <b class="cv-grey" style="height:${(1 - p) * 100}%"></b><i class="cv-line" style="bottom:${p * 100}%"></i>
      <span data-dl-word="${esc(id)}">${esc(word(d))}</span></div>`;
  }

  // The small status on an episode row.
  function episodeTag(e) {
    const d = of(e.id);
    return d ? `<small class="ep-conv ${d.s === 'incomplete' ? 'incomplete' : 'dl'}" data-dl-word="${esc(e.id)}">${esc(word(d))}</small>` : '';
  }

  // The Play button while downloading: a purple pie filling up (a turning arc when there's no
  // percentage). Clicking it plays what's there so far.
  function pie(file) {
    const d = of(file.id);
    const n = pct(d);
    return `<button class="pie-play ${n == null ? 'spin' : ''}" data-act="play-partial" data-file="${esc(file.id)}" data-dl-pie="${esc(file.id)}" style="--pp:${n || 0}%" title="Play what's downloaded so far" aria-label="Play what's downloaded so far">${n == null ? '<i class="pie-arc"></i>' : ''}${ICON.play}</button>`;
  }

  // The line next to the pie: "Downloading 38% · 1.1 of 2.9 GB".
  function line(file, prefix) {
    const d = of(file.id);
    if (!d) return '';
    if (d.s === 'incomplete') return `<div class="d-conv bad"><b>${prefix ? esc(prefix) + ' ' : ''}Incomplete</b><span>${esc(d.reason || "The end of this file is missing.")}</span></div>`;
    const sizes = d.total ? `${fmtSize(d.size)} of ${fmtSize(d.total)}` : `${fmtSize(d.size)} so far`;
    return `<div class="d-dl"><b data-dl-word="${esc(file.id)}">${prefix ? esc(prefix) + ' ' : ''}${esc(word(d))}</b><span data-dl-size="${esc(file.id)}">${sizes}</span></div>`;
  }

  /* ---------- keeping the screen up to date ---------- */
  function onState(snap) {
    S.dl = snap;
    const sig = JSON.stringify(Object.entries(snap.files || {}).map(([k, v]) => k + v.s + (v.p == null ? 'n' : 'p')));
    const changed = sig !== lastSig || snap.structural;
    lastSig = sig;
    if (changed) {
      if (S.details) renderDetails();
      if (S.profile && S.settings.libraryPath) scheduleRender();
      return;
    }
    for (const [id, d] of Object.entries(snap.files || {})) {
      const p = d.p || 0;
      $$(`[data-dl-file="${CSS.escape(id)}"]`).forEach((el) => {
        el.querySelector('.cv-grey').style.height = (1 - p) * 100 + '%';
        el.querySelector('.cv-line').style.bottom = p * 100 + '%';
      });
      $$(`[data-dl-word="${CSS.escape(id)}"]`).forEach((el) => (el.textContent = (el.textContent.match(/^S\d+:E\d+ /) || [''])[0] + word(d)));
      $$(`[data-dl-pie="${CSS.escape(id)}"]`).forEach((el) => el.style.setProperty('--pp', (pct(d) || 0) + '%'));
      $$(`[data-dl-size="${CSS.escape(id)}"]`).forEach((el) => (el.textContent = d.total ? `${fmtSize(d.size)} of ${fmtSize(d.total)}` : `${fmtSize(d.size)} so far`));
    }
  }

  return { of, downloading, overlay, episodeTag, pie, line, onState, word };
})();
