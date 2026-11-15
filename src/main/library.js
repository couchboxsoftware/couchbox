// Ties the scanner, FFmpeg and TMDB together and builds the library the UI shows.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const { scanLibrary } = require('./scanner');
const media = require('./media');
const { Tmdb } = require('./tmdb');
const { JsonStore } = require('./store');

const url = (p) => (p ? pathToFileURL(p).href : null);
const hash = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);

async function pool(items, n, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const item = items[i++];
      try {
        await fn(item);
      } catch (e) {
        console.error('[library]', e.message);
      }
    }
  });
  await Promise.all(workers);
}

class Library {
  constructor(dataDir, { onChange, onStatus, onMigrate }) {
    this.onMigrate = onMigrate || (() => {});
    this.dataDir = dataDir;
    this.frameDir = path.join(dataDir, 'cache', 'frames');
    this.imageDir = path.join(dataDir, 'cache', 'images');
    // added: { path: time } keeps a converted file's original "added" time, so it doesn't show
    // as NEW or jump the rows just because its file was rewritten.
    // verified: { path: { size, mtime } } files the download checks found complete.
    this.meta = new JsonStore(path.join(dataDir, 'metadata.json'), { files: {}, titles: {}, seasons: {}, overrides: {}, added: {}, verified: {} });
    if (!this.meta.data.added) this.meta.data.added = {};
    if (!this.meta.data.verified) this.meta.data.verified = {};
    this.downloads = null; // set by main.js (downloads.js)
    this.onChange = onChange;
    this.onStatus = onStatus;
    this.root = null;
    this.scan = { films: [], series: [] };
    this.tmdb = new Tmdb('', this.imageDir);
    this.running = null;
    this.again = false;
    this.watcher = null;
    this.afterRefresh = () => {}; // set by main.js: lets the converter look at the new scan
    this._emitTimer = null;
    this.status = { phase: 'idle' };
  }

  setRoot(root) {
    if (this.watcher) this.watcher.close();
    this.watcher = null;
    this.root = root && fs.existsSync(root) ? root : null;
    if (this.root) {
      try {
        let t;
        this.watcher = fs.watch(this.root, { recursive: true }, (_ev, name) => {
          // Conversions in progress and the conversion bin aren't videos. Files that are downloading
          // change all the time: downloads.js checks those itself, so their changes don't rescan.
          if (name && (/\.tmp$/i.test(name) || /\.converting\.\w+$/i.test(name) || /^\.couchbox-bin\b/i.test(name))) return;
          if (name && this.downloads && this.downloads.activeRel(this.root).has(name.toLowerCase())) return;
          // Rescan 2.5 s after the first change, not the last: a file being written changes all
          // the time, and waiting for quiet would never rescan until it finished.
          if (t) return;
          t = setTimeout(() => {
            t = null;
            this.refresh();
          }, 2500);
        });
        this.watcher.on('error', () => {});
      } catch (_) {
        /* watching is a nice-to-have */
      }
    }
  }

  setTmdbKey(key) {
    const changed = key !== this.tmdb.key;
    this.tmdb = new Tmdb(key, this.imageDir);
    if (changed) {
      // Give previously unmatched titles another go with the new key.
      for (const [id, t] of Object.entries(this.meta.data.titles)) if (t.noMatch) delete this.meta.data.titles[id];
      this.meta.save();
    }
  }

  setStatus(s) {
    this.status = s;
    this.onStatus(s);
  }

