// Finds a title on TMDB from what the file's name says, using the video's length too.
//
// 1. Reading the name: as the scanner reads it, plus, when the name has no other year, a year
//    at the very start followed by a separator ("1942 - Bambi" -> "Bambi", 1942). Both
//    readings are tried, so a title that is a year ("2001 - A Space Odyssey") still has a way
//    through.
// 2. Searching: with the year, then without; if nothing fits well, the part before " - ", then
//    with the last word or two dropped ("Seven Dwarves" -> TMDB's "Seven Dwarfs").
// 3. Choosing: each candidate gets points for its name (word overlap), year and length (only
//    the likeliest few are looked up for their length). Length is points, never a rule, so a
//    special edition that runs longer still matches. A candidate must reach a minimum to be
//    taken; otherwise the title stays unmatched, with the best guesses kept for Fix match.
const { parseTitleYear } = require('./scanner');

// Bump to have every automatic match checked again (Fix match picks are never touched).
const MATCHER_VERSION = 2;

/* ---------- reading the name ---------- */
function readings(raw, parsed) {
  const cur = parsed || parseTitleYear(raw);
  const out = [{ title: cur.title, year: cur.year }];
  if (!cur.year) {
    const m = /^((?:19|20)\d{2})\s*[-._]+\s*(.+)$/.exec(String(raw).replace(/_/g, ' '));
    if (m) {
      const rest = parseTitleYear(m[2]);
      if (rest.title) out.unshift({ title: rest.title, year: rest.year || parseInt(m[1], 10) });
    }
  }
  return out;
}

// Extra searches for when the first finds nothing good.
function fallbacks(title) {
  const q = [];
  const dash = title.split(/\s+-\s*|\s*-\s+/);
  if (dash.length > 1 && dash[0].trim()) q.push(dash[0].trim());
  const w = title.split(' ').filter(Boolean);
  for (let n = w.length - 1; n >= Math.max(2, w.length - 2); n--) q.push(w.slice(0, n).join(' '));
  return [...new Set(q)].filter((x) => x && x !== title);
}

/* ---------- comparing ---------- */
const ROMAN = { ii: '2', iii: '3', iv: '4', v: '5' };
const SMALL = new Set(['the', 'a', 'an', 'and', 'of', 's', 'disney', 'disneys']);
const words = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((w) => ROMAN[w] || w)
    .filter((w) => !SMALL.has(w));

// How much two names share, 0..1 (Dice over words). Words that only differ near the end
// ("dwarves" / "dwarfs") count for a little over half.
function similarity(a, b) {
  const A = words(a);
  const B = words(b);
  if (!A.length || !B.length) return 0;
  const used = new Set();
  let hit = 0;
  for (const w of A) {
    let best = 0;
    let bi = -1;
    B.forEach((v, i) => {
      if (used.has(i)) return;
      const s = w === v ? 1 : w.length > 3 && v.length > 3 && w.slice(0, 4) === v.slice(0, 4) ? 0.6 : 0;
      if (s > best) {
        best = s;
        bi = i;
      }
    });
    if (bi >= 0) {
      used.add(bi);
      hit += best;
    }
  }
  return (2 * hit) / (A.length + B.length);
}

// c: { title, original, year, runtime (minutes, or null), popularity }
function score(c, want, minutes) {
  const sim = Math.max(similarity(want.title, c.title), similarity(want.title, c.original));
  let s = 5 * sim;
  let yearDiff = null;
  if (want.year && c.year) {
    yearDiff = Math.abs(c.year - want.year);
    s += yearDiff === 0 ? 3 : yearDiff === 1 ? 2 : yearDiff === 2 ? 1 : -1;
  }
  let ratio = null;
  if (minutes && c.runtime) {
    ratio = minutes / c.runtime;
    s += ratio >= 0.88 && ratio <= 1.12 ? 2 : ratio >= 0.75 && ratio <= 1.3 ? 0.5 : -2;
  }
  s += Math.min(c.popularity || 0, 50) / 50;
  return { s, sim, yearDiff, ratio };
}

