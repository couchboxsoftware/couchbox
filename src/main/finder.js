// "Find videos": searches the computer for video files, checks them against TMDB, works out
// which are new, which are copies and which are different versions, then copies or moves
// the chosen ones into the Couchbox folder.
//
// Rules (agreed with the user, see README "Find videos"):
// - A video is identified by its TMDB match (film, or show + season + episode). Unrecognised
//   videos are identified by their file content (size + sampled fingerprint).
// - Same identity and lengths within 30 seconds = the same video. Already in Couchbox = can't
//   be added. Several copies on the computer = only the best quality one can be added.
// - Same identity but more than 30 seconds apart = a different version: flagged yellow,
//   still added (with its length in the file name).
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const media = require('./media');
const { Tmdb } = require('./tmdb');
const { parseTitleYear, episodeInfo } = require('./scanner');

const SAME_LENGTH_S = 30;
const ALL_TYPES = ['mp4', 'mkv', 'avi', 'mov', 'wmv', 'm4v', 'webm'];
const SKIP_NAMES = /^(windows|program files|program files \(x86\)|programdata|appdata|\$recycle\.bin|system volume information|\$windows\.~bt|\$windows\.~ws|\$sysreset|recovery|perflogs|msocache|node_modules|\.git|\.cache)$/i;
const SUB_EXT = new Set(['.srt', '.vtt']);

const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const safeName = (s) => s.replace(/[<>:"/\\|?*\x00-\x1f]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '');
const pad2 = (n) => String(n).padStart(2, '0');
const fmtLen = (sec) => {
  const m = Math.round(sec / 60);
  return m >= 60 ? `${Math.floor(m / 60)}h ${pad2(m % 60)}m` : `${m}m`;
};

async function pool(items, n, fn, shouldStop) {
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length && !shouldStop()) {
      const item = items[i++];
      try {
        await fn(item);
      } catch (e) {
        console.error('[finder]', e.message);
      }
    }
  });
  await Promise.all(workers);
}

// Reads 3 x 64 KB samples (start, middle, end) plus the size: enough to spot exact copies
// without reading whole multi-gigabyte files.
async function fingerprint(file, size) {
  const h = crypto.createHash('sha1');
  h.update(String(size));
  const fh = await fsp.open(file, 'r');
  try {
    const chunk = 65536;
    for (const at of [0, Math.max(0, Math.floor(size / 2) - chunk / 2), Math.max(0, size - chunk)]) {
      const buf = Buffer.alloc(Math.min(chunk, size));
      await fh.read(buf, 0, buf.length, at);
      h.update(buf);
    }
  } finally {
    await fh.close();
  }
  return h.digest('hex');
}

// Is the TMDB result a confident match for the title we parsed from the file name?
function confident(result, title, year, dateField) {
  if (!result) return false;
  const t = norm(title);
  if (t.length < 2) return false;
  const names = [result.title, result.name, result.original_title, result.original_name].map(norm).filter(Boolean);
  const y = parseInt((result[dateField] || '').slice(0, 4), 10);
  if (names.includes(t)) return !year || !y || Math.abs(y - year) <= 1;
  // Close but not exact (e.g. "Alien Directors Cut" vs "Alien"): only with a matching year.
  return !!year && y === year && names.some((n) => n.length > 3 && (t.startsWith(n) || n.startsWith(t)));
}

class Finder {
  constructor({ getLibrary, send, getExcluded }) {
    this.getLibrary = getLibrary;
    this.send = send;
    this.getExcluded = getExcluded; // folders never searched (Couchbox folder, app data)
    this.results = [];
    this.byId = new Map();
    this.status = { phase: 'idle' };
    this.job = 0;
    this.stopFlag = false;
    this.addJob = null;
    this._sendTimer = null;
    this._lib = null;
  }

  /* ---------- state for the window ---------- */
  state() {
    return { status: this.status, results: this.results.map((r) => this.view(r)) };
  }

  view(r) {
    return {
      id: r.id, file: r.file, name: path.basename(r.file), dir: path.dirname(r.file), ext: r.ext.toUpperCase(),
      size: r.size, duration: r.duration, height: r.height, state: r.state, label: r.label || '', note: r.note || '',
      group: r.group || null, selected: !!r.selected, canSelect: ['match', 'version', 'nomatch'].includes(r.state),
    };
  }

