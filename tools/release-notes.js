// Prints a version's release notes from CHANGELOG.md, for tools/release.ps1.
// Usage: node tools/release-notes.js <version> [--headline]
//   (no flag)   the whole entry as Markdown (the GitHub release page)
//   --headline  just the headline (the Update available banner)
// Exits with an error if the file doesn't follow the template or has no entry for the version.
const fs = require('fs');
const changelog = require('../src/main/changelog');

const [version, flag] = process.argv.slice(2);
const text = fs.readFileSync(changelog.FILE, 'utf8');
const problems = changelog.problems(text);
if (problems.length) {
  console.error('CHANGELOG.md does not follow the template:\n- ' + problems.join('\n- '));
  process.exit(2);
}
const entry = changelog.parse(text).find((e) => e.version === version);
if (!entry) {
  console.error(`CHANGELOG.md has no entry for ${version}. Add "## ${version} · <date>" with a headline and its changes first.`);
  process.exit(1);
}
process.stdout.write(flag === '--headline' ? entry.headline + '\n' : changelog.markdown(entry));
