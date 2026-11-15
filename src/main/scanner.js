// Walks the library folder and works out which videos are films and which are
// series episodes, from folder layout and file names.
const fs = require('fs');
const path = require('path');

const VIDEO_EXT = new Set(['.mp4', '.m4v', '.mkv', '.webm', '.mov', '.avi', '.wmv', '.mpg', '.mpeg', '.ts', '.flv']);
const SUB_EXT = new Set(['.srt', '.vtt']);
const FILM_ROOTS = /^(films?|movies?)$/i;
const SERIES_ROOTS = /^(series|tv|tv ?shows?|shows?|box ?sets?)$/i;
const IMPORTED_ROOT = /^imported$/i;
const SEASON_DIR = /^(?:season|series|s)[ ._-]*(\d{1,3})$|^(specials?)$/i;
const EP_PATTERNS = [
  /\bS(\d{1,3})[ ._-]*E(\d{1,4})(?:-?E\d{1,4})*/i,
  /\b(\d{1,2})x(\d{2,3})\b/i,
];
const EP_ONLY = /\b(?:episode|ep|e)[ ._-]*(\d{1,4})\b/i;
// Season markers inside a show's folder name, as in downloaded "season packs":
// "Desperate.Housewives.S01.1080p...", "Breaking Bad S01-S03", "Friends - Season 2",
// "The Office Series 3", "Westworld Complete Series". Everything from the marker on is dropped
// from the show's name, so all its seasons become one show.
// "Complete" only counts when it means a full-series pack ("Complete Series", or "Complete" right
// before the quality tags / at the end), so a show called "The Complete Guide…" keeps its name.
const SEASON_MARK = /[ ._-]*(?:\bS\d{1,2}(?:[ ._-]*(?:-|to)[ ._-]*S?\d{1,2})?\b|\bSeasons?[ ._-]*\d{1,2}(?:[ ._-]*(?:-|to)[ ._-]*\d{1,2})?\b|\bSeries[ ._-]*\d{1,2}\b|\bComplete[ ._-]*(?:Series|Seasons?|Collection|Box[ ._-]*Set)\b|\bComplete\b(?=[ ._-]*(?:$|[\[(]|\d{3,4}p\b|(?:BluRay|WEB|HDTV|DVD|x26[45]|HEVC)\b))).*$/i;
const SEASON_NUM = /\bS(\d{1,2})\b|\bSeason[ ._-]*(\d{1,2})\b|\bSeries[ ._-]*(\d{1,2})\b/i;

function stripSeason(name) {
  const m = SEASON_MARK.exec(name);
  return m && m.index > 0 ? name.slice(0, m.index).replace(/[\s._\-([]+$/, '') : name;
}

// The season a pack folder holds ("Show.S02.720p" -> 2), if it names just one.
function seasonOfFolder(name) {
  if (/\bS\d{1,2}[ ._-]*(?:-|to)|Seasons?[ ._-]*\d{1,2}[ ._-]*(?:-|to)/i.test(name)) return null; // a range like S01-S03
  const m = SEASON_NUM.exec(name);
  return m ? parseInt(m[1] || m[2] || m[3], 10) : null;
}

const SKIP_DIRS =/^(\$recycle\.bin|system volume information|\.|@eadir|extras?|featurettes?|behind the scenes|trailers?)/i;
const JUNK = /\b(2160p|1080p|720p|576p|480p|4k|uhd|hdr10?|dv|x\.?264|x\.?265|h\.?264|h\.?265|hevc|avc|bluray|blu-ray|brrip|bdrip|bdremux|remux|web[ .-]?dl|webrip|web|hdtv|dvdrip|dvd|aac\d?(\.\d)?|ac3|eac3|ddp?\d?(\.\d)?|dts(-hd)?|truehd|atmos|proper|repack|extended|remastered|unrated|directors? cut|10 ?bit|8 ?bit|multi|subbed|dubbed|nf|amzn|dsnp|hmax)\b.*$/i;

function tidy(s) {
  return s
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/[._]+/g, ' ')
    .replace(JUNK, ' ')
    .replace(/\s+-\s*$/, '')
    .replace(/\(\s*\)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// "Night.Train.2019.1080p" -> { title: "Night Train", year: 2019 }
function parseTitleYear(raw) {
  const s = raw.replace(/[._]+/g, ' ');
  const re = /[\(\[]?\b((?:19|20)\d{2})\b[\)\]]?/g;
  let m, last = null;
  while ((m = re.exec(s))) if (m.index > 0) last = m;
  if (last) {
    const title = tidy(s.slice(0, last.index));
    if (title) return { title, year: parseInt(last[1], 10) };
  }
  return { title: tidy(s) || raw, year: null };
}

function walk(dir, depth, out) {
  if (depth > 8) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.test(e.name)) walk(full, depth + 1, out);
    } else if (e.isFile()) {
      const ext = path.extname(e.name).toLowerCase();
      // "<name>.converting.<ext>" is a conversion in progress (see converter.js), not a video yet.
      if (VIDEO_EXT.has(ext) && !/\bsample\b/i.test(e.name) && !/\.converting\.\w+$/i.test(e.name)) out.videos.push(full);
      else if (SUB_EXT.has(ext)) out.subs.push(full);
    }
  }
}

function subtitlesFor(file, subsByDir) {
  const dir = path.dirname(file);
  const base = path.basename(file, path.extname(file)).toLowerCase();
  const list = subsByDir.get(dir) || [];
  const all = list.length === 1 && (subsByDir.get(dir + '|videos') || 0) === 1;
  return list
    .filter((s) => all || path.basename(s).toLowerCase().startsWith(base))
    .map((s) => {
      const name = path.basename(s, path.extname(s));
      const tag = name.slice(base.length).replace(/^[ ._-]+/, '').trim();
      return { file: s, label: tag ? tag.replace(/[._]/g, ' ') : 'Subtitles' };
    });
}

function episodeInfo(fileName) {
  const stem = path.basename(fileName, path.extname(fileName));
  for (const re of EP_PATTERNS) {
    const m = stem.match(re);
    if (m) {
      const after = tidy(stem.slice(m.index + m[0].length).replace(/^[ ._-]+/, ''));
      const before = stem.slice(0, m.index);
      return { season: parseInt(m[1], 10), episode: parseInt(m[2], 10), title: after, showHint: before };
    }
  }
  const m = stem.match(EP_ONLY);
  if (m) {
    const after = tidy(stem.slice(m.index + m[0].length).replace(/^[ ._-]+/, ''));
    return { season: null, episode: parseInt(m[1], 10), title: after, showHint: stem.slice(0, m.index) };
  }
  return null;
}

function scanLibrary(root) {
  const found = { videos: [], subs: [] };
  walk(root, 0, found);

  const subsByDir = new Map();
  for (const s of found.subs) {
    const d = path.dirname(s);
    if (!subsByDir.has(d)) subsByDir.set(d, []);
    subsByDir.get(d).push(s);
  }
  const videosPerDir = new Map();
  for (const v of found.videos) {
    const d = path.dirname(v);
    videosPerDir.set(d, (videosPerDir.get(d) || 0) + 1);
  }
  for (const [d, n] of videosPerDir) subsByDir.set(d + '|videos', n);

  const films = [];
  const seriesMap = new Map();

  for (const file of found.videos) {
    const rel = path.relative(root, file);
    const parts = rel.split(path.sep);
    const dirs = parts.slice(0, -1);
    const fileName = parts[parts.length - 1];
    let stat;
    try {
      stat = fs.statSync(file);
    } catch (_) {
      continue;
    }
    const added = Math.max(stat.birthtimeMs || 0, stat.mtimeMs || 0) || Date.now();
    const subs = subtitlesFor(file, subsByDir);

    const inSeriesRoot = dirs.length > 0 && SERIES_ROOTS.test(dirs[0]);
    const inFilmRoot = dirs.length > 0 && FILM_ROOTS.test(dirs[0]);
    // Imported\ holds videos added by "Find videos" that TMDB didn't recognise. They're
    // treated as films and get their own row on the home screen.
    const inImportedRoot = dirs.length > 0 && IMPORTED_ROOT.test(dirs[0]);
    const ep = episodeInfo(fileName);
    const seasonDirIdx = dirs.findIndex((d) => SEASON_DIR.test(d));
    // A season-pack folder: "Show.S02.1080p..." (not a bare "Season 2" folder, handled above).
    const packIdx = dirs.findIndex((d, i) => i >= (inSeriesRoot ? 1 : 0) && !SEASON_DIR.test(d) && stripSeason(d) !== d);

    const isEpisode = !inFilmRoot && !inImportedRoot && (inSeriesRoot || seasonDirIdx >= 0 || (ep && /S\d|\dx\d/i.test(fileName)) || (packIdx >= 0 && !!ep));

    if (isEpisode) {
      let showName = null;
      if (seasonDirIdx > 0) showName = dirs[seasonDirIdx - 1];
      else if (inSeriesRoot && dirs.length > 1) showName = dirs[1];
      else if (!inSeriesRoot && dirs.length > 0) showName = dirs[dirs.length - 1];
      if (!showName && ep && ep.showHint) showName = ep.showHint;
      if (!showName) showName = 'Unsorted episodes';
      const legacyName = showName; // how earlier versions named it, for carrying settings over
      showName = stripSeason(showName);
      const show = parseTitleYear(showName);
      const keyOf = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() || 'unsorted';
      const showKey = keyOf(show.title);
      const legacyKey = keyOf(parseTitleYear(legacyName).title);

      let season = ep && ep.season != null ? ep.season : null;
      if (season == null && seasonDirIdx >= 0) {
        const sm = dirs[seasonDirIdx].match(SEASON_DIR);
        season = sm[2] ? 0 : parseInt(sm[1], 10);
      }
      if (season == null && packIdx >= 0) season = seasonOfFolder(dirs[packIdx]);
      if (season == null) season = 1;

      if (!seriesMap.has(showKey)) {
        seriesMap.set(showKey, {
          id: 'series:' + showKey,
          kind: 'series',
          title: show.title,
          year: show.year,
          episodes: [],
          added: 0,
          legacyIds: [], // ids older versions gave parts of this show (e.g. "...s01"), to carry settings over
        });
      }
      const s = seriesMap.get(showKey);
      s.added = Math.max(s.added, added);
      if (legacyKey !== showKey && !s.legacyIds.includes('series:' + legacyKey)) s.legacyIds.push('series:' + legacyKey);
      s.episodes.push({
        id: 'ep:' + rel.toLowerCase(),
        kind: 'episode',
        seriesId: s.id,
        season,
        episode: ep ? ep.episode : null,
        fileTitle: ep ? ep.title : tidy(path.basename(fileName, path.extname(fileName))),
        file,
        size: stat.size,
        mtime: stat.mtimeMs,
        added,
        subs,
      });
    } else {
      const parent = dirs.length ? dirs[dirs.length - 1] : null;
      const useFolder = parent && !FILM_ROOTS.test(parent) && !IMPORTED_ROOT.test(parent) && videosPerDir.get(path.dirname(file)) === 1;
      const parsed = parseTitleYear(useFolder ? parent : path.basename(fileName, path.extname(fileName)));
      films.push({
        id: 'film:' + rel.toLowerCase(),
        kind: 'film',
        title: parsed.title,
        year: parsed.year,
        file,
        size: stat.size,
        mtime: stat.mtimeMs,
        added,
        subs,
        imported: inImportedRoot,
      });
    }
  }

  const series = [...seriesMap.values()];
  for (const s of series) {
    // Episodes with no number get numbered in name order within their season.
    s.episodes.sort((a, b) => a.season - b.season || (a.episode ?? 1e9) - (b.episode ?? 1e9) || a.file.localeCompare(b.file, undefined, { numeric: true }));
    const counters = {};
    for (const e of s.episodes) {
      counters[e.season] = counters[e.season] || 0;
      if (e.episode == null) e.episode = counters[e.season] + 1;
      counters[e.season] = Math.max(counters[e.season], e.episode);
    }
  }
  return { films, series };
}

module.exports = { scanLibrary, parseTitleYear, episodeInfo, stripSeason, seasonOfFolder, VIDEO_EXT };
