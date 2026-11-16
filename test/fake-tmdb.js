// Test-only stand-in for TMDB: replaces fetch with canned answers so the poster
// pipeline can be exercised without a real API key. Never loaded by the app itself.
const fs = require('fs');
const path = require('path');

const imgDir = process.env.COUCHBOX_FAKE_IMAGES;
const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });
const idOf = (s) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 100000, 7);
const calls = [];

const films = {
  'night train': { year: 2019, poster: 'poster1', backdrop: 'backdrop1', cert: '15', genres: ['Thriller', 'Mystery'], overview: 'A night porter on a sleeper train finds a passenger who boarded but never got off.' },
  fernhill: { year: 2018, poster: 'poster3', backdrop: 'backdrop2', cert: 'PG', genres: ['Family', 'Drama'], overview: 'Two siblings spend one last summer on their grandmother\'s farm before it is sold.' },
  'paper moons': { year: 2021, poster: 'poster2', backdrop: 'backdrop2', cert: '12A', genres: ['Drama', 'Romance'], overview: 'A set designer and a stage magician fall out of love one show at a time.' },
  // Only used by test/finder-check.js (a film that isn't in the sample library yet).
  'harbour lights': { year: 2020, poster: 'poster3', backdrop: 'backdrop1', cert: '12A', genres: ['Drama'], overview: 'A lighthouse keeper\'s daughter comes home to a town that has moved on without her.' },
  // Only used by test/rematch-check.js: the wrong answer TMDB gives for "melody time" (a short).
  "let's sing an old time song": { year: 1947, runtime: 9, poster: 'poster2', backdrop: 'backdrop1', cert: 'U', genres: ['Animation'], overview: 'A sing-along short.' },
};
// Searches that come back with a different title (like TMDB's loose matches).
const aliases = { 'melody time': "let's sing an old time song" };
const shows = {
  'the long coast': { year: 2022, poster: 'poster2', backdrop: 'backdrop1', cert: '15', genres: ['Drama', 'Mystery'], overview: 'A fishing town keeps a secret for forty years, until a storm washes it ashore.' },
};

globalThis.fetch = async (input) => {
  const u = new URL(String(input));
  calls.push(u.pathname + u.search);
  if (u.hostname === 'image.tmdb.org') {
    const name = path.basename(u.pathname, '.jpg');
    const file = path.join(imgDir, name + '.jpg');
    return new Response(fs.readFileSync(fs.existsSync(file) ? file : path.join(imgDir, 'still1.jpg')), { status: 200 });
  }
  const p = u.pathname.replace(/^\/3/, '');
  const q = (u.searchParams.get('query') || '').toLowerCase();
  if (p === '/configuration') return json({ images: {} });
  if (p === '/search/movie') {
    const name = films[q] ? q : aliases[q];
    const f = films[name];
    return json({ results: f ? [{ id: idOf(name), title: name.replace(/\b\w/g, (c) => c.toUpperCase()), release_date: f.year + '-05-01', popularity: 20, overview: f.overview, poster_path: '/' + f.poster + '.jpg' }] : [] });
  }
  if (p === '/search/tv') {
    const s = shows[q];
    return json({ results: s ? [{ id: idOf(q), name: q.replace(/\b\w/g, (c) => c.toUpperCase()), first_air_date: s.year + '-01-10', popularity: 30, overview: s.overview, poster_path: '/' + s.poster + '.jpg' }] : [] });
  }
  let m;
  if ((m = p.match(/^\/movie\/(\d+)$/))) {
    const name = Object.keys(films).find((k) => idOf(k) === Number(m[1]));
    const f = films[name];
    return json({
      id: Number(m[1]), title: name.replace(/\b\w/g, (c) => c.toUpperCase()), release_date: f.year + '-05-01', overview: f.overview, tagline: '',
      genres: f.genres.map((g, i) => ({ id: i, name: g })), vote_average: 7.4, runtime: f.runtime || null, poster_path: '/' + f.poster + '.jpg', backdrop_path: '/' + f.backdrop + '.jpg',
      release_dates: { results: [{ iso_3166_1: 'GB', release_dates: [{ certification: f.cert }] }] },
    });
  }
  if ((m = p.match(/^\/tv\/(\d+)$/))) {
    const name = Object.keys(shows).find((k) => idOf(k) === Number(m[1]));
    const s = shows[name];
    return json({
      id: Number(m[1]), name: name.replace(/\b\w/g, (c) => c.toUpperCase()), first_air_date: s.year + '-01-10', overview: s.overview,
      genres: s.genres.map((g, i) => ({ id: i, name: g })), vote_average: 8.1, poster_path: '/' + s.poster + '.jpg', backdrop_path: '/' + s.backdrop + '.jpg',
      seasons: [{ season_number: 1, name: 'Season 1' }, { season_number: 2, name: 'Season 2' }],
      episode_run_time: [], // like many shows on TMDB: no usual length given...
      last_episode_to_air: { runtime: 96 }, // ...and a double-length finale

      content_ratings: { results: [{ iso_3166_1: 'GB', rating: s.cert }] },
    });
  }
  if ((m = p.match(/^\/tv\/(\d+)\/season\/(\d+)$/))) {
    const n = Number(m[2]);
    const names = n === 1 ? ['Pilot', 'The Harbour Master', 'Salt'] : ['Low Water', 'Undertow'];
    return json({ episodes: names.map((t, i) => ({ episode_number: i + 1, name: t, overview: `Episode ${i + 1} of season ${n}. The town gathers on the quay as the boats come back in.`, runtime: 48, still_path: '/still1.jpg' })) });
  }
  return new Response('{}', { status: 404 });
};

module.exports = { calls };
