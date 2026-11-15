// Finding intros automatically, one season at a time, in the background once the conversion
// queue is empty (and pausing when a conversion starts). The maths is in intro-worker.js.
//
// - Guessing: each episode's first 10 minutes of sound is compared with its neighbours in the
//   season (1 with 2, 2 with 3, ...). A shared stretch of at least 10 seconds is the intro; its
//   edges snap to the nearest silence or black screen within 3 seconds. A short one (under 20
//   seconds) starting right at the beginning is a studio logo, not the intro. No shared stretch:
//   no intro. A season with one episode has nothing to compare against.
// - Confirming (Yes, after a Skip): that episode's intro becomes the season's reference, and every
//   episode is checked against it: 90% or more found = a full intro, at least 10 seconds = Skip
//   covers just that part, less = none. New episodes in a confirmed season are checked against
//   the reference.
// - Correcting (No): the answers (Skip appeared too soon / too late, skipped too far / not far
//   enough) search that episode again in that direction; a rejected stretch is never offered
//   again. "Right" for both counts as Yes.
// - An episode is checked once, and again only if its file changes.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Worker } = require('worker_threads');
const { spawn } = require('child_process');
const media = require('./media');

const STEP = 1365 / 11025; // seconds per fingerprint frame (see intro-worker.js)
const MIN_S = 10;
const SEARCH_S = 600;
const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');

class Intros {
  constructor({ dataDir, getLibrary, getConverter, store, send }) {
    this.lib = getLibrary;
    this.conv = getConverter;
    this.store = store;
    this.send = send;
    this.dir = path.join(dataDir, 'fingerprints');
    const d = store.data;
    for (const k of ['introEpisodes', 'introSeasons', 'introChecked', 'introRejects']) if (!d[k] || typeof d[k] !== 'object') d[k] = {};
    // Series-wide marks from older versions aren't used any more.
    if (d.intros) {
      delete d.intros;
      store.save();
    }
    this.worker = null;
    this.calls = new Map();
    this.n = 0;
  }