  emit(now = false) {
    clearTimeout(this._sendTimer);
    const go = () => this.send('finder', this.state());
    if (now) go();
    else this._sendTimer = setTimeout(go, 350);
  }

  /* ---------- searching ---------- */
  async search({ roots, minMinutes, maxMinutes, types }) {
    const job = ++this.job;
    this.stopFlag = false;
    this.results = [];
    this.byId = new Map();
    const lib = this.getLibrary();
    const tmdb = lib.tmdb;
    const exts = new Set((types && types.length ? types : ALL_TYPES).map((t) => '.' + t.toLowerCase()));
    const minS = minMinutes > 0 ? minMinutes * 60 : 0;
    const maxS = maxMinutes > 0 ? maxMinutes * 60 : Infinity;
    const excluded = this.getExcluded().filter(Boolean).map((p) => path.resolve(p).toLowerCase());
    const stopped = () => this.stopFlag || job !== this.job;
    const counts = { folders: 0, videos: 0 };
    this.status = { phase: 'searching', ...counts, tmdb: tmdb.enabled };
    this.emit(true);
    this._lib = this.libraryIndex(lib);

    // 1. Walk the folders; probe each candidate video as we go (length + resolution).
    const probeQueue = [];
    let probing = 0;
    const probeOne = async (file, st) => {
      probing++;
      try {
        const info = await media.probe(file);
        if (stopped()) return;
        const dur = info.duration || 0;
        if (!dur || dur < minS || dur > maxS) return;
        const r = { id: 'f' + this.results.length, file, ext: path.extname(file).slice(1), size: st.size, mtime: st.mtimeMs, duration: dur, height: info.height || 0, width: info.width || 0, state: tmdb.enabled ? 'checking' : 'nomatch' };
        if (!tmdb.enabled) r.label = 'Not checked: no TMDB key';
        this.results.push(r);
        this.byId.set(r.id, r);
        counts.videos++;
        this.checkQueue.push(r);
        this.kickChecks(tmdb, stopped);
        this.emit();
      } finally {
        probing--;
      }
    };
    this.checkQueue = [];
    this.checking = 0;

    const seen = new Set();
    const walk = async (dir, depth) => {
      if (stopped() || depth > 14) return;
      const key = dir.toLowerCase();
      if (seen.has(key) || excluded.some((x) => key === x || key.startsWith(x + path.sep))) return;
      seen.add(key);
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch (_) {
        return;
      }
      counts.folders++;
      if (counts.folders % 50 === 0) {
        this.status = { phase: 'searching', ...counts, tmdb: tmdb.enabled };
        this.emit();
      }
      for (const e of entries) {
        if (stopped()) return;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (!SKIP_NAMES.test(e.name) && !e.name.startsWith('.')) await walk(full, depth + 1);
        } else if (e.isFile() && exts.has(path.extname(e.name).toLowerCase()) && !/\bsample\b/i.test(e.name)) {
          let st;
          try {
            st = await fsp.stat(full);
          } catch (_) {
            continue;
          }
          if (st.size < 1024 * 1024) continue; // under 1 MB can't be a long video
          while (probing >= 3 && !stopped()) await new Promise((r) => setTimeout(r, 15));
          probeQueue.push(probeOne(full, st));
        }
      }
    };
    for (const root of roots) await walk(path.resolve(root), 0);
    await Promise.all(probeQueue);
    while ((this.checking > 0 || this.checkQueue.length) && !stopped()) await new Promise((r) => setTimeout(r, 100));
    if (job !== this.job) return this.state();

