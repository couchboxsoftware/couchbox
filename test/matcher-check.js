// The matcher (src/main/matcher.js) against a made-up TMDB: a year at the start of the name, a
// title that is a year, remakes told apart by length, a wrong year put right by length, a
// special edition that runs longer, a weak answer turned down (with guesses kept), a clip that
// isn't the film, a near tie with nothing to tell them apart, the " - " and fewer-words
// retries, and a series by its episode length.
// Usage: node test/matcher-check.js
const { findMatch, readings } = require('../src/main/matcher');
const { parseTitleYear } = require('../src/main/scanner');

// id, title, year, runtime (minutes), popularity; `also` = searches that loosely return it.
const FILMS = [
  [1, 'Bambi', 1942, 70, 30],
  [2, '1917', 2019, 119, 40],
  [3, '2001: A Space Odyssey', 1968, 149, 35],
  [4, 'Aladdin', 1992, 90, 45],
  [5, 'Aladdin', 2019, 128, 50],
  [6, "Belle's Magical World", 1998, 69, 5],
  [7, "Let's Sing an Old Time Song", 1947, 9, 1, ['melody time']],
  [8, 'Toy Story', 1995, 81, 50],
  [9, 'Snow White and the Seven Dwarfs', 1937, 83, 40],
  [10, 'Inception', 2010, 148, 50],
  [11, 'One Hundred and One Dalmatians', 1961, 79, 40, ['101 dalmatians']],
].map(([id, title, year, runtime, popularity, also]) => ({ id, title, year, runtime, popularity, also: also || [] }));
const SHOWS = [
  { id: 50, title: 'Desperate Housewives', year: 2004, runtime: 43, popularity: 40, also: [] },
  // TMDB gives no episode length for the exact name, but does for a show sharing part of it.
  { id: 51, title: 'Cunk on Earth', year: 2022, runtime: null, popularity: 10, also: [] },
  { id: 52, title: 'Cunk on...', year: 2018, runtime: 29, popularity: 12, also: ['cunk on earth'] },
];

const low = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ');
// Like TMDB: every word searched for is in the title (or a loose alias); a year narrows it down.
const search = (list, q, year) =>
  list
    .filter((e) => (low(q).every((w) => low(e.title).includes(w)) || e.also.includes(q.toLowerCase())) && (!year || e.year === year))
    .map((e) => ({ id: e.id, title: e.title, name: e.title, release_date: e.year + '-01-01', first_air_date: e.year + '-01-01', popularity: e.popularity, overview: '' }));
let requests = 0;
const tmdb = {
  async searchFilm(q, year) { requests++; return search(FILMS, q, year); },
  async searchSeries(q, year) { requests++; return search(SHOWS, q, year); },
  async runtimeOf(kind, id) { requests++; return ((kind === 'tv' ? SHOWS : FILMS).find((e) => e.id === id) || {}).runtime || null; },
};

let failed = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== '' ? '  -- ' + detail : ''}`);
};
// As the library calls it: the name, the scanner's reading of it, and the length.
const find = (raw, minutes, kind = 'film') => {
  const p = parseTitleYear(raw);
  return findMatch(tmdb, { kind, raw, title: p.title, year: p.year, minutes });
};
const says = (r) => (r.best ? `${r.best.title} (${r.best.year})${r.confident ? '' : ' [unsure]'}` : 'nothing');

(async () => {
  let r;
  check('reading "1942 - Bambi" gives Bambi, 1942 first', JSON.stringify(readings('1942 - Bambi')[0]) === JSON.stringify({ title: 'Bambi', year: 1942 }));
  check('reading "Bambi (1942)" is unchanged', readings('Bambi (1942)').length === 1);

  r = await find('1942 - Bambi', 70);
  check('a year at the start: "1942 - Bambi" is Bambi (1942)', r.confident && r.best.id === 1, says(r));
  r = await find('1917', 119);
  check('a title that is a year: "1917" is 1917 (2019)', r.confident && r.best.id === 2, says(r));
  r = await find('2001 - A Space Odyssey', 149);
  check('"2001 - A Space Odyssey" still finds the 1968 film', r.confident && r.best.id === 3, says(r));
  r = await find('Aladdin', 90);
  check('remakes by length: a 90-minute "Aladdin" is the 1992 one', r.confident && r.best.id === 4, says(r));
  r = await find('Aladdin', 127);
  check('...and a 127-minute one is the 2019 one', r.confident && r.best.id === 5, says(r));
  r = await find('1994 - Aladdin', 88);
  check('a wrong year put right by length: "1994 - Aladdin" (88 min) is 1992', r.confident && r.best.id === 4, says(r));
  r = await find("1998 - Belle's Magical World", 88);
  check('a special edition that runs longer still matches', r.confident && r.best.id === 6, says(r));
  r = await find('1948 - Melody Time', 72);
  check('a weak answer is turned down: "Melody Time" is not a 9-minute short', !r.confident, says(r));
  check('...and kept as a guess for Fix match', r.guesses.some((g) => g.id === 7), JSON.stringify(r.guesses.map((g) => g.title)));
  r = await find('Inception', 30);
  check("a 30-minute clip isn't the 148-minute film", !r.confident, says(r));
  r = await find('Inception', 0);
  check('with no length known, the same name is enough', r.confident && r.best.id === 10, says(r));
  r = await find('Aladdin', 0);
  check('a near tie with nothing to tell them apart is left unsure', !r.confident && r.guesses.length >= 2, says(r));
  r = await find('1995 - Toy Story - Special Edition', 80);
  check('the " - " retry: "Toy Story - Special Edition" is Toy Story', r.confident && r.best.id === 8, says(r));
  r = await find('1937 - Snow White and the Seven Dwarves', 83);
  check('the fewer-words retry: "Seven Dwarves" finds "Seven Dwarfs"', r.confident && r.best.id === 9, says(r));
  r = await find('1961 - 101 Dalmatians', 76);
  check('a partial name with the same year and length: 101 Dalmatians', r.confident && r.best.id === 11, says(r));
  r = await find('Desperate Housewives', 42, 'series');
  check('a series by its episode length', r.confident && r.best.id === 50 && r.best.kind === 'tv', says(r));
  r = await find('Cunk On Earth', 29, 'series');
  check('the exact name wins over a show sharing part of it (even with no length on TMDB)', r.confident && r.best.id === 51, says(r));
  r = await find('Nothing Like This', 90);
  check('no results: nothing, no guesses', !r.best && !r.guesses.length);

  // A series' usual episode length from the real client (with the stand-in TMDB): with no usual
  // length given, the middle of season 1's episodes, not the double-length finale.
  require('./fake-tmdb');
  const { Tmdb } = require('../src/main/tmdb');
  const real = new Tmdb('test-key', '');
  const show = (await real.searchSeries('the long coast'))[0];
  const len = await real.runtimeOf('tv', show.id);
  check("a series' episode length comes from season 1, not the finale", len === 48, String(len));

  console.log(`\n${requests} stand-in requests`);
  console.log(failed ? `${failed} failed` : 'all passed');
  process.exit(failed ? 1 : 0);
})();