  // Runs one refresh at a time; a request during a run queues exactly one more.
  refresh() {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      do {
        this.again = false;
        await this._refresh();
      } while (this.again);
      this.running = null;
    })();
    return this.running;
  }

  async _refresh() {
    if (!this.root) {
      this.scan = { films: [], series: [] };
      this.emit(true);
      return;
    }
    this.setStatus({ phase: 'scanning' });
    this.scan = scanLibrary(this.root);
    this.applyAdded();
    this.migrateIds();
    this.emit(true);

    const files = [...this.scan.films, ...this.scan.series.flatMap((s) => s.episodes)];
    const md = this.meta.data;
    const changed = (f) => {
      const m = md.files[f.file];
      return !m || m.size !== f.size || m.mtime !== f.mtime;
    };
    const verified = (f) => {
      const v = md.verified[f.file];
      return !!v && v.size === f.size && v.mtime === f.mtime;
    };
    // New, changed and temporarily named files may still be downloading: watch them until done.
    if (this.downloads) this.downloads.track(files.filter((f) => f.partial || (changed(f) && !verified(f)) || this.downloads.has(f.file)), files);
    // Read each file once while it downloads (for its length), then again when it's finished.
    const toProbe = files.filter((f) => changed(f) && !(this.downloads && this.downloads.active(f.file) && md.files[f.file]));
    let done = 0;
    if (toProbe.length) this.setStatus({ phase: 'reading', done, total: toProbe.length });
    await pool(toProbe, 3, async (f) => {
      const info = await media.probe(f.file);
      this.meta.data.files[f.file] = { ...info, size: f.size, mtime: f.mtime };
      this.setStatus({ phase: 'reading', done: ++done, total: toProbe.length });
      this.emit();
    });
    this.meta.save();
    this.afterRefresh(); // formats are known now: the converter can queue what won't play

    if (this.tmdb.enabled) await this.matchAll();
    await this.makeFrames();
    this.meta.save();
    this.setStatus({ phase: 'idle' });
    this.emit(true);
  }

  // Converted files keep the "added" time of the original they replaced.
  applyAdded() {
    const added = this.meta.data.added;
    for (const f of this.scan.films) if (added[f.file]) f.added = added[f.file];
    for (const s of this.scan.series) {
      for (const e of s.episodes) if (added[e.file]) e.added = added[e.file];
      s.added = Math.max(0, ...s.episodes.map((e) => e.added));
    }
  }

  // Shows that earlier versions split by season folder ("…S01", "…S02") are now one show.
  // Hand their old ids to main.js (My list, intro skip, kids setting) and tidy the metadata:
  // a "Fix match" choice carries over; the old posters/info are dropped and fetched again.
  migrateIds() {
    const map = {};
    for (const s of this.scan.series) for (const old of s.legacyIds || []) if (old !== s.id) map[old] = s.id;
    if (!Object.keys(map).length) return;
    const m = this.meta.data;
    for (const [old, now] of Object.entries(map)) {
      if (m.overrides[old] != null && m.overrides[now] == null) m.overrides[now] = m.overrides[old];
      delete m.overrides[old];
      delete m.titles[old];
      delete m.seasons[old];
    }
    this.meta.save();
    this.onMigrate(map);
  }

  async matchAll() {
    const titles = this.meta.data.titles;
    const items = [...this.scan.films, ...this.scan.series].filter((it) => !titles[it.id] || titles[it.id].tmdbId == null && !titles[it.id].noMatch);
    let done = 0;
    const total = items.length;
    if (total) this.setStatus({ phase: 'matching', done, total });
    try {
      await pool(items, 4, async (it) => {
        await this.matchItem(it);
        this.setStatus({ phase: 'matching', done: ++done, total });
        this.emit();
      });
      // Episode names and stills for every season that exists on disk.
      const seasonJobs = [];
      for (const s of this.scan.series) {
        const t = titles[s.id];
        if (!t || !t.tmdbId) continue;
        const have = this.meta.data.seasons[s.id] || {};
        for (const n of new Set(s.episodes.map((e) => e.season))) if (!have[n]) seasonJobs.push([s, t.tmdbId, n]);
      }
      done = 0;
      if (seasonJobs.length) this.setStatus({ phase: 'episodes', done, total: seasonJobs.length });
      await pool(seasonJobs, 3, async ([s, tmdbId, n]) => {
        const data = await this.tmdb.season(tmdbId, n);
        this.meta.data.seasons[s.id] = this.meta.data.seasons[s.id] || {};
        this.meta.data.seasons[s.id][n] = data;
        this.setStatus({ phase: 'episodes', done: ++done, total: seasonJobs.length });
        this.emit();
      });
    } catch (e) {
      this.onStatus({ phase: 'error', message: e.message });
    }
  }

  async matchItem(it, forcedId) {
    const override = forcedId || this.meta.data.overrides[it.id];
    let id = override;
    if (!id) {
      const results = it.kind === 'film' ? await this.tmdb.searchFilm(it.title, it.year) : await this.tmdb.searchSeries(it.title, it.year);
      const best = Tmdb.pick(results, it.title, it.year, it.kind === 'film' ? 'release_date' : 'first_air_date');
      if (!best) {
        this.meta.data.titles[it.id] = { noMatch: true };
        return;
      }
      id = best.id;
    }
    const details = it.kind === 'film' ? await this.tmdb.filmDetails(id) : await this.tmdb.seriesDetails(id);
    this.meta.data.titles[it.id] = details || { noMatch: true };
  }

  async searchMatches(itemId, query) {
    const it = this.findItem(itemId);
    if (!it || !this.tmdb.enabled) return [];
    const results = it.kind === 'film' ? await this.tmdb.searchFilm(query) : await this.tmdb.searchSeries(query);
    return results.slice(0, 8).map((r) => ({
      id: r.id,
      title: r.title || r.name,
      year: (r.release_date || r.first_air_date || '').slice(0, 4),
      overview: (r.overview || '').slice(0, 160),
      poster: r.poster_path ? 'https://image.tmdb.org/t/p/w92' + r.poster_path : null,
    }));
  }

  async fixMatch(itemId, tmdbId) {
    const it = this.findItem(itemId);
    if (!it) return;
    this.meta.data.overrides[itemId] = tmdbId;
    delete this.meta.data.seasons[itemId];
    await this.matchItem(it, tmdbId);
    this.meta.save();
    this.emit(true);
    this.refresh();
  }

  async clearMetadata() {
    this.meta.data.titles = {};
    this.meta.data.seasons = {};
    this.meta.save(true);
    this.emit(true);
    return this.refresh();
  }

  async makeFrames() {
    const jobs = [];
    const files = this.meta.data.files;
    const titles = this.meta.data.titles;
    for (const f of this.scan.films) {
      const t = titles[f.id];
      if (!(t && t.backdrop) && !(files[f.file] && files[f.file].frame)) jobs.push(f);
    }
    for (const s of this.scan.series) {
      const seasons = this.meta.data.seasons[s.id] || {};
      for (const e of s.episodes) {
        const ep = seasons[e.season] && seasons[e.season][e.episode];
        if (!(ep && ep.still) && !(files[e.file] && files[e.file].frame)) jobs.push(e);
      }
    }
    let done = 0;
    if (jobs.length) this.setStatus({ phase: 'frames', done, total: jobs.length });
    await pool(jobs, 2, async (f) => {
      const info = files[f.file];
      if (!info || !info.duration) return;
      const out = path.join(this.frameDir, hash(f.file + f.size) + '.jpg');
      const at = f.kind === 'film' ? info.duration * 0.2 : info.duration * 0.25;
      if (fs.existsSync(out) || (await media.grabFrame(f.file, at, out, f.kind === 'film' ? 960 : 480))) info.frame = out;
      this.setStatus({ phase: 'frames', done: ++done, total: jobs.length });
      this.emit();
    });
  }

  findItem(id) {
    return this.scan.films.find((f) => f.id === id) || this.scan.series.find((s) => s.id === id);
  }

  findFile(id) {
    for (const f of this.scan.films) if (f.id === id) return f;
    for (const s of this.scan.series) for (const e of s.episodes) if (e.id === id) return e;
    return null;
  }

  emit(now = false) {
    clearTimeout(this._emitTimer);
    if (now) this.onChange(this.model());
    else this._emitTimer = setTimeout(() => this.onChange(this.model()), 1200);
  }

  fileFields(f) {
    const info = this.meta.data.files[f.file] || {};
    return {
      file: f.file,
      video: url(f.file),
      duration: info.duration || 0,
      playable: info.playable !== false,
      frame: url(info.frame),
      subs: f.subs.map((s, i) => ({ index: i, label: s.label })),
      added: f.added,
    };
  }

  model() {
    const titles = this.meta.data.titles;
    const films = this.scan.films.map((f) => {
      const t = titles[f.id] || {};
      const ff = this.fileFields(f);
      return {
        id: f.id,
        kind: 'film',
        title: t.title || f.title,
        year: t.year || f.year,
        overview: t.overview || '',
        tagline: t.tagline || '',
        genres: t.genres || [],
        rating: t.rating || null,
        certification: t.certification || '',
        kidsSafe: !!t.kidsSafe,
        matched: !!t.tmdbId,
        imported: !!f.imported,
        poster: url(t.poster),
        backdrop: url(t.backdrop) || ff.frame,
        ...ff,
      };
    });
    const series = this.scan.series.map((s) => {
      const t = titles[s.id] || {};
      const seasonMeta = this.meta.data.seasons[s.id] || {};
      const bySeason = new Map();
      for (const e of s.episodes) {
        const m = (seasonMeta[e.season] && seasonMeta[e.season][e.episode]) || {};
        const ff = this.fileFields(e);
        if (!bySeason.has(e.season)) bySeason.set(e.season, []);
        bySeason.get(e.season).push({
          id: e.id,
          kind: 'episode',
          seriesId: s.id,
          season: e.season,
          episode: e.episode,
          title: m.title || e.fileTitle || 'Episode ' + e.episode,
          overview: m.overview || '',
          still: url(m.still) || ff.frame,
          ...ff,
        });
      }
      const seasons = [...bySeason.entries()]
        .sort((a, b) => (a[0] === 0) - (b[0] === 0) || a[0] - b[0])
        .map(([n, eps]) => ({ number: n, name: (t.seasonNames && t.seasonNames[n]) || (n === 0 ? 'Specials' : 'Season ' + n), episodes: eps }));
      const firstFrame = seasons[0] && seasons[0].episodes[0] && seasons[0].episodes[0].frame;
      return {
        id: s.id,
        kind: 'series',
        title: t.title || s.title,
        year: t.year || s.year,
        overview: t.overview || '',
        tagline: t.tagline || '',
        genres: t.genres || [],
        rating: t.rating || null,
        certification: t.certification || '',
        kidsSafe: !!t.kidsSafe,
        matched: !!t.tmdbId,
        poster: url(t.poster),
        backdrop: url(t.backdrop) || firstFrame,
        added: s.added,
        seasons,
        episodeCount: s.episodes.length,
      };
    });
    return { root: this.root, films, series, status: this.status, tmdb: this.tmdb.enabled };
  }

  subtitle(fileId, index) {
    const f = this.findFile(fileId);
    const s = f && f.subs[index];
    return s ? media.subtitleToVtt(s.file) : null;
  }

  // A short name for a file, for the conversion queue: "Fernhill (2018)" or "Desperate Housewives S1:E3".
  labelFor(f) {
    const titles = this.meta.data.titles;
    if (f.kind === 'film') {
      const t = titles[f.id] || {};
      const title = t.title || f.title;
      const year = t.year || f.year;
      return year ? `${title} (${year})` : title;
    }
    const show = this.scan.series.find((s) => s.id === f.seriesId);
    const t = (show && titles[show.id]) || {};
    const code = f.season === 0 ? `Special ${f.episode}` : `S${f.season}:E${f.episode}`;
    return `${t.title || (show && show.title) || 'Episode'} ${code}`;
  }
}

module.exports = { Library };