  /* ---------- the worker ---------- */
  ask(msg, transfer) {
    if (!this.worker) {
      const file = path.join(__dirname, 'intro-worker.js').replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep);
      this.worker = new Worker(file);
      this.worker.on('message', (m) => {
        const c = this.calls.get(m.id);
        if (!c) return;
        this.calls.delete(m.id);
        m.error ? c.reject(new Error(m.error)) : c.resolve(m);
      });
      this.worker.on('error', (e) => {
        for (const c of this.calls.values()) c.reject(e);
        this.calls.clear();
        this.worker = null;
      });
      this.worker.unref();
    }
    const id = ++this.n;
    return new Promise((resolve, reject) => {
      this.calls.set(id, { resolve, reject });
      this.worker.postMessage({ ...msg, id }, transfer || []);
    });
  }

  stop() {
    if (this.worker) this.worker.terminate();
    this.worker = null;
  }

  // An episode's fingerprint (cached on disk while the file is unchanged).
  async codes(f) {
    const file = path.join(this.dir, sha1(`${f.file}|${f.size}|${f.mtime}`) + '.bin');
    try {
      const b = fs.readFileSync(file);
      return new Uint32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length));
    } catch (_) {}
    const r = await this.ask({ type: 'fingerprint', file: f.file, ffmpeg: media.ffmpegPath, seconds: SEARCH_S });
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(file, Buffer.from(r.codes.buffer));
    return r.codes;
  }

  /* ---------- the queue ---------- */
  // Seasons in the same order as the conversion queue (as added; each series in order).
  seasons() {
    const lib = this.lib();
    const blocked = (e) => e.partial || (lib.downloads && lib.downloads.blocks(e.file)) || (lib.copies && lib.copies.isSpare(e.file));
    const out = [];
    const series = [...lib.scan.series].sort((a, b) => Math.min(...a.episodes.map((e) => e.added)) - Math.min(...b.episodes.map((e) => e.added)));
    for (const s of series) {
      const by = new Map();
      for (const e of s.episodes) if (!blocked(e)) (by.get(e.season) || by.set(e.season, []).get(e.season)).push(e);
      for (const [n, eps] of [...by].sort((a, b) => a[0] - b[0])) out.push({ key: `${s.id}|${n}`, seriesId: s.id, number: n, eps: eps.sort((a, b) => a.episode - b.episode) });
    }
    return out;
  }

  needsWork(season) {
    const ch = this.store.data.introChecked;
    return season.eps.some((e) => !ch[e.id] || ch[e.id].size !== e.size || ch[e.id].mtime !== e.mtime);
  }

  // Only while nothing is converting and nothing is waiting to (unless conversions are paused,
  // off, stopped for space, or held for an update).
  idle() {
    const c = this.conv();
    if (!c) return true;
    if (c.running.size) return false;
    const v = c.view();
    return !v.waiting || v.paused || !v.enabled || !!v.blocked || !!v.hold;
  }

  schedule() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.run().catch((e) => console.error('[intros]', e)), 500);
  }

  async run() {
    if (this._running) return (this._again = true);
    this._running = true;
    try {
      do {
        this._again = false;
        for (const season of this.seasons()) {
          if (!this.idle()) return;
          if (this.needsWork(season)) await this.doSeason(season);
        }
      } while (this._again);
      this.tidyCache();
    } finally {
      this._running = false;
    }
  }

  async doSeason(season) {
    const d = this.store.data;
    const st = d.introSeasons[season.key];
    const fps = [];
    for (const e of season.eps) {
      if (!this.idle()) return;
      fps.push(await this.codes(e));
    }
    if (st && st.status === 'confirmed' && st.ref) {
      const ref = await this.refCodes(season, st);
      for (let i = 0; i < season.eps.length; i++) if (!d.introEpisodes[season.eps[i].id] || this.changed(season.eps[i])) await this.applyRef(season.eps[i], fps[i], ref);
    } else {
      // Neighbours: pair (n, n+1) gives candidates for both episodes.
      const pairs = [];
      for (let i = 0; i + 1 < season.eps.length; i++) {
        const r = await this.ask({ type: 'pair', a: fps[i].slice().buffer, b: fps[i + 1].slice().buffer });
        pairs.push(r.runs);
      }
      for (let i = 0; i < season.eps.length; i++) {
        const fromPrev = i > 0 ? pairs[i - 1].map((r) => ({ start: r.b0 * STEP, end: (r.b1 + 1) * STEP, len: r.len, bits: r.bits })) : [];
        const fromNext = i < pairs.length ? pairs[i].map((r) => ({ start: r.a0 * STEP, end: (r.a1 + 1) * STEP, len: r.len, bits: r.bits })) : [];
        await this.guess(season.eps[i], fromPrev, fromNext);
      }
      d.introSeasons[season.key] = { status: 'guessed' };
    }
    for (const e of season.eps) d.introChecked[e.id] = { size: e.size, mtime: e.mtime };
    this.store.save();
    this.announce();
  }

  changed(e) {
    const c = this.store.data.introChecked[e.id];
    return !c || c.size !== e.size || c.mtime !== e.mtime;
  }

  // The best guess from both neighbours, within the first 10 minutes and at least 10 seconds.
  async guess(e, fromPrev, fromNext) {
    const d = this.store.data;
    const logo = (c) => c.start < 1.5 && c.end - c.start < 20;
    const ok = (c) => c.end - c.start >= MIN_S && c.start < SEARCH_S && !logo(c);
    const a = fromPrev.filter(ok)[0];
    const b = fromNext.filter(ok)[0];
    let pick = null;
    if (a && b) {
      if (Math.abs(a.start - b.start) <= 2 && Math.abs(a.end - b.end) <= 2) pick = { start: (a.start + b.start) / 2, end: (a.end + b.end) / 2 };
      else pick = a.len > b.len || (a.len === b.len && a.bits <= b.bits) ? a : b;
    } else pick = a || b || null;
    const cands = [...fromPrev, ...fromNext].filter(ok).map((c) => ({ start: round(c.start), end: round(c.end) }));
    const rejects = d.introRejects[e.id] || [];
    if (pick && rejects.length) pick = this.choose(cands, rejects) || null;
    if (!pick) {
      d.introEpisodes[e.id] = { none: true, source: 'guessed', cands };
      return;
    }
    const snapped = await snap(e.file, pick.start, pick.end);
    d.introEpisodes[e.id] = { start: round(snapped.start), end: round(snapped.end), source: 'guessed', cands };
  }

  async refCodes(season, st) {
    const lib = this.lib();
    const refEp = lib.findFile(st.ref.episodeId) || season.eps.find((e) => e.id === st.ref.episodeId);
    const file = path.join(this.dir, 'ref-' + sha1(season.key) + '.bin');
    try {
      const b = fs.readFileSync(file);
      return new Uint32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length));
    } catch (_) {}
    if (!refEp) return null;
    const all = await this.codes(refEp);
    const ref = all.slice(Math.floor(st.ref.start / STEP), Math.ceil(st.ref.end / STEP));
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(file, Buffer.from(ref.buffer));
    return ref;
  }

  // Against the season's reference: 90% or more = the intro; 10 s or more = Skip covers just
  // that part; less = no intro.
  async applyRef(e, codes, ref) {
    const d = this.store.data;
    if (!ref || !ref.length) return;
    const r = await this.ask({ type: 'ref', ref: ref.slice().buffer, codes: codes.slice().buffer });
    const hit = r.hit;
    const len = hit ? hit.len * STEP : 0;
    if (!hit || len < MIN_S) {
      d.introEpisodes[e.id] = { none: true, source: 'confirmed' };
      return;
    }
    const snapped = await snap(e.file, hit.e0 * STEP, (hit.e1 + 1) * STEP);
    d.introEpisodes[e.id] = { start: round(snapped.start), end: round(snapped.end), source: 'confirmed', ...(len < ref.length * STEP * 0.9 ? { partial: true } : {}) };
  }

  /* ---------- Yes and No ---------- */
  findEp(id) {
    const lib = this.lib();
    const f = lib.findFile(id);
    if (!f || f.kind !== 'episode') return null;
    const season = this.seasons().find((s) => s.eps.some((e) => e.id === f.id));
    return season ? { f, season } : null;
  }

  // Yes: this episode's intro becomes the season's reference; the season is checked again.
  async confirm(episodeId) {
    const found = this.findEp(episodeId);
    if (!found) return;
    const d = this.store.data;
    const cur = d.introEpisodes[found.f.id];
    if (!cur || cur.none) return;
    d.introSeasons[found.season.key] = { status: 'confirmed', ref: { episodeId: found.f.id, start: cur.start, end: cur.end } };
    fs.rmSync(path.join(this.dir, 'ref-' + sha1(found.season.key) + '.bin'), { force: true });
    cur.source = 'confirmed';
    this.store.save();
    this.announce();
    const ref = await this.refCodes(found.season, d.introSeasons[found.season.key]);
    for (const e of found.season.eps) {
      if (e.id === found.f.id) continue;
      await this.applyRef(e, await this.codes(e), ref);
    }
    this.store.save();
    this.announce();
  }

  // No: answers = { start: 'soon' | 'late' | 'ok', end: 'far' | 'short' | 'ok' } about the stretch
  // that was skipped (old). Both "ok" counts as Yes.
  async reject(episodeId, old, answers) {
    if (answers.start === 'ok' && answers.end === 'ok') return this.confirm(episodeId);
    const found = this.findEp(episodeId);
    if (!found) return;
    const d = this.store.data;
    const id = found.f.id;
    const list = (d.introRejects[id] = d.introRejects[id] || []);
    list.push({ start: old.start, end: old.end, said: answers });
    const cur = d.introEpisodes[id] || {};
    // Edges to choose from: the stretches found against the neighbours, and the silences and black
    // screens around the old edges, in the first 10 minutes.
    const near = await boundaries(found.f.file, Math.max(0, old.start - 60), Math.min(SEARCH_S, old.end + 60));
    const points = [...new Set([...(cur.cands || []).flatMap((c) => [c.start, c.end]), ...near].map(round))].filter((t) => t >= 0 && t <= SEARCH_S);
    const pick = this.choose(cur.cands || [], list, points, old, answers);
    d.introEpisodes[id] = pick ? { start: pick.start, end: pick.end, source: 'guessed', cands: cur.cands || [] } : { none: true, source: 'guessed', cands: cur.cands || [] };
    this.store.save();
    this.announce();
  }

  // The best stretch that fits every answer so far, never one that was turned down.
  choose(cands, rejects, points = [], old = null, answers = null) {
    const fits = (c) => {
      if (c.end - c.start < MIN_S || c.start >= SEARCH_S) return false;
      for (const r of rejects) {
        const overlap = Math.max(0, Math.min(c.end, r.end) - Math.max(c.start, r.start));
        if (overlap / Math.max(1, r.end - r.start) > 0.8 && overlap / Math.max(1, c.end - c.start) > 0.8) return false;
        if (r.said.start === 'soon' && !(c.start > r.start + 1)) return false;
        if (r.said.start === 'late' && !(c.start < r.start - 1)) return false;
        if (r.said.start === 'ok' && Math.abs(c.start - r.start) > 1) return false;
        if (r.said.end === 'far' && !(c.end < r.end - 1)) return false;
        if (r.said.end === 'short' && !(c.end > r.end + 1)) return false;
        if (r.said.end === 'ok' && Math.abs(c.end - r.end) > 1) return false;
      }
      return true;
    };
    const ready = cands.filter(fits);
    if (ready.length) return ready[0];
    if (!old || !answers) return null;
    // Move just the edges that were wrong, to the nearest silence, black screen or stretch edge in
    // the direction given.
    const startOpts = answers.start === 'ok' ? [old.start] : points.filter((t) => (answers.start === 'soon' ? t > old.start + 1 : t < old.start - 1)).sort((a, b) => Math.abs(a - old.start) - Math.abs(b - old.start));
    const endOpts = answers.end === 'ok' ? [old.end] : points.filter((t) => (answers.end === 'far' ? t < old.end - 1 : t > old.end + 1)).sort((a, b) => Math.abs(a - old.end) - Math.abs(b - old.end));
    for (const s of startOpts) for (const e of endOpts) if (fits({ start: s, end: e })) return { start: s, end: e };
    return null;
  }

  /* ---------- telling the app ---------- */
  view() {
    const lib = this.lib();
    const d = this.store.data;
    const episodes = {};
    for (const s of lib.scan.series)
      for (const e of s.episodes) {
        const x = d.introEpisodes[e.id];
        if (!x || x.none) continue;
        const st = d.introSeasons[`${s.id}|${e.season}`];
        const id = lib.copies ? lib.copies.displayId(e) : e.id;
        episodes[id] = { start: x.start, end: x.end, guessed: !(st && st.status === 'confirmed'), partial: !!x.partial, season: `${s.id}|${e.season}` };
      }
    return { episodes };
  }

  announce() {
    this.send('intros', this.view());
  }

  // Ids move when a file is renamed (conversion, tidying): its intro data goes with it.
  migrate(oldId, newId) {
    const d = this.store.data;
    for (const k of ['introEpisodes', 'introChecked', 'introRejects']) {
      if (!(oldId in d[k])) continue;
      if (!(newId in d[k])) d[k][newId] = d[k][oldId];
      delete d[k][oldId];
    }
    for (const st of Object.values(d.introSeasons)) if (st.ref && st.ref.episodeId === oldId) st.ref.episodeId = newId;
  }

  // Shows merged or renamed: season keys follow the show's new id. Returns whether anything moved.
  migrateShows(map) {
    const d = this.store.data;
    let moved = false;
    for (const key of Object.keys(d.introSeasons)) {
      const [sid, n] = key.split('|');
      if (!map[sid]) continue;
      const nk = `${map[sid]}|${n}`;
      if (!d.introSeasons[nk]) d.introSeasons[nk] = d.introSeasons[key];
      delete d.introSeasons[key];
      moved = true;
    }
    return moved;
  }

  // Fingerprints of episodes that have gone are deleted.
  tidyCache() {
    const lib = this.lib();
    const keep = new Set();
    for (const s of lib.scan.series) {
      for (const e of s.episodes) keep.add(sha1(`${e.file}|${e.size}|${e.mtime}`) + '.bin');
      for (const n of new Set(s.episodes.map((e) => e.season))) keep.add('ref-' + sha1(`${s.id}|${n}`) + '.bin');
    }
    let names = [];
    try {
      names = fs.readdirSync(this.dir);
    } catch (_) {}
    for (const n of names) if (!keep.has(n)) fs.rmSync(path.join(this.dir, n), { force: true });
  }
}

