// Season-pack folders: builds a throwaway library of empty files laid out the ways people's
// downloads come, scans it, and checks each show is ONE show with the right seasons, and that
// films and shows with numbers in their names aren't affected.
// Usage: node test/season-folders-check.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { scanLibrary, stripSeason, seasonOfFolder } = require('../src/main/scanner');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'couchbox-seasons-'));
const touch = (rel) => {
  const f = path.join(root, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, '');
};
// Like the user's folder: season packs at the top level.
for (let e = 1; e <= 23; e++) touch(`Desperate.Housewives.S01.1080p.AMZN.WEBRip.DDP5.1.x265-SiGMA[rartv]/Desperate.Housewives.S01E${String(e).padStart(2, '0')}.Ep.1080p.mkv`);
for (let e = 1; e <= 24; e++) touch(`Desperate.Housewives.S02.1080p.AMZN.WEBRip.DDP5.1.x265-SiGMA[rartv]/Desperate.Housewives.S02E${String(e).padStart(2, '0')}.Ep.1080p.mkv`);
touch('Desperate.Housewives.S01.1080p.AMZN.WEBRip.DDP5.1.x265-SiGMA[rartv]/RARBG.txt');
// A later season added the tidy way joins the same show.
touch('Desperate Housewives/Season 03/S03E01 - Now You Know.mkv');
// Other common pack names.
touch('Breaking Bad S01-S03 Complete 720p/Breaking.Bad.S02E05.mkv');
touch('Breaking Bad S01-S03 Complete 720p/Breaking.Bad.S03E01.mkv');
touch('Friends - Season 2/Friends 2x05 The One with Five Steaks.mkv');
touch('Friends - Season 2/Friends 2x06 The One with the Baby on the Bus.mkv');
touch('The Office (US) Series 3/The.Office.S03E01.Gay.Witch.Hunt.mkv');
touch('Westworld Complete Series/Westworld.S04E01.mkv');
touch('Series/Lost.S05.720p.BluRay/Lost.S05E01.Because.You.Left.mkv');
// Episodes named only "E01" inside a season-pack folder: the folder gives the season.
touch('Sherlock.S02.1080p.BluRay/Sherlock.E01.A.Scandal.in.Belgravia.mkv');
touch('Sherlock.S02.1080p.BluRay/Sherlock.E02.The.Hounds.of.Baskerville.mkv');
// Must NOT change: a show with numbers in its name, and films.
touch('9-1-1.S04.WEB/9-1-1.S04E01.mkv');
touch('The 100 Season 2/The.100.S02E01.mkv');
touch('Films/Season of the Witch (2011).mkv');
touch('Seven.Seconds.2019.1080p.mkv');
touch('Films/Ocean\'s Eleven (2001)/Oceans.Eleven.2001.mkv');

const r = scanLibrary(root);
const show = (title) => r.series.find((s) => s.title === title);
const seasons = (s) => (s ? [...new Set(s.episodes.map((e) => e.season))].sort((a, b) => a - b).join(',') : 'missing');
let failed = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== '' ? '  -- ' + detail : ''}`);
};

const dh = show('Desperate Housewives');
check('Desperate Housewives is ONE show', r.series.filter((s) => /desperate/i.test(s.title)).length === 1, r.series.map((s) => s.title).join(' | '));
check('...with 48 episodes across seasons 1, 2 and 3', dh && dh.episodes.length === 48 && seasons(dh) === '1,2,3', dh && `${dh.episodes.length} eps, seasons ${seasons(dh)}`);
check('...and remembers the old split names (to carry settings over)', dh && dh.legacyIds.includes('series:desperate housewives s01') && dh.legacyIds.includes('series:desperate housewives s02'), dh && dh.legacyIds.join(', '));
check('"Breaking Bad S01-S03 Complete" -> Breaking Bad, seasons 2,3', seasons(show('Breaking Bad')) === '2,3');
check('"Friends - Season 2" -> Friends, season 2', seasons(show('Friends')) === '2');
check('"The Office (US) Series 3" -> The Office (US), season 3', seasons(show('The Office (US)')) === '3');
check('"Westworld Complete Series" -> Westworld', seasons(show('Westworld')) === '4');
check('"Series/Lost.S05.720p.BluRay" -> Lost, season 5', seasons(show('Lost')) === '5');
check('"Sherlock.S02..." with E01/E02 files -> Sherlock, season 2, 2 episodes', show('Sherlock') && seasons(show('Sherlock')) === '2' && show('Sherlock').episodes.length === 2);
check('"9-1-1.S04" keeps its name 9-1-1', seasons(show('9-1-1')) === '4');
check('"The 100 Season 2" keeps its name The 100', seasons(show('The 100')) === '2');
check('films are unchanged', ['Season of the Witch', 'Seven Seconds', 'Ocean\'s Eleven'].every((t) => r.films.some((f) => f.title === t)), r.films.map((f) => f.title).join(' | '));
check('no stray shows (exactly the 9 expected)', r.series.length === 9, r.series.map((s) => s.title).join(' | '));
for (const [input, want] of [
  ['The Complete Guide', 'The Complete Guide'],
  ['Complete Unknown', 'Complete Unknown'],
  ['Season of the Witch', 'Season of the Witch'],
  ['Mad Men Complete 720p', 'Mad Men'],
  ['Mad Men Complete', 'Mad Men'],
  ['Mad.Men.Complete.Series.1080p', 'Mad.Men'],
  ['Twin Peaks (Complete Collection)', 'Twin Peaks'],
  ['Desperate.Housewives.S01.1080p.AMZN.WEBRip.DDP5.1.x265-SiGMA[rartv]', 'Desperate.Housewives'],
]) check(`stripSeason("${input}")`, stripSeason(input) === want, JSON.stringify(stripSeason(input)));
check('seasonOfFolder: single season yes, range no', seasonOfFolder('Show.S02.720p') === 2 && seasonOfFolder('Show S01-S03') === null && seasonOfFolder('Show Season 4') === 4);

fs.rmSync(root, { recursive: true, force: true });
console.log(`\n${failed ? failed + ' failed' : 'all passed'}`);
process.exit(failed ? 1 : 0);