    // 2. Work out copies, versions and what's already in Couchbox.
    this.status = { phase: 'comparing', ...counts, tmdb: tmdb.enabled };
    this.emit(true);
    await this.classify();
    this.status = { phase: this.stopFlag ? 'stopped' : 'done', ...counts, tmdb: tmdb.enabled };
    this.emit(true);
    return this.state();
  }

  stop() {
    this.stopFlag = true;
  }

  kickChecks(tmdb, stopped) {
    while (this.checking < 4 && this.checkQueue.length && !stopped()) {
      const r = this.checkQueue.shift();
      this.checking++;
      this.identify(r, tmdb)
        .catch((e) => {
          r.state = 'nomatch';
          r.label = /key/i.test(e.message) ? e.message : 'Not recognised';
        })
        .finally(() => {
          this.checking--;
          this.emit();
          this.kickChecks(tmdb, stopped);
        });
    }
  }

  // Asks TMDB what this file is. Sets r.identity (e.g. "movie:1234") and a readable label.
  async identify(r, tmdb) {
    if (!tmdb.enabled) return;
    const base = path.basename(r.file, path.extname(r.file));
    const ep = episodeInfo(base + path.extname(r.file));
    if (ep && ep.season != null) {
      let showRaw = (ep.showHint || '').replace(/[._-]+$/g, ' ').trim();
      if (!showRaw) {
        const parent = path.basename(path.dirname(r.file));
        showRaw = /^(season|series|s)[ ._-]*\d+$|^specials?$/i.test(parent) ? path.basename(path.dirname(path.dirname(r.file))) : parent;
      }
      const show = parseTitleYear(showRaw);
      const results = await tmdb.searchSeries(show.title, show.year);
      const best = Tmdb.pick(results, show.title, show.year, 'first_air_date');
      if (confident(best, show.title, show.year, 'first_air_date')) {
        r.state = 'match';
        r.kind = 'episode';
        r.identity = `tv:${best.id}:${ep.season}:${ep.episode}`;
        r.title = best.name;
        r.season = ep.season;
        r.episode = ep.episode;
        r.label = `${best.name} · S${ep.season} E${ep.episode}`;
        return;
      }
    } else {
      const parsed = parseTitleYear(base);
      const results = await tmdb.searchFilm(parsed.title, parsed.year);
      const best = Tmdb.pick(results, parsed.title, parsed.year, 'release_date');
      if (confident(best, parsed.title, parsed.year, 'release_date')) {
        const y = parseInt((best.release_date || '').slice(0, 4), 10) || null;
        r.state = 'match';
        r.kind = 'film';
        r.identity = `movie:${best.id}`;
        r.title = best.title;
        r.year = y;
        r.label = y ? `${best.title} (${y})` : best.title;
        return;
      }
    }
    r.state = 'nomatch';
    r.label = 'Not recognised';
  }

  /* ---------- what's already in Couchbox ---------- */
  // Identity -> [durations] for everything in the library, plus file sizes for exact-copy checks.
  libraryIndex(lib) {
    const titles = lib.meta.data.titles;
    const files = lib.meta.data.files;
    const byIdentity = new Map();
    const bySize = new Map();
    const add = (key, file) => {
      if (!byIdentity.has(key)) byIdentity.set(key, []);
      byIdentity.get(key).push({ file, duration: (files[file] && files[file].duration) || 0 });
    };
    for (const f of lib.scan.films) {
      const t = titles[f.id];
      if (t && t.tmdbId) add('movie:' + t.tmdbId, f.file);
      add('name:' + norm(f.title) + ':' + (f.year || ''), f.file);
      if (!bySize.has(f.size)) bySize.set(f.size, []);
      bySize.get(f.size).push(f.file);
    }
    for (const s of lib.scan.series) {
      const t = titles[s.id];
      for (const e of s.episodes) {
        if (t && t.tmdbId) add(`tv:${t.tmdbId}:${e.season}:${e.episode}`, e.file);
        add('name:' + norm(s.title) + `:s${e.season}e${e.episode}`, e.file);
        if (!bySize.has(e.size)) bySize.set(e.size, []);
        bySize.get(e.size).push(e.file);
      }
    }
    return { byIdentity, bySize, root: lib.root ? path.resolve(lib.root).toLowerCase() : null };
  }

  nameKey(r) {
    if (r.kind === 'film') return 'name:' + norm(r.title) + ':' + (r.year || '');
    if (r.kind === 'episode') return 'name:' + norm(r.title) + `:s${r.season}e${r.episode}`;
    return null;
  }

  // Durations of library copies of this video (by TMDB identity, or title as a fallback).
  libraryCopies(r, idx) {
    if (!r.identity) return [];
    return [...(idx.byIdentity.get(r.identity) || []), ...(idx.byIdentity.get(this.nameKey(r)) || [])];
  }

  async isExactLibraryCopy(r, idx) {
    const same = idx.bySize.get(r.size);
    if (!same || !same.length) return false;
    r.fp = r.fp || (await fingerprint(r.file, r.size));
    for (const f of same) {
      try {
        if ((await fingerprint(f, r.size)) === r.fp) return true;
      } catch (_) {}
    }
    return false;
  }

  async classify() {
    const idx = (this._lib = this.libraryIndex(this.getLibrary()));
    // Videos added in this session stay marked as added; everything else is worked out afresh.
    const live = this.results.filter((r) => r.state !== 'checking' && !r.added);
    for (const r of live) {
      delete r.group;
      r.note = '';
      if (r.state === 'inLibrary' || r.state === 'copy' || r.state === 'version') r.state = r.identity ? 'match' : 'nomatch';
    }

    // Exact copies of library files (any video, recognised or not).
    for (const r of live) {
      if (await this.isExactLibraryCopy(r, idx)) {
        r.state = 'inLibrary';
        r.note = 'Already in Couchbox (the same file)';
      }
    }

    // Recognised videos: group by identity, then by length (within 30 s = same version).
    const byIdentity = new Map();
    for (const r of live) if (r.identity && r.state !== 'inLibrary') {
      if (!byIdentity.has(r.identity)) byIdentity.set(r.identity, []);
      byIdentity.get(r.identity).push(r);
    }
    for (const [identity, list] of byIdentity) {
      const libDurations = this.libraryCopies(list[0], idx).map((c) => c.duration).filter((d) => d > 0);
      const libHasAny = this.libraryCopies(list[0], idx).length > 0;
      // Cluster this identity's files by length.
      list.sort((a, b) => a.duration - b.duration);
      const clusters = [];
      for (const r of list) {
        const c = clusters.find((cl) => Math.abs(cl.anchor - r.duration) <= SAME_LENGTH_S);
        if (c) c.items.push(r);
        else clusters.push({ anchor: r.duration, items: [r] });
      }
      for (const cl of clusters) cl.inLib = libDurations.some((d) => Math.abs(d - cl.anchor) <= SAME_LENGTH_S) || (libHasAny && !libDurations.length);
      // If Couchbox has none of these yet, one length counts as "the" film (green) and any other
      // lengths are versions of it (yellow): the length with the most copies, then the shorter.
      const main = libHasAny ? null : [...clusters].sort((a, b) => b.items.length - a.items.length || a.anchor - b.anchor)[0];
      for (const cl of clusters) {
        if (cl.inLib) {
          for (const r of cl.items) {
            r.state = 'inLibrary';
            r.note = 'Already in Couchbox';
          }
          continue;
        }
        const nearest = (list) => [...list].sort((a, b) => Math.abs(a - cl.anchor) - Math.abs(b - cl.anchor))[0];
        const group = identity + '@' + Math.round(cl.anchor);
        this.pickBest(cl.items, group, (r) => {
          if (cl === main) r.state = 'match';
          else {
            r.state = 'version';
            r.note = libDurations.length
              ? `Possibly a different version: ${fmtLen(cl.anchor)} (Couchbox has ${fmtLen(nearest(libDurations))})`
              : `Possibly a different version: ${fmtLen(cl.anchor)} (another copy is ${fmtLen(main.anchor)})`;
          }
        });
      }
    }

    // Unrecognised videos: exact copies of each other (same size + fingerprint) are one video.
    const bySize = new Map();
    for (const r of live) if (!r.identity && r.state === 'nomatch') {
      if (!bySize.has(r.size)) bySize.set(r.size, []);
      bySize.get(r.size).push(r);
    }
    for (const list of bySize.values()) {
      if (list.length < 2) {
        list[0].group = 'fp:' + list[0].id;
        continue;
      }
      const byFp = new Map();
      for (const r of list) {
        try {
          r.fp = r.fp || (await fingerprint(r.file, r.size));
        } catch (_) {
          r.fp = 'x' + r.id;
        }
        if (!byFp.has(r.fp)) byFp.set(r.fp, []);
        byFp.get(r.fp).push(r);
      }
      for (const [fp, same] of byFp) this.pickBest(same, 'fp:' + fp, (r) => (r.state = 'nomatch'));
    }

    // Pre-ticking: recognised new videos and different versions are ticked; unrecognised aren't.
    for (const r of live) {
      if (r.userSelected != null && ['match', 'version', 'nomatch'].includes(r.state)) r.selected = r.userSelected;
      else r.selected = r.state === 'match' || r.state === 'version';
    }
  }

  // Best copy (highest resolution, then biggest file, then the cleaner name - not "... (copy)")
  // stays selectable; the rest are copies.
  pickBest(items, group, markBest) {
    const copyish = (r) => (/\bcopy\b|\(\d+\)\s*$/i.test(path.basename(r.file, path.extname(r.file))) ? 1 : 0);
    const sorted = [...items].sort(
      (a, b) =>
        (b.preferred ? 1 : 0) - (a.preferred ? 1 : 0) || b.height - a.height || b.size - a.size || copyish(a) - copyish(b) || path.basename(a.file).length - path.basename(b.file).length
    );
    sorted.forEach((r, i) => {
      r.group = group;
      if (i === 0) markBest(r);
      else {
        r.state = 'copy';
        r.note = `Another copy of ${sorted[0].label && sorted[0].identity ? sorted[0].label : path.basename(sorted[0].file)}`;
        r.selected = false;
      }
    });
  }

  /* ---------- selection ---------- */
  select(ids, value) {
    for (const id of ids) {
      const r = this.byId.get(id);
      if (r && ['match', 'version', 'nomatch'].includes(r.state)) r.selected = r.userSelected = !!value;
    }
    this.emit(true);
    return this.state();
  }

  // "Use this copy instead": make a different copy in the group the one that gets added.
  async useCopy(id) {
    const r = this.byId.get(id);
    if (!r || !r.group) return this.state();
    for (const o of this.results) if (o.group === r.group) o.preferred = o === r;
    await this.classify();
    this.emit(true);
    return this.state();
  }

  /* ---------- adding to Couchbox ---------- */
  destinationFor(r, root) {
    const ext = path.extname(r.file);
    const versionTag = r.state === 'version' ? ` - ${fmtLen(r.duration)}` : '';
    if (r.kind === 'film') return path.join(root, 'Films', safeName(`${r.title}${r.year ? ` (${r.year})` : ''}${versionTag}`) + ext);
    if (r.kind === 'episode') {
      const show = safeName(r.title);
      return path.join(root, 'Series', show, `Season ${pad2(r.season)}`, safeName(`${show} - S${pad2(r.season)}E${pad2(r.episode)}${versionTag}`) + ext);
    }
    return path.join(root, 'Imported', path.basename(r.file));
  }

  subtitlesOf(file) {
    const dir = path.dirname(file);
    const base = path.basename(file, path.extname(file)).toLowerCase();
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch (_) {}
    return names
      .filter((n) => SUB_EXT.has(path.extname(n).toLowerCase()) && n.toLowerCase().startsWith(base))
      .map((n) => ({ file: path.join(dir, n), suffix: n.slice(base.length) }));
  }

  async plan(mode) {
    const lib = this.getLibrary();
    const root = lib.root;
    const picked = this.results.filter((r) => r.selected && ['match', 'version', 'nomatch'].includes(r.state));
    const total = picked.reduce((n, r) => n + r.size, 0);
    let free = null;
    try {
      const s = await fsp.statfs(root);
      free = s.bavail * s.bsize;
    } catch (_) {}
    const sameDrive = (f) => path.parse(path.resolve(f)).root.toLowerCase() === path.parse(path.resolve(root)).root.toLowerCase();
    const needMove = picked.filter((r) => !sameDrive(r.file)).reduce((n, r) => n + r.size, 0);
    return { root, count: picked.length, total, free, needCopy: total, needMove, mode };
  }

  async add(mode, onProgress) {
    if (this.addJob) return { error: 'Already adding videos.' };
    const lib = this.getLibrary();
    const root = lib.root;
    if (!root) return { error: 'Choose your Couchbox video folder first.' };
    const plan = await this.plan(mode);
    const need = mode === 'move' ? plan.needMove : plan.needCopy;
    if (plan.free != null && need > plan.free) return { error: 'Not enough free space in your Couchbox folder.' };

    const job = (this.addJob = { stop: false, current: null });
    // Final duplicate check against the library as it is right now.
    await this.classify();
    const picked = this.results.filter((r) => r.selected && ['match', 'version', 'nomatch'].includes(r.state));
    const skippedDup = plan.count - picked.length;
    const summary = { added: 0, skipped: [], failed: [], stopped: false, mode };
    if (skippedDup > 0) summary.skipped.push({ reason: 'already in Couchbox', count: skippedDup });
    const doneIdentities = new Set();
    const totalBytes = picked.reduce((n, r) => n + r.size, 0);
    let doneBytes = 0;

    for (let i = 0; i < picked.length; i++) {
      if (job.stop) {
        summary.stopped = true;
        break;
      }
      const r = picked[i];
      const label = r.identity ? r.label : path.basename(r.file);
      onProgress({ index: i + 1, count: picked.length, label, bytes: doneBytes, totalBytes, mode });
      const key = r.identity ? r.identity + '@' + Math.round(r.duration / SAME_LENGTH_S) : 'fp:' + (r.fp || r.file);
      if (doneIdentities.has(key)) {
        summary.skipped.push({ reason: 'already added in this batch', file: r.file });
        continue;
      }
      const dest = this.destinationFor(r, root);
      if (fs.existsSync(dest)) {
        summary.skipped.push({ reason: 'a file with that name is already there', file: r.file, dest });
        continue;
      }
      try {
        await fsp.mkdir(path.dirname(dest), { recursive: true });
        await this.transfer(r.file, dest, mode, job, (b) => onProgress({ index: i + 1, count: picked.length, label, bytes: doneBytes + b, totalBytes, mode }));
        for (const s of this.subtitlesOf(r.file)) {
          const sd = dest.slice(0, -path.extname(dest).length) + s.suffix;
          if (!fs.existsSync(sd)) await this.transfer(s.file, sd, mode, job, () => {}).catch(() => {});
        }
        doneIdentities.add(key);
        summary.added++;
        r.added = true;
        r.state = 'inLibrary';
        r.note = mode === 'move' ? 'Moved to Couchbox' : 'Copied to Couchbox';
        r.selected = false;
        if (mode === 'move') r.file = dest;
      } catch (e) {
        if (job.stop) {
          summary.stopped = true;
          break;
        }
        summary.failed.push({ file: r.file, reason: e.message });
      }
      doneBytes += r.size;
    }
    this.addJob = null;
    this.emit(true);
    lib.refresh();
    return summary;
  }

  stopAdd() {
    if (!this.addJob) return;
    this.addJob.stop = true;
    if (this.addJob.current) this.addJob.current.destroy(new Error('stopped'));
  }

  // Copy (or move) one file safely: write to "<dest>.part", check the size, then rename.
  // A move on the same drive is a rename; across drives it's a checked copy, then a delete.
  async transfer(src, dest, mode, job, onBytes) {
    if (mode === 'move') {
      try {
        await fsp.rename(src, dest);
        onBytes(fs.statSync(dest).size);
        return;
      } catch (e) {
        if (e.code !== 'EXDEV') throw e;
      }
    }
    const tmp = dest + '.part';
    const size = (await fsp.stat(src)).size;
    await new Promise((resolve, reject) => {
      const rs = fs.createReadStream(src, { highWaterMark: 1 << 20 });
      const ws = fs.createWriteStream(tmp);
      job.current = rs;
      let bytes = 0;
      rs.on('data', (c) => {
        bytes += c.length;
        onBytes(bytes);
      });
      rs.on('error', (e) => ws.destroy(e));
      ws.on('error', reject);
      ws.on('finish', resolve);
      rs.on('close', () => {
        if (rs.destroyed && bytes < size) ws.destroy(new Error('stopped'));
      });
      rs.pipe(ws);
    }).catch(async (e) => {
      await fsp.unlink(tmp).catch(() => {});
      throw e;
    });
    job.current = null;
    if ((await fsp.stat(tmp)).size !== size) {
      await fsp.unlink(tmp).catch(() => {});
      throw new Error("The copy didn't match the original");
    }
    await fsp.rename(tmp, dest);
    if (mode === 'move') await fsp.unlink(src);
  }
}

module.exports = { Finder, ALL_TYPES, fmtLen };
