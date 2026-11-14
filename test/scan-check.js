// Quick check of the folder scanner: node test/scan-check.js <library folder>
const { scanLibrary, episodeInfo, parseTitleYear } = require('../src/main/scanner');

const r = scanLibrary(process.argv[2]);
console.log('Films:', r.films.map((f) => `${f.title} (${f.year}) subs=${f.subs.length}`));
for (const s of r.series) console.log('Series:', s.title, '->', s.episodes.map((e) => `S${e.season}E${e.episode} ${e.fileTitle} subs=${e.subs.length}`));

const names = [
  'The.Office.US.S02E03.720p.HDTV.x264.mkv',
  'Show 1x05 Title.avi',
  'Blade.Runner.2049.2017.2160p.mkv',
  '2001 A Space Odyssey (1968).mp4',
  'Alien[1979]Directors Cut.mp4',
  'Some Film.mp4',
];
for (const n of names) console.log(n, '=>', JSON.stringify(episodeInfo(n) || parseTitleYear(n.replace(/\.\w+$/, ''))));
