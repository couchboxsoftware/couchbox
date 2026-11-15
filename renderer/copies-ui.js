/* Copies and versions in the app: the yellow "!" on a new version's card, length labels on
   versions kept side by side, the Copies and versions section in Settings, Library, and the
   side-by-side comparison. The work is done in src/main/copies.js. */
const Copies = (() => {
  const state = () => S.copies || { spares: [], versions: [], versionOf: {}, labels: {} };
  const versionFor = (cardId) => state().versions.find((v) => v.theirs.cardId === cardId);
  const fmtSize = (n) => (n >= 1024 ** 3 ? (n / 1024 ** 3).toFixed(1) + ' GB' : Math.max(1, Math.round(n / 1024 ** 2)) + ' MB');
  const fmtDay = (t) => new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

  // On a card: the "!" for a new version (opens the comparison), or the length of a version
  // kept side by side.
  function cardBits(id) {
    const st = state();
    if (st.versionOf[id]) return `<button class="ver-dot" data-act="version-review" data-id="${esc(id)}" title="Possibly a different version: compare" aria-label="Possibly a different version: compare">!</button>`;
    if (st.labels[id]) return `<span class="eplabel ver-len">${esc(st.labels[id])}</span>`;
    return '';
  }

  // After a title on its page or an episode row: " · 2h 32m" for a version kept side by side.
  const lengthSuffix = (id) => (state().labels[id] ? ` · ${esc(state().labels[id])}` : '');

  // On the details page of a new version.
  function detailsHTML(item) {
    const v = versionFor(item.id);
    if (!v) return '';
    return `<div class="d-conv ver-note">${Conv.dot()}<span>This looks like another version of <b>${esc(v.label)}</b>: ${esc(v.theirs.length)} here, ${esc(v.mine.length)} in the one you have.</span><button class="btn btn-sm btn-ghost" data-act="version-review" data-id="${esc(item.id)}">Compare</button></div>`;
  }

  /* ---------- Settings, Library ---------- */
  function sectionHTML() {
    return `<div class="settings-section" id="copies-section">${sectionInner()}</div>`;
  }

  function sectionInner() {
    const st = state();
    const warn = S.warnings.some((w) => w.section === 'copies');
    const spare = (s) => `<div class="conv-row cp-row"><span class="cr-name">${esc(s.fileName)}<small>${esc(s.folder)} · ${esc([s.resolution, fmtSize(s.size), s.length].filter(Boolean).join(' · '))}</small><small>A copy of ${esc(s.label)}. Couchbox shows ${esc(s.best.fileName)} (${esc([s.best.resolution, fmtSize(s.best.size)].filter(Boolean).join(', '))}).</small></span>
      <button class="btn btn-sm btn-ghost" data-act="copy-bin" data-path="${esc(s.path)}">Move to bin</button><button class="btn btn-sm btn-ghost" data-act="copy-keep" data-key="${esc(s.key)}">Keep both</button></div>`;
    const version = (v) => `<div class="conv-row cp-row"><span class="cr-name">${esc(v.label)}<small>${esc(v.mine.length)} (yours) and ${esc(v.theirs.length)} (new): possibly a different cut</small></span>
      <button class="btn btn-sm btn-ghost" data-act="version-review" data-id="${esc(v.theirs.cardId)}">Review</button></div>`;
    const empty = !st.spares.length && !st.versions.length;
    return `<h3>Copies and versions${warn ? ' ' + Conv.dot() : ''}</h3>
      ${Conv.warnBox('copies', false)}
      ${empty ? '<p class="conv-note">No spare copies or different versions. When the same film or episode turns up twice, it shows here.</p>' : ''}
      ${st.spares.length ? `<h4>Spare copies</h4><p class="conv-note">Couchbox only shows the best copy of each. Spare copies in the bin are deleted after 7 days.</p>${st.spares.map(spare).join('')}` : ''}
      ${st.versions.length ? `<h4>Different versions</h4>${st.versions.map(version).join('')}` : ''}`;
  }

  function renderSection() {
    const box = $('#copies-section');
    if (box) box.innerHTML = sectionInner();
  }

  /* ---------- the comparison ---------- */
  function review(cardId) {
    const v = versionFor(cardId);
    if (!v) return toast('That has already been decided.', 2500);
    hideHover();
    S.details = null;
    const mineItem = byId(v.mine.cardId) || (findEpisode(v.mine.cardId) || {}).ep;
    const theirsItem = byId(v.theirs.cardId) || (findEpisode(v.theirs.cardId) || {}).ep;
    const diff = Math.round((v.theirs.duration - v.mine.duration) / 60);
    const col = (who, d, item, extra) => `<div class="cmp-col"><div class="cmp-who">${who}</div>
      <div class="cmp-pic">${item && (item.poster || item.still || item.backdrop) ? `<img src="${item.poster || item.still || item.backdrop}" alt="" />` : ''}</div>
      <dl><dt>File</dt><dd>${esc(d.fileName)}</dd><dt>Folder</dt><dd>${esc(d.folder)}</dd>
      <dt>Length</dt><dd>${esc(d.length)}${extra}</dd><dt>Picture</dt><dd>${esc(d.resolution || 'Unknown')}</dd>
      <dt>Size</dt><dd>${esc(fmtSize(d.size))}</dd><dt>Added</dt><dd>${esc(fmtDay(d.added))}</dd></dl></div>`;
    $('#modal-root').innerHTML = `<div class="overlay" data-close="1"><div class="dialog dialog-wide cmp" role="dialog" aria-label="Compare versions">
      <h2>Two versions of ${esc(v.label)}?</h2>
      <p>These look like the same title, but their lengths differ: possibly a different cut.</p>
      <div class="cmp-cols">${col('The one you have', v.mine, mineItem, '')}${col('The new one', v.theirs, theirsItem, diff ? ` <b class="cmp-diff">${diff > 0 ? '+' : '−'}${Math.abs(diff)} min</b>` : '')}</div>
      <div class="cmp-btns">
        <button class="btn btn-sm btn-accent" data-act="version-decide" data-key="${esc(v.key)}" data-choice="replace">Replace the one I have</button>
        <button class="btn btn-sm btn-ghost" data-act="version-decide" data-key="${esc(v.key)}" data-choice="keepMine">Keep the one I have</button>
        <button class="btn btn-sm btn-ghost" data-act="version-decide" data-key="${esc(v.key)}" data-choice="both">Keep both as separate versions</button>
      </div>
      <p class="conv-note">Replace: the new one takes over, with My list and the watched tick; it starts from the beginning. Whichever you don't keep goes to the bin for 7 days.</p>
      <div class="row-btns"><button class="btn btn-sm btn-ghost" data-act="close-modal">Not now</button></div></div></div>`;
  }

  /* ---------- keeping up to date ---------- */
  function onState(snap) {
    S.copies = snap;
    renderSection();
    if (S.details) renderDetails();
    if (S.profile && S.settings.libraryPath) scheduleRender();
  }

  async function act(a, el) {
    switch (a) {
      case 'copy-bin': {
        const err = await cb.copiesBin(el.dataset.path);
        toast(err || 'Moved to the bin. It is deleted after 7 days.', err ? 5000 : 3000);
        return true;
      }
      case 'copy-keep':
        await cb.copiesKeep(el.dataset.key);
        toast('Kept. It stays hidden and won\'t be flagged again.', 3000);
        return true;
      case 'version-review':
        review(el.dataset.id);
        return true;
      case 'version-decide': {
        const choice = el.dataset.choice;
        const err = await cb.copiesDecide(el.dataset.key, choice);
        closeModal();
        toast(err || { replace: 'Replaced. The old one is in the bin for 7 days.', keepMine: 'Kept yours. The new one is in the bin for 7 days.', both: 'Both kept, each labelled with its length.' }[choice], err ? 5000 : 3500);
        return true;
      }
    }
    return false;
  }

  return { cardBits, lengthSuffix, detailsHTML, sectionHTML, renderSection, review, onState, act };
})();
