// The Movie Database (TMDB) client: matching titles and downloading artwork.
// Accepts either a v3 API key or a v4 read access token.
const fs = require('fs');
const path = require('path');

const API = 'https://api.themoviedb.org/3';
const IMG = 'https://image.tmdb.org/t/p/';
const KIDS_RATINGS = new Set(['U', 'PG', 'G', 'TV-Y', 'TV-Y7', 'TV-Y7-FV', 'TV-G', 'TV-PG', '0', '6']);

class TmdbError extends Error {}

class Tmdb {
  constructor(key, imageDir) {
    this.key = (key || '').trim();
    this.imageDir = imageDir;
  }

  get enabled() {
    return !!this.key;
  }

  async get(pathname, params = {}) {
    const url = new URL(API + pathname);
    const headers = { accept: 'application/json' };
    if (this.key.startsWith('eyJ')) headers.authorization = 'Bearer ' + this.key;
    else url.searchParams.set('api_key', this.key);
    url.searchParams.set('language', 'en-GB');
    for (const [k, v] of Object.entries(params)) if (v != null && v !== '') url.searchParams.set(k, String(v));

    for (let attempt = 0; attempt < 3; attempt++) {
      let res;
      try {
        res = await fetch(url, { headers });
      } catch (e) {
        if (attempt === 2) throw new TmdbError('Could not reach TMDB. Check your internet connection.');
        await new Promise((r) => setTimeout(r, 800));
        continue;
      }
      if (res.status === 429) {
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
      if (res.status === 401) throw new TmdbError('TMDB rejected the API key. Check it in Settings.');
      if (res.status === 404) return null;
      if (!res.ok) throw new TmdbError('TMDB error ' + res.status);
      return res.json();
    }
    throw new TmdbError('TMDB is busy. Try again in a minute.');
  }

  async validate() {
    await this.get('/configuration');
    return true;
  }

  // With a year and no results, searches again without it (unless opts.exact).
  async searchFilm(title, year, opts = {}) {
    let data = await this.get('/search/movie', { query: title, year: year || undefined });
    if ((!data || !data.results.length) && year && !opts.exact) data = await this.get('/search/movie', { query: title });
    return data ? data.results : [];
  }

  async searchSeries(title, year, opts = {}) {
    let data = await this.get('/search/tv', { query: title, first_air_date_year: year || undefined });
    if ((!data || !data.results.length) && year && !opts.exact) data = await this.get('/search/tv', { query: title });
    return data ? data.results : [];
  }

  // A film's length, or a series' usual episode length, in minutes (null if TMDB doesn't say).
  // Remembered while Couchbox runs, so matching asks once per title.
  runtimeOf(kind, id) {
    this.runtimes = this.runtimes || new Map();
    const key = kind + ':' + id;
    if (!this.runtimes.has(key)) {
      this.runtimes.set(key, (async () => {
        const d = await this.get((kind === 'tv' ? '/tv/' : '/movie/') + id);
        if (!d) return null;
        if (kind !== 'tv') return d.runtime || null;
        // A series: its usual episode length, or else the middle one of season 1's episodes
        // (never the last episode: a finale is often double length).
        const middle = (xs) => {
          const v = xs.filter((x) => x > 0).sort((a, b) => a - b);
          return v.length ? v[Math.floor(v.length / 2)] : null;
        };
        const usual = middle(d.episode_run_time || []);
        if (usual) return usual;
        const first = (d.seasons || []).some((s) => s.season_number === 1) ? 1 : ((d.seasons || [])[0] || {}).season_number;
        if (first == null) return null;
        const s = await this.get(`/tv/${id}/season/${first}`);
        return middle(((s && s.episodes) || []).map((e) => e.runtime || 0));
      })().catch(() => null));
    }
    return this.runtimes.get(key);
  }

  async filmDetails(id) {
    const d = await this.get('/movie/' + id, { append_to_response: 'release_dates' });
    if (!d) return null;
    let cert = '';
    const rd = (d.release_dates && d.release_dates.results) || [];
    for (const region of ['GB', 'US']) {
      const r = rd.find((x) => x.iso_3166_1 === region);
      const c = r && r.release_dates.map((x) => x.certification).find((x) => x);
      if (c) { cert = c; break; }
    }
    return {
      tmdbId: d.id,
      title: d.title,
      year: parseInt((d.release_date || '').slice(0, 4), 10) || null,
      overview: d.overview || '',
      tagline: d.tagline || '',
      genres: (d.genres || []).map((g) => g.name),
      rating: d.vote_average ? Math.round(d.vote_average * 10) / 10 : null,
      runtime: d.runtime || null,
      certification: cert,
      kidsSafe: KIDS_RATINGS.has(cert),
      poster: await this.image(d.poster_path, 'w500'),
      backdrop: await this.image(d.backdrop_path, 'w1280'),
    };
  }

  async seriesDetails(id) {
    const d = await this.get('/tv/' + id, { append_to_response: 'content_ratings' });
    if (!d) return null;
    let cert = '';
    const cr = (d.content_ratings && d.content_ratings.results) || [];
    for (const region of ['GB', 'US']) {
      const r = cr.find((x) => x.iso_3166_1 === region);
      if (r && r.rating) { cert = r.rating; break; }
    }
    return {
      tmdbId: d.id,
      title: d.name,
      year: parseInt((d.first_air_date || '').slice(0, 4), 10) || null,
      overview: d.overview || '',
      tagline: d.tagline || '',
      genres: (d.genres || []).map((g) => g.name),
      rating: d.vote_average ? Math.round(d.vote_average * 10) / 10 : null,
      certification: cert,
      kidsSafe: KIDS_RATINGS.has(cert) || (d.genres || []).some((g) => g.name === 'Kids'),
      poster: await this.image(d.poster_path, 'w500'),
      backdrop: await this.image(d.backdrop_path, 'w1280'),
      seasonNames: Object.fromEntries((d.seasons || []).map((s) => [s.season_number, s.name])),
    };
  }

  async season(id, n) {
    const d = await this.get(`/tv/${id}/season/${n}`);
    if (!d) return {};
    const out = {};
    for (const e of d.episodes || []) {
      out[e.episode_number] = {
        title: e.name,
        overview: e.overview || '',
        runtime: e.runtime || null,
        still: await this.image(e.still_path, 'w300'),
      };
    }
    return out;
  }

  async image(p, size) {
    if (!p) return null;
    const out = path.join(this.imageDir, size + '_' + path.basename(p));
    if (fs.existsSync(out)) return out;
    try {
      const res = await fetch(IMG + size + p);
      if (!res.ok) return null;
      fs.mkdirSync(this.imageDir, { recursive: true });
      fs.writeFileSync(out, Buffer.from(await res.arrayBuffer()));
      return out;
    } catch (_) {
      return null;
    }
  }
}

module.exports = { Tmdb, TmdbError };
