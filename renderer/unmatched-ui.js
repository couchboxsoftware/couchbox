/* The Unmatched tab (titles TMDB had no match for) and the Fix match window, used from that tab
   and from a title's page. After a match, the main process tidies the file(s) into Films\ or
   Series\ (src/main/tidy.js). */
const Unmatched = (() => {
  // Titles TMDB answered "no match" for (not ones still being looked up).
  const items = () => allItems().filter((i) => i.noMatch).sort((a, b) => b.added - a.added);
  const shown = () => !!(S.profile && !S.profile.kids && S.model.tmdb && items().length);

  // The tab after My list, with a count. Hidden at 0, for kids, and with no TMDB key.
  function updateTab() {
    const tab = $('.tab[data-tab="unmatched"]');
    if (!tab) return;
    tab.hidden = !shown();
    const n = items().length;
    tab.querySelector('.tab-count').textContent = n;
    tab.setAttribute('aria-label', `Unmatched, ${n}`);
  }

  function cardHTML(i) {
    const pic = i.backdrop
      ? `<img src="${i.backdrop}" loading="lazy" alt="" draggable="false" />`
      : `<div class="um-gen" style="background:linear-gradient(160deg,hsl(${hashHue(i.title)} 45% 30%),hsl(${(hashHue(i.title) + 40) % 360} 50% 14%))"></div>`;
    const where = i.kind === 'series' ? `${esc(i.folder)} · ${i.episodeCount} episode${i.episodeCount === 1 ? '' : 's'}` : esc(i.folder);
    return `<button class="um-card" data-act="fix-match" data-id="${esc(i.id)}" data-from="tab" aria-label="Fix match for ${esc(i.title)}">
      <div class="um-pic">${pic}<span class="um-kind">${i.kind === 'series' ? 'Series' : 'Film'}</span></div>
      <div class="um-text"><b>${esc(i.title)}${i.year ? ` (${i.year})` : ''}</b>
        ${i.fileName ? `<span class="um-file">${esc(i.fileName)}</span>` : ''}<span class="um-folder">${where}</span></div></button>`;
  }

  function pageHTML() {
    const list = items();
    if (!list.length)
      return `<div class="empty" style="padding-top:200px"><h2>Everything is matched</h2><p>Every film and series has its poster and details.</p><button class="btn btn-sm btn-ghost" data-act="tab" data-tab="home">Back to Home</button></div>`;
    return `<div class="rows flat"><h1 class="page-title">Unmatched</h1>
      <p class="um-intro">Couchbox couldn't be sure what these are from their names and lengths. Pick one to choose from its best guesses or search for it yourself. Once it's matched, its file is tidied into Films or Series.</p>
      <div class="um-grid">${list.map(cardHTML).join('')}</div></div>`;
  }

  /* ---------- Fix match ---------- */
  async function openFix(id, fromTab = false) {
    const item = byId(id);
    if (!item) return;
    hideHover();
    S.details = null;
    const isSeries = item.kind === 'series';
    const firstEp = isSeries ? allEpisodes(item)[0] : null;
    const file = isSeries ? firstEp : item;
    let kind = isSeries ? 'tv' : item.noMatch ? 'both' : 'film';
    const where = isSeries ? `${esc(item.folder)} · ${item.episodeCount} episode${item.episodeCount === 1 ? '' : 's'}` : esc(item.folder);
    const preview = file && file.playable && file.video
      ? `<video class="fm-preview" muted loop playsinline src="${file.video}"></video>`
      : item.backdrop ? `<img class="fm-preview" src="${item.backdrop}" alt="" />` : '<div class="fm-preview"></div>';
    const kinds = isSeries
      ? '<span class="fm-only">Series</span>'
      : [['film', 'Films'], ['tv', 'Series'], ['both', 'Both']].map(([k, l]) => `<label class="fm-kind"><input type="radio" name="fm-kind" value="${k}" ${kind === k ? 'checked' : ''} /><span>${l}</span></label>`).join('');
    $('#modal-root').innerHTML = `<div class="overlay" data-close="1"><div class="dialog dialog-wide fm" role="dialog" aria-label="Fix match">
      <h2>Fix match</h2>
      <div class="fm-file">${preview}<div><b>${esc(isSeries ? item.title : item.fileName || item.title)}</b><small>${where}</small></div></div>
      <div class="fm-search">
        <input class="input" id="fm-q" value="${esc(item.title)}" aria-label="Title" />
        <input class="input" id="fm-year" value="${item.year || ''}" placeholder="Year" maxlength="4" inputmode="numeric" aria-label="Year" />
        <div class="fm-kinds" role="radiogroup" aria-label="Search">${kinds}</div>
        <button class="btn btn-sm btn-accent" id="fm-go">${ICON.search}Search</button>
      </div>
      <div class="match-list" id="fm-results"></div>
      <div class="fm-ep" id="fm-ep" hidden>
        <p>This file is an episode of <b id="fm-ep-show"></b>. Which one?</p>
        <div class="inline"><label>Season <input class="input" id="fm-season" value="1" inputmode="numeric" maxlength="3" /></label><label>Episode <input class="input" id="fm-episode" value="1" inputmode="numeric" maxlength="4" /></label>
        <button class="btn btn-sm btn-accent" id="fm-ep-save">Save</button><button class="btn btn-sm btn-ghost" id="fm-ep-back">Back</button></div>
        <div class="err" id="fm-ep-err" hidden></div>
      </div>
      <div class="row-btns"><button class="btn btn-sm btn-ghost" data-act="close-modal">Cancel</button></div></div></div>`;
    // A short muted preview from about 10% in.
    const v = $('.fm-preview');
    if (v && v.tagName === 'VIDEO') {
      v.addEventListener('loadedmetadata', () => {
        v.currentTime = (v.duration || 0) * 0.1;
        v.play().catch(() => {});
      }, { once: true });
    }
    $$('input[name="fm-kind"]').forEach((r) => r.addEventListener('change', () => {
      kind = r.value;
      go();
    }));

    let results = [];
    // Likely matches Couchbox found but wasn't sure enough of: listed first, above the search.
    const guesses = item.guesses || [];
    const row = (r, i) => `<button class="match" data-i="${i}">${r.poster ? `<img src="${r.poster}" alt="" />` : '<div class="noimg"></div>'}<div><b>${esc(r.title)} ${r.year ? `(${esc(r.year)})` : ''}<span class="fm-tag">${r.kind === 'tv' ? 'Series' : 'Film'}</span></b><small>${esc(r.overview)}</small></div></button>`;
    const go = async () => {
      const out = $('#fm-results');
      out.innerHTML = '<div class="spinner" style="margin:20px auto"></div>';
      $('#fm-ep').hidden = true;
      try {
        const found = await cb.searchMatches(id, $('#fm-q').value.trim(), { kind, year: $('#fm-year').value.trim() });
        const rest = found.filter((r) => !guesses.some((g) => g.id === r.id && g.kind === r.kind));
        results = [...guesses, ...rest];
        const head = (t) => `<h4 class="fm-group">${t}</h4>`;
        out.innerHTML =
          (guesses.length ? head('Best guesses') + guesses.map(row).join('') : '') +
          (rest.length
            ? (guesses.length ? head('Search results') : '') + rest.map((r, j) => row(r, j + guesses.length)).join('')
            : guesses.length ? '' : '<p style="margin:12px 0 0">No results. Try a shorter title, another year, or Both.</p>');
        $$('.match', out).forEach((b) => b.addEventListener('click', () => pick(results[Number(b.dataset.i)])));
      } catch (e) {
        out.innerHTML = `<div class="err">${esc(e.message)}</div>`;
      }
    };

    const pick = async (r) => {
      // A single film file matched to a series is one of its episodes: ask which.
      if (!isSeries && r.kind === 'tv') {
        $('#fm-ep').hidden = false;
        $('#fm-ep-show').textContent = r.title;
        $('#fm-results').hidden = true;
        $('#fm-ep-back').onclick = () => {
          $('#fm-ep').hidden = true;
          $('#fm-results').hidden = false;
        };
        $('#fm-ep-save').onclick = () => {
          const season = Number($('#fm-season').value);
          const episode = Number($('#fm-episode').value);
          if (!(season >= 0 && episode >= 1)) {
            $('#fm-ep-err').hidden = false;
            $('#fm-ep-err').textContent = 'Enter the season and episode numbers.';
            return;
          }
          save(r, { kind: 'tv', season, episode });
        };
        $('#fm-season').focus();
        return;
      }
      save(r, { kind: r.kind });
    };

    const save = async (r, opts) => {
      $('#fm-results').innerHTML = '<div class="spinner" style="margin:20px auto"></div>';
      let res;
      try {
        res = await cb.fixMatch(id, r.id, opts);
      } catch (e) {
        $('#fm-results').hidden = false;
        $('#fm-results').innerHTML = `<div class="err">${esc(e.message)}</div>`;
        return;
      }
      closeModal();
      const dest = opts.kind === 'tv' ? 'Series' : 'Films';
      if (res.clashes && res.clashes.length) toast(`Matched. ${res.clashes[0]}`, 6000);
      else if (res.later) toast(`Matched. It moves into ${dest} once it's finished converting.`, 4500);
      else toast(res.moved ? `Matched, and tidied into ${dest}` : 'Match updated', 2600);
      // From the tab: stay there for the next one. From a title's page: open it again.
      if (fromTab) return;
      const newId = res.itemId || id;
      for (let t = 0; t < 30 && !byId(newId); t++) await new Promise((ok) => setTimeout(ok, 200));
      if (byId(newId)) openDetails(newId);
    };

    $('#fm-go').onclick = go;
    for (const sel of ['#fm-q', '#fm-year']) $(sel).addEventListener('keydown', (e) => e.key === 'Enter' && go());
    go();
  }

  return { items, shown, updateTab, pageHTML, openFix };
})();