// Taken as the match when:
// - the name is (nearly) the same and the year and length don't say otherwise, or
// - the name is close and the points add up, or
// - the name partly fits and the year and length both agree ("101 Dalmatians" is TMDB's
//   "One Hundred and One Dalmatians").
const lengthFar = (r) => r.ratio != null && (r.ratio < 0.6 || r.ratio > 1.6);
const yearFar = (r) => r.yearDiff != null && r.yearDiff > 2;
// The same name, with nothing saying otherwise: ranks above titles that only share part of the
// name, even if TMDB gives those a length and not this one ("Cunk on Earth" vs "Cunk on...").
const sameName = (r) => r.sim >= 0.85 && !lengthFar(r) && !yearFar(r);

function isConfident(r) {
  const lengthFits = r.ratio != null && r.ratio >= 0.88 && r.ratio <= 1.12;
  if (sameName(r)) return true;
  if (r.sim >= 0.6 && r.s >= 6 && !lengthFar(r)) return true;
  return r.sim >= 0.25 && r.yearDiff === 0 && lengthFits;
}

/* ---------- searching ---------- */
// tmdb: a Tmdb (searchFilm / searchSeries / runtimeOf). what: { kind: 'film' | 'series', raw,
// title, year, minutes }. Returns { best, confident, guesses }: best and guesses are
// { id, kind: 'film' | 'tv', title, year, poster, overview }.
async function findMatch(tmdb, what) {
  const tv = what.kind === 'series';
  // Under a minute says nothing about what a video is (a test clip, a broken file): no length.
  what = { ...what, minutes: what.minutes >= 1 ? what.minutes : 0 };
  const pool = new Map();
  const add = (results) => {
    for (const r of (results || []).slice(0, 6)) {
      if (pool.has(r.id)) continue;
      pool.set(r.id, {
        id: r.id,
        title: r.title || r.name || '',
        original: r.original_title || r.original_name || '',
        year: parseInt((r.release_date || r.first_air_date || '').slice(0, 4), 10) || null,
        popularity: r.popularity || 0,
        poster: r.poster_path ? 'https://image.tmdb.org/t/p/w92' + r.poster_path : null,
        overview: (r.overview || '').slice(0, 160),
        runtime: undefined,
      });
    }
  };
  const rank = async (want) => {
    const list = [...pool.values()];
    list.sort((a, b) => score(b, want, 0).s - score(a, want, 0).s);
    // Lengths for the likeliest few only (each is one more request).
    if (what.minutes) {
      for (const c of list.slice(0, 4)) if (c.runtime === undefined) c.runtime = await tmdb.runtimeOf(tv ? 'tv' : 'film', c.id);
    }
    return list.map((c) => ({ c, ...score(c, want, what.minutes || 0) })).sort((a, b) => sameName(b) - sameName(a) || b.s - a.s);
  };
  // A clear winner: confident, and not a near tie with another title of the same name.
  const decided = (ranked) => {
    const [a, b] = ranked;
    if (!a || !isConfident(a)) return false;
    return !(b && b.sim >= 0.85 && a.s - b.s < 1);
  };

  let top = null;
  outer: for (const want of readings(what.raw || what.title, { title: what.title, year: what.year })) {
    for (const q of [want.title, ...fallbacks(want.title)]) {
      if (tv) {
        add(await tmdb.searchSeries(q, want.year, { exact: true }));
        if (want.year) add(await tmdb.searchSeries(q, null));
      } else {
        add(await tmdb.searchFilm(q, want.year, { exact: true }));
        if (want.year) add(await tmdb.searchFilm(q, null));
      }
      if (!pool.size) continue;
      const ranked = await rank(want);
      const ok = decided(ranked);
      if (!top || (ok && !top.ok) || (ok === top.ok && ranked[0].s > top.ranked[0].s)) top = { ranked, ok };
      if (ok) break outer;
    }
  }
  const out = (x) => ({ id: x.c.id, kind: tv ? 'tv' : 'film', title: x.c.title, year: x.c.year ? String(x.c.year) : '', poster: x.c.poster, overview: x.c.overview });
  if (!top) return { best: null, confident: false, guesses: [] };
  return {
    best: out(top.ranked[0]),
    confident: top.ok,
    guesses: top.ok ? [] : top.ranked.filter((x) => x.sim >= 0.25 || x.ratio != null).slice(0, 5).map(out),
  };
}

module.exports = { findMatch, readings, fallbacks, similarity, score, isConfident, MATCHER_VERSION };
