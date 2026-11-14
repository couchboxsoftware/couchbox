/* Couchbox video player. Uses globals from app.js (S, nextEpisode, isWatched, epCode) at runtime. */
const Player = (() => {
  let root, video, scrub, canvas, st = null;
  let idleTimer = null, saveTimer = null, clickTimer = null, countdown = null;
  let isFull = false;
  // Seconds before the end of an episode: card appears / countdown starts / next one plays.
  const NEXT_CARD_AT = 30, NEXT_COUNT_AT = 20, NEXT_PLAY_AT = 15;
  let blobs = [];
  let scrubBusy = false, scrubWant = null;

  const q = (s) => root.querySelector(s);

  function build() {
    root = $('#player');
    root.innerHTML = `
      <video class="main" preload="auto"></video>
      <video class="scrubber" muted preload="auto"></video>
      <div class="p-center"></div>
      <div class="p-subs"></div>
      <div class="p-spin" hidden></div>
      <div class="p-top"><button class="pbtn" data-p="back" aria-label="Back" title="Back (Esc)">${ICON.back}</button><div class="p-name"></div></div>
      <button class="skip-intro" hidden>Skip intro</button>
      <div class="next-card" hidden></div>
      <div class="p-bottom">
        <div class="timeline">
          <div class="tl-track"><div class="tl-buf"></div><div class="tl-intro" hidden></div><div class="tl-play"></div><div class="tl-knob"></div></div>
          <div class="tl-preview" hidden><canvas width="320" height="180"></canvas><span></span></div>
        </div>
        <div class="p-controls">
          <button class="pbtn" data-p="toggle" aria-label="Play or pause" title="Play/pause (Space)">${ICON.pause}</button>
          <button class="pbtn" data-p="rew" aria-label="Back 10 seconds" title="Back 10s (Left)">${ICON.rew}</button>
          <button class="pbtn" data-p="fwd" aria-label="Forward 10 seconds" title="Forward 10s (Right)">${ICON.fwd}</button>
          <div class="vol"><button class="pbtn" data-p="mute" aria-label="Mute" title="Mute (M)">${ICON.volume}</button><input type="range" min="0" max="1" step="0.02" aria-label="Volume" /></div>
          <span class="p-time">0:00 / 0:00</span>
          <div class="grow"></div>
          <button class="pbtn" data-p="next" aria-label="Next episode" title="Next episode (N)" hidden>${ICON.next}</button>
          <div style="position:relative"><button class="pbtn" data-p="subs-menu" aria-label="Subtitles" title="Subtitles">${ICON.subs}</button></div>
          <div style="position:relative"><button class="pbtn" data-p="speed-menu" aria-label="Playback speed" title="Speed">${ICON.speed}</button></div>
          <div style="position:relative"><button class="pbtn" data-p="intro-menu" aria-label="Intro settings" title="Set the intro for this series" hidden>${ICON.gear}</button></div>
          <button class="pbtn" data-p="full" aria-label="Full screen" title="Full screen (F)">${ICON.full}</button>
        </div>
      </div>
      <div class="p-overlay" hidden></div>`;
    video = q('video.main');
    scrub = q('video.scrubber');
    canvas = q('canvas');

    video.addEventListener('timeupdate', onTime);
    video.addEventListener('progress', drawBuffer);
    video.addEventListener('play', () => (q('[data-p="toggle"]').innerHTML = ICON.pause, poke()));
    video.addEventListener('pause', () => {
      q('[data-p="toggle"]').innerHTML = ICON.play;
      root.classList.remove('idle');
      save();
    });
    video.addEventListener('waiting', () => (q('.p-spin').hidden = false));
    for (const ev of ['playing', 'canplay', 'seeked']) video.addEventListener(ev, () => (q('.p-spin').hidden = true));
    video.addEventListener('ended', onEnded);
    video.addEventListener('error', onError);
    video.addEventListener('loadedmetadata', () => {
      drawIntro();
      onTime();
    });
    video.addEventListener('volumechange', () => {
      q('[data-p="mute"]').innerHTML = video.muted || video.volume === 0 ? ICON.mute : ICON.volume;
      q('.vol input').value = video.muted ? 0 : video.volume;
    });
    scrub.addEventListener('seeked', () => {
      const ctx = canvas.getContext('2d');
      ctx.drawImage(scrub, 0, 0, canvas.width, canvas.height);
      scrubBusy = false;
      if (scrubWant != null) {
        const t = scrubWant;
        scrubWant = null;
        seekScrub(t);
      }
    });

    q('.vol input').addEventListener('input', (e) => {
      video.volume = Number(e.target.value);
      video.muted = video.volume === 0;
      saveVolume();
    });

    root.addEventListener('mousemove', poke);
    root.addEventListener('click', onClick);
    video.addEventListener('dblclick', () => {
      clearTimeout(clickTimer);
      toggleFull();
    });
    q('.skip-intro').addEventListener('click', skipIntro);
    setupTimeline();
    cb.onFullscreen((on) => {
      isFull = on;
      q('[data-p="full"]').innerHTML = on ? ICON.unfull : ICON.full;
    });
    cb.onConvertProgress(({ fileId, p }) => {
      if (st && st.file.id === fileId) {
        const bar = q('.p-overlay .bar i');
        const pct = q('.p-overlay .pct');
        if (bar) bar.style.width = Math.round(p * 100) + '%';
        if (pct) pct.textContent = Math.round(p * 100) + '%';
      }
    });
    document.addEventListener('keydown', onKey, true);
  }

  function isOpen() {
    return !!st;
  }

  function open({ file, series, startAt, onClose }) {
    if (!root) build();
    root.hidden = false;
    st = { file, series, onClose, dismissedNext: false, triedConvert: false };
    load(file, startAt);
    // Pressing Play with Couchbox maximised plays fullscreen. Next episodes don't re-check:
    // they keep whatever the player is in.
    cb.windowState().then((w) => {
      if (st && w.maximized && !w.fullscreen) cb.fullscreen(true);
    });
  }

  function load(file, startAt) {
    st.file = file;
    st.startAt = startAt || 0;
    st.dismissedNext = false;
    st.ended = false;
    st.card = null; // which next-episode card is showing: null, 'plain' or 'count'
    st.advancing = false;
    clearCountdown();
    hideOverlay();
    q('.next-card').hidden = true;
    q('.skip-intro').hidden = true;
    closePops();
    const title = st.series ? `<b>${esc(st.series.title)}</b>&nbsp;&nbsp;${epCode(file)} · ${esc(file.title)}` : `<b>${esc(file.title)}</b>`;
    q('.p-name').innerHTML = title;
    q('.grow').innerHTML = st.series ? `${esc(st.series.title)} <span style="color:#999">${epCode(file)} ${esc(file.title)}</span>` : esc(file.title);
    q('.p-controls [data-p="next"]').hidden = !(st.series && nextEpisode(st.series, file));
    q('.tl-play').style.width = '0%';
    q('.tl-knob').style.left = '0%';
    q('.tl-buf').style.width = '0%';
    q('.tl-intro').hidden = true;
    q('.p-time').textContent = `0:00 / ${fmtTime(file.duration)}`;
    q('[data-p="toggle"]').innerHTML = ICON.play;
    q('.p-subs').innerHTML = '';
    video.playbackRate = 1;
    q('[data-p="intro-menu"]').hidden = !st.series;
    q('[data-p="subs-menu"]').parentElement.hidden = !file.subs.length;
    video.volume = S.settings.volume == null ? 1 : S.settings.volume;
    loadSubtitles(file);
    if (!file.playable && !file.converted) {
      video.removeAttribute('src');
      video.load();
      showConvertPrompt(false);
    } else setSource(file.video, st.startAt);
    clearInterval(saveTimer);
    saveTimer = setInterval(() => !video.paused && save(), 5000);
    poke();
  }

  function setSource(src, at) {
    q('.p-spin').hidden = false;
    video.src = src;
    scrub.src = src;
    const once = () => {
      video.removeEventListener('loadedmetadata', once);
      if (at > 0 && at < video.duration - 5) video.currentTime = at;
      video.play().catch(() => {});
    };
    video.addEventListener('loadedmetadata', once);
  }

  async function loadSubtitles(file) {
    if (activeTrack) activeTrack.oncuechange = null;
    activeTrack = null;
    for (const t of [...video.querySelectorAll('track')]) t.remove();
    blobs.forEach(URL.revokeObjectURL);
    blobs = [];
    if (!file.subs.length) return;
    const pref = localStorage.getItem('cb.subs.' + S.profile.id) || 'off';
    for (const s of file.subs) {
      const vtt = await cb.subtitle(file.id, s.index);
      if (!vtt || !st || st.file !== file) return;
      const url = URL.createObjectURL(new Blob([vtt], { type: 'text/vtt' }));
      blobs.push(url);
      const tr = document.createElement('track');
      tr.kind = 'subtitles';
      tr.label = s.label;
      tr.srclang = 'en';
      tr.src = url;
      video.appendChild(tr);
    }
    // Text tracks appear after the elements are added.
    setTimeout(() => applySubs(pref), 50);
  }

  // Subtitles are drawn by us (not the browser) so they sit above the controls.
  let activeTrack = null;
  function applySubs(label) {
    const tracks = [...video.textTracks];
    if (activeTrack) activeTrack.oncuechange = null;
    activeTrack = null;
    if (label !== 'off') activeTrack = tracks.find((t) => t.label === label) || tracks[0] || null;
    tracks.forEach((t) => (t.mode = t === activeTrack ? 'hidden' : 'disabled'));
    const box = q('.p-subs');
    box.innerHTML = '';
    if (!activeTrack) return;
    const draw = () => {
      const cues = activeTrack && activeTrack.activeCues ? [...activeTrack.activeCues] : [];
      box.innerHTML = cues
        .map((c) => `<span>${esc(c.text.replace(/<[^>]+>/g, '')).replace(/\n/g, '<br>')}</span>`)
        .join('<br>');
    };
    activeTrack.oncuechange = draw;
    draw();
  }

  function close() {
    if (!st) return;
    save();
    const done = st.onClose;
    clearInterval(saveTimer);
    clearCountdown();
    video.pause();
    video.removeAttribute('src');
    video.load();
    scrub.removeAttribute('src');
    scrub.load();
    if (st.converting) cb.cancelConvert(st.file.id);
    st = null;
    root.hidden = true;
    // Fullscreen stays on after the video: leave it with Esc, F11 or the top-bar button.
    done && done();
  }

  function save() {
    if (!st || !video.duration || !isFinite(video.duration) || video.currentTime < 1) return;
    const t = st.ended ? video.duration : video.currentTime;
    const d = video.duration;
    S.progress[st.file.id] = { t, d, u: Date.now() };
    cb.setProgress(S.profile.id, st.file.id, t, d);
  }

  const saveVolume = debounce(async () => {
    S.settings = await cb.setSettings({ volume: video.volume });
  }, 500);

  /* ---------- UI updates ---------- */
  function onTime() {
    if (!st) return;
    const d = video.duration || st.file.duration || 0;
    const t = video.currentTime;
    const pct = d ? (t / d) * 100 : 0;
    q('.tl-play').style.width = pct + '%';
    q('.tl-knob').style.left = pct + '%';
    q('.p-time').textContent = `${fmtTime(t)} / ${fmtTime(d)}`;

    const intro = st.series && S.intros[st.series.id];
    q('.skip-intro').hidden = !(intro && intro.end > intro.start && t >= intro.start && t < intro.end - 1);

    // Next episode: the card appears with 30 s left; with autoplay on, a 5 s countdown runs from
    // 20 s left and the next episode starts at 15 s left (the episode counts as watched).
    // The countdown follows the video's own clock, so pausing pauses it too.
    const next = st.series && nextEpisode(st.series, st.file);
    const nc = q('.next-card');
    const left = d - t;
    if (next && d > 90 && left <= NEXT_CARD_AT && !st.dismissedNext && !st.ended) {
      // Skipping straight into the last 15 s shows the plain card instead (no instant jump);
      // the usual 5 s countdown then runs at the very end.
      if (S.settings.autoplayNext && left <= NEXT_COUNT_AT && (st.card === 'count' || left > NEXT_PLAY_AT)) {
        if (st.card !== 'count') {
          showNextCard(next, true);
          st.card = 'count';
        }
        const span = NEXT_COUNT_AT - NEXT_PLAY_AT;
        const bar = q('.next-card .count');
        const secs = q('.next-card .secs');
        if (bar) bar.style.width = Math.min(100, Math.max(0, ((NEXT_COUNT_AT - left) / span) * 100)) + '%';
        if (secs) secs.textContent = Math.max(0, Math.ceil(left - NEXT_PLAY_AT));
        if (left <= NEXT_PLAY_AT && !st.advancing) {
          st.advancing = true;
          goNext(true);
        }
      } else if (st.card !== 'plain') {
        showNextCard(next, false);
        st.card = 'plain';
      }
    } else if (!countdown && !nc.hidden) {
      nc.hidden = true;
      st.card = null;
    }
  }

  function drawBuffer() {
    const d = video.duration;
    if (!d || !video.buffered.length) return;
    let end = 0;
    for (let i = 0; i < video.buffered.length; i++) if (video.buffered.start(i) <= video.currentTime + 1) end = Math.max(end, video.buffered.end(i));
    q('.tl-buf').style.width = (end / d) * 100 + '%';
  }

  function drawIntro() {
    const el = q('.tl-intro');
    const intro = st && st.series && S.intros[st.series.id];
    const d = video.duration;
    if (!intro || !d || !(intro.end > intro.start)) return (el.hidden = true);
    el.hidden = false;
    el.style.left = (intro.start / d) * 100 + '%';
    el.style.width = ((intro.end - intro.start) / d) * 100 + '%';
  }

  function poke() {
    root.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (st && !video.paused && !root.querySelector('.p-pop') && !root.querySelector('.timeline.drag')) root.classList.add('idle');
    }, 3000);
  }

  function flash(icon) {
    const c = q('.p-center');
    c.innerHTML = icon;
    c.classList.remove('flash');
    void c.offsetWidth;
    c.classList.add('flash');
  }

  /* ---------- actions ---------- */
  function toggle() {
    if (!video.src) return;
    if (video.paused) {
      video.play().catch(() => {});
      flash(ICON.play);
    } else {
      video.pause();
      flash(ICON.pause);
    }
  }

  function seekBy(s) {
    if (!video.duration) return;
    video.currentTime = Math.min(Math.max(0, video.currentTime + s), video.duration - 0.5);
    flash(s < 0 ? ICON.rew : ICON.fwd);
    poke();
  }

  function toggleFull() {
    cb.fullscreen(!isFull);
  }

  function skipIntro() {
    const intro = st.series && S.intros[st.series.id];
    if (intro) video.currentTime = intro.end;
  }

  // markWatched: the episode was cut short by the early autoplay, so record it as finished.
  function goNext(markWatched = false) {
    const next = st.series && nextEpisode(st.series, st.file);
    if (!next) return;
    if (markWatched) st.ended = true;
    save();
    const p = S.progress[next.id];
    load(next, p && !isWatched(p) && p.t > 30 ? p.t - 3 : 0);
  }

  function showNextCard(next, withCountdown) {
    const nc = q('.next-card');
    nc.innerHTML = `
      <div class="nc-img">${next.still ? `<img src="${next.still}" alt="" />` : ''}${withCountdown ? '<div class="count" style="width:0"></div>' : ''}</div>
      <div class="nc-body"><small>Next episode${withCountdown ? ' in <span class="secs">5</span>' : ''}</small><b>${epCode(next)} · ${esc(next.title)}</b>
      <div class="nc-btns"><button class="btn btn-light btn-sm" data-p="next">${ICON.play}Play now</button>
      <button class="btn btn-grey btn-sm" data-p="dismiss-next">${withCountdown ? 'Cancel' : 'Watch credits'}</button></div></div>`;
    nc.hidden = false;
  }

  function onEnded() {
    st.ended = true;
    save();
    const next = st.series && nextEpisode(st.series, st.file);
    if (!next) {
      setTimeout(() => st && st.ended && close(), 1200);
      return;
    }
    root.classList.remove('idle');
    if (!S.settings.autoplayNext) return showNextCard(next, false);
    showNextCard(next, true);
    const started = Date.now();
    const total = 5000;
    countdown = setInterval(() => {
      const left = total - (Date.now() - started);
      const bar = q('.next-card .count');
      const secs = q('.next-card .secs');
      if (bar) bar.style.width = Math.min(100, (1 - left / total) * 100) + '%';
      if (secs) secs.textContent = Math.max(0, Math.ceil(left / 1000));
      if (left <= 0) {
        clearCountdown();
        goNext();
      }
    }, 100);
  }

  function clearCountdown() {
    clearInterval(countdown);
    countdown = null;
  }

  function onError() {
    if (!st || !video.getAttribute('src')) return;
    q('.p-spin').hidden = true;
    if (st.file.converted || st.triedConvert) {
      showOverlay(`<h2>This video won't play</h2><p>The file might be damaged or incomplete. Try playing it in another player to check.</p><div class="btns"><button class="btn btn-light btn-sm" data-p="back">Back</button></div>`);
    } else showConvertPrompt(true);
  }

  function showConvertPrompt(failed) {
    showOverlay(`<h2>${failed ? "This video can't play as it is" : 'This video needs a quick conversion'}</h2>
      <p>Its format isn't one Couchbox can play directly. Couchbox can make a playable copy once, and your original file stays untouched. This can take a few minutes for a full-length video.</p>
      <div class="btns"><button class="btn btn-accent btn-sm" data-p="convert">Convert now</button>${failed ? '' : '<button class="btn btn-grey btn-sm" data-p="try-anyway">Try anyway</button>'}<button class="btn btn-grey btn-sm" data-p="back">Back</button></div>`);
  }

  async function convert() {
    st.converting = true;
    st.triedConvert = true;
    const file = st.file;
    showOverlay(`<h2>Converting…</h2><p>Making a playable copy of "${esc(file.title)}". You can leave this open or go back. The conversion stops if you go back.</p>
      <div class="bar"><i></i></div><div class="pct" style="color:#aaa;font-size:14px">0%</div>
      <div class="btns" style="margin-top:18px"><button class="btn btn-grey btn-sm" data-p="back">Cancel</button></div>`);
    const url = await cb.convert(file.id);
    if (!st || st.file !== file) return;
    st.converting = false;
    if (!url) {
      showOverlay(`<h2>Conversion didn't work</h2><p>FFmpeg couldn't read this file. It may be damaged.</p><div class="btns"><button class="btn btn-light btn-sm" data-p="back">Back</button></div>`);
      return;
    }
    file.converted = true;
    file.playable = true;
    file.video = url;
    hideOverlay();
    setSource(url, st.startAt);
  }

  function showOverlay(html) {
    const o = q('.p-overlay');
    o.innerHTML = `<div class="box">${html}</div>`;
    o.hidden = false;
  }
  function hideOverlay() {
    q('.p-overlay').hidden = true;
  }

  /* ---------- menus ---------- */
  function closePops() {
    root.querySelectorAll('.p-pop').forEach((p) => p.remove());
  }

  function pop(anchorBtn, html) {
    const had = anchorBtn.parentElement.querySelector('.p-pop');
    closePops();
    if (had) return;
    const p = document.createElement('div');
    p.className = 'p-pop';
    p.innerHTML = html;
    anchorBtn.parentElement.appendChild(p);
  }

  function subsMenu(btn) {
    const tracks = [...video.textTracks];
    const cur = activeTrack;
    pop(btn, `<h4>Subtitles</h4>
      <button data-p="sub" data-label="off"><span class="tick">${!cur ? ICON.check : ''}</span>Off</button>
      ${tracks.map((t) => `<button data-p="sub" data-label="${esc(t.label)}"><span class="tick">${cur === t ? ICON.check : ''}</span>${esc(t.label)}</button>`).join('')}`);
  }

  function speedMenu(btn) {
    const r = video.playbackRate;
    pop(btn, `<h4>Speed</h4>${[0.5, 0.75, 1, 1.25, 1.5, 2].map((s) => `<button data-p="speed" data-speed="${s}"><span class="tick">${s === r ? ICON.check : ''}</span>${s === 1 ? 'Normal' : s + 'x'}</button>`).join('')}`);
  }

  function introMenu(btn) {
    const intro = S.intros[st.series.id];
    const now = fmtTime(video.currentTime);
    const desc = intro && intro.end > intro.start ? `${fmtTime(intro.start)} to ${fmtTime(intro.end)}` : intro && intro.start != null ? `starts ${fmtTime(intro.start)}, end not set` : 'not set';
    pop(btn, `<h4>Intro for this series: ${desc}</h4>
      <button data-p="intro-start"><span class="tick"></span>Intro starts here (${now})</button>
      <button data-p="intro-end"><span class="tick"></span>Intro ends here (${now})</button>
      ${intro ? '<button data-p="intro-clear"><span class="tick"></span>Clear intro</button>' : ''}
      <div style="padding:6px 18px 4px;color:#888;font-size:12.5px;max-width:300px">Set it once and "Skip intro" shows on every episode of ${esc(st.series.title)}.</div>`);
  }

  async function setIntro(patch) {
    const cur = S.intros[st.series.id] || {};
    const next = patch === null ? null : { ...cur, ...patch };
    S.intros = await cb.setIntro(st.series.id, next);
    closePops();
    drawIntro();
    onTime();
    if (next && next.end > next.start) toast('Intro saved for every episode');
  }

  /* ---------- input ---------- */
  function onClick(e) {
    poke();
    const b = e.target.closest('[data-p]');
    if (!b) {
      if (e.target.closest('.p-pop')) return;
      if (root.querySelector('.p-pop')) return closePops();
      if (e.target === video) {
        clearTimeout(clickTimer);
        clickTimer = setTimeout(toggle, 200);
      }
      return;
    }
    const a = b.dataset.p;
    if (!['subs-menu', 'speed-menu', 'intro-menu', 'sub', 'speed'].includes(a)) closePops();
    switch (a) {
      case 'back': return close();
      case 'toggle': return toggle();
      case 'rew': return seekBy(-10);
      case 'fwd': return seekBy(10);
      case 'mute':
        video.muted = !video.muted;
        if (!video.muted && video.volume === 0) video.volume = 0.5;
        return;
      case 'full': return toggleFull();
      case 'next': return goNext();
      case 'dismiss-next':
        st.dismissedNext = true;
        clearCountdown();
        q('.next-card').hidden = true;
        return;
      case 'subs-menu': return subsMenu(b);
      case 'speed-menu': return speedMenu(b);
      case 'intro-menu': return introMenu(b);
      case 'sub':
        applySubs(b.dataset.label);
        localStorage.setItem('cb.subs.' + S.profile.id, b.dataset.label);
        return closePops();
      case 'speed':
        video.playbackRate = Number(b.dataset.speed);
        return closePops();
      case 'intro-start': return setIntro({ start: Math.floor(video.currentTime) });
      case 'intro-end': return setIntro({ end: Math.floor(video.currentTime) });
      case 'intro-clear': return setIntro(null);
      case 'convert': return convert();
      case 'try-anyway':
        hideOverlay();
        st.triedConvert = false;
        return setSource(st.file.video, st.startAt);
    }
  }

  function onKey(e) {
    if (!st) return;
    const k = e.key;
    const handled = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    if (k === 'Escape') {
      handled();
      if (root.querySelector('.p-pop')) return closePops();
      return close(); // leaves the video; fullscreen stays on

    }
    if (!q('.p-overlay').hidden) return;
    if (e.target && e.target.tagName === 'INPUT' && e.target.type !== 'range') return;
    const lower = k.toLowerCase();
    if (k === ' ' || lower === 'k') { handled(); toggle(); }
    else if (k === 'ArrowLeft' || lower === 'j') { handled(); seekBy(-10); }
    else if (k === 'ArrowRight' || lower === 'l') { handled(); seekBy(10); }
    else if (k === 'ArrowUp') { handled(); video.muted = false; video.volume = Math.min(1, video.volume + 0.1); saveVolume(); poke(); }
    else if (k === 'ArrowDown') { handled(); video.volume = Math.max(0, video.volume - 0.1); saveVolume(); poke(); }
    else if (lower === 'm') { handled(); video.muted = !video.muted; }
    else if (lower === 'f') { handled(); toggleFull(); }
    else if (lower === 'n') { handled(); goNext(); }
    else if (lower === 's' && !q('.skip-intro').hidden) { handled(); skipIntro(); }
    else if (k === 'Home') { handled(); video.currentTime = 0; }
  }

  /* ---------- timeline + scrub preview ---------- */
  function seekScrub(t) {
    if (!scrub.getAttribute('src') || !isFinite(t)) return;
    if (scrubBusy) {
      scrubWant = t;
      return;
    }
    scrubBusy = true;
    scrub.currentTime = t;
    setTimeout(() => (scrubBusy = false), 600);
  }

  function setupTimeline() {
    const tl = q('.timeline');
    const prev = q('.tl-preview');
    const at = (x) => {
      const r = tl.getBoundingClientRect();
      return Math.min(1, Math.max(0, (x - r.left) / r.width));
    };
    const showPrev = (x) => {
      const d = video.duration;
      if (!d) return;
      const p = at(x);
      const r = tl.getBoundingClientRect();
      prev.hidden = false;
      prev.style.left = Math.min(Math.max(p * r.width, 116), r.width - 116) + 'px';
      prev.querySelector('span').textContent = fmtTime(p * d);
      seekScrub(p * d);
    };
    let dragging = false;
    tl.addEventListener('mousemove', (e) => showPrev(e.clientX));
    tl.addEventListener('mouseleave', () => !dragging && (prev.hidden = true));
    tl.addEventListener('mousedown', (e) => {
      if (!video.duration) return;
      dragging = true;
      tl.classList.add('drag');
      const move = (ev) => {
        const p = at(ev.clientX);
        q('.tl-play').style.width = p * 100 + '%';
        q('.tl-knob').style.left = p * 100 + '%';
        showPrev(ev.clientX);
      };
      const up = (ev) => {
        dragging = false;
        tl.classList.remove('drag');
        prev.hidden = true;
        video.currentTime = at(ev.clientX) * video.duration;
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
      };
      move(e);
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });
  }

  return { open, close, isOpen };
})();