const round = (t) => Math.round(t * 10) / 10;

// Silence and black-screen boundaries between `from` and `to` seconds.
function boundaries(file, from, to) {
  return new Promise((resolve) => {
    const p = spawn(media.ffmpegPath, ['-hide_banner', '-nostdin', '-ss', String(from), '-t', String(Math.max(1, to - from)), '-i', file,
      '-af', 'silencedetect=noise=-35dB:d=0.3', '-vf', 'blackdetect=d=0.1:pix_th=0.10', '-f', 'null', '-'], { windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => (err = (err + d).slice(-200000)));
    p.on('error', () => resolve([]));
    p.on('close', () => {
      const pts = [...err.matchAll(/(?:silence_start|silence_end|black_start|black_end):\s*(-?[\d.]+)/g)].map((m) => from + Number(m[1]));
      resolve(pts.filter((t) => t >= from && t <= to));
    });
  });
}

// Each edge moves to the nearest silence or black screen within 3 seconds (if there is one).
async function snap(file, start, end) {
  const near = async (t) => {
    const pts = await boundaries(file, Math.max(0, t - 3), t + 3);
    if (!pts.length) return t;
    return pts.sort((a, b) => Math.abs(a - t) - Math.abs(b - t))[0];
  };
  const s = await near(start);
  const e = await near(end);
  return e - s >= MIN_S ? { start: s, end: e } : { start, end };
}

module.exports = { Intros, STEP };
