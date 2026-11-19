// Publishes a new Couchbox version to GitHub Releases, where installed copies find it.
// (The shared release script: Endpaper's, plus Couchbox's short-folder build.)
//
//   npm run release -- 0.4.0             build, commit, tag v0.4.0, push, and release
//   npm run release -- 0.4.0 --dry-run   build only: nothing committed, pushed or published
//   node tools/release.js --notes 0.4.0 [--headline]   print a version's notes (for the checks)
//
// 1. Refuses unless CHANGELOG.md follows its template and has this version's entry at the top,
//    everything's committed, the GitHub CLI is signed in (gh auth login), and the version hasn't
//    been released. The entry is the release notes; its headline is what the update banner shows.
// 2. Sets the version in package.json and package-lock.json (a dry run leaves them alone).
// 3. Copies the project to a short folder (%TEMP%\couchbox-build) and builds there, because the
//    installer tool fails on long paths. The installer, its .blockmap and latest.yml come back
//    to dist\ (electron-updater needs all three).
// 4. Commits, tags vX.Y.Z, pushes, creates the GitHub release with the three files, and checks
//    they all arrived.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const changelog = require('../src/main/changelog');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const dry = args.includes('--dry-run');
const pkgPath = path.join(ROOT, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const version = args.find((a) => /^\d+\.\d+\.\d+$/.test(a)) || pkg.version;
const SHORT = path.join(os.tmpdir(), 'couchbox-build');

const fail = (msg, code = 1) => {
  console.error('\n✗ ' + msg + '\n');
  process.exit(code);
};

/* ---------- the notes, from CHANGELOG.md ---------- */
const text = fs.readFileSync(changelog.FILE, 'utf8');
const problems = changelog.problems(text);
if (problems.length) fail('CHANGELOG.md does not follow the template:\n- ' + problems.join('\n- '), 2);
const entries = changelog.parse(text);
const entry = entries.find((e) => e.version === version);
if (!entry) fail(`CHANGELOG.md has no entry for ${version}. Add one at the top first (the template is at the top of that file).`);
const notes = changelog.markdown(entry).trim();

// Notes only (the What's new check uses this): print them and stop.
if (args.includes('--notes')) {
  process.stdout.write(args.includes('--headline') ? entry.headline + '\n' : notes + '\n');
  process.exit(0);
}
if (entries[0].version !== version) fail(`The newest entry in CHANGELOG.md is ${entries[0].version}, not ${version}. Put the ${version} entry at the top.`);
if (!/^0\./.test(version)) fail(`${version} isn't a 0.x version. Couchbox stays on 0.x for now (installed copies on 1.x would never be offered 0.x updates).`);

/* ---------- the tools, and everything committed ---------- */
const tool = (name, fallback) => {
  for (const c of [name, fallback]) {
    try {
      execFileSync(c, ['--version'], { stdio: 'ignore' });
      return c;
    } catch {}
  }
  return null;
};
const run = (cmd, a, opts = {}) => execFileSync(cmd, a, { cwd: ROOT, stdio: 'inherit', ...opts });
const out = (cmd, a) => execFileSync(cmd, a, { cwd: ROOT, encoding: 'utf8' }).trim();
const git = tool('git', 'C:\\Program Files\\Git\\cmd\\git.exe');
const gh = tool('gh', 'C:\\Program Files\\GitHub CLI\\gh.exe');
if (!dry) {
  if (!git) fail("Git isn't installed. Install it with: winget install Git.Git");
  if (!gh) fail("The GitHub CLI isn't installed. Install it with: winget install GitHub.cli");
  try {
    execFileSync(gh, ['auth', 'status'], { stdio: 'ignore' });
  } catch {
    fail("The GitHub CLI isn't signed in. Run: gh auth login");
  }
  const status = out(git, ['status', '--porcelain']).split('\n').filter((l) => l && !/(package\.json|package-lock\.json|CHANGELOG\.md)$/.test(l));
  if (status.length) fail(`There are changes that aren't committed:\n${status.join('\n')}\nCommit them first, so the release matches the code on GitHub.`);
  try {
    execFileSync(git, ['rev-parse', '-q', '--verify', `refs/tags/v${version}`], { cwd: ROOT, stdio: 'ignore' });
    fail(`v${version} has already been released. Use a new version number.`);
  } catch (e) {
    if (e.status === undefined) throw e;
  }
}

/* ---------- the version ---------- */
function setVersion(dir) {
  const p = path.join(dir, 'package.json');
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  if (j.version !== version) {
    j.version = version;
    fs.writeFileSync(p, JSON.stringify(j, null, 2) + '\n');
  }
  const l = path.join(dir, 'package-lock.json');
  if (fs.existsSync(l)) {
    const lock = JSON.parse(fs.readFileSync(l, 'utf8'));
    if (lock.version !== version) {
      lock.version = version;
      if (lock.packages && lock.packages['']) lock.packages[''].version = version;
      fs.writeFileSync(l, JSON.stringify(lock, null, 2) + '\n');
    }
  }
}
if (!dry) {
  setVersion(ROOT);
  console.log(`Version set to ${version}.`);
}

/* ---------- build, in a short folder ---------- */
console.log(`\nBuilding Couchbox ${version} in ${SHORT}…\n`);
// robocopy mirrors the project there (node_modules included, but not git or old builds).
const rc = spawnSync('robocopy', [ROOT, SHORT, '/MIR', '/XD', path.join(ROOT, '.git'), path.join(ROOT, 'dist'), path.join(SHORT, 'dist'), '/NFL', '/NDL', '/NJH', '/NJS', '/NP'], { stdio: 'ignore' });
if (rc.status === null || rc.status >= 8) fail(`Copying the project to ${SHORT} failed (robocopy ${rc.status}).`);
if (dry) setVersion(SHORT); // a dry run only sets the version in the copy
fs.rmSync(path.join(SHORT, 'dist'), { recursive: true, force: true });
// The update banner shows just the headline (electron-builder puts this file into latest.yml).
fs.mkdirSync(path.join(SHORT, 'build'), { recursive: true });
fs.writeFileSync(path.join(SHORT, 'build', 'release-notes.md'), entry.headline + '\n');
run(process.execPath, [path.join(SHORT, 'node_modules', 'electron-builder', 'cli.js'), '--win', '--publish', 'never'], { cwd: SHORT });

const exe = `Couchbox-Setup-${version}.exe`;
const names = [exe, `${exe}.blockmap`, 'latest.yml'];
const dist = path.join(ROOT, 'dist');
fs.mkdirSync(dist, { recursive: true });
for (const n of fs.readdirSync(dist)) if (/^Couchbox[- ].*\.(exe|blockmap)$/.test(n) || n === 'latest.yml') fs.rmSync(path.join(dist, n), { force: true });
for (const n of names) {
  const from = path.join(SHORT, 'dist', n);
  if (!fs.existsSync(from)) fail(`The build didn't make ${n}.`);
  fs.copyFileSync(from, path.join(dist, n));
}
const files = names.map((n) => path.join(dist, n));
const notesFile = path.join(dist, `release-notes-${version}.md`);
fs.writeFileSync(notesFile, notes + '\n');
console.log(`\nBuilt into dist\\: ${names.join(', ')}\n\nRelease notes:\n\n${notes}\n\nUpdate banner: ${entry.headline}\n`);

if (dry) {
  console.log(`Dry run: built ${exe}. Nothing was committed, pushed or published, and package.json wasn't changed.`);
  process.exit(0);
}

/* ---------- publish ---------- */
run(git, ['add', 'package.json', 'package-lock.json', 'CHANGELOG.md']);
try {
  execFileSync(git, ['diff', '--cached', '--quiet'], { cwd: ROOT });
} catch {
  run(git, ['commit', '-m', `Release ${version}`]);
}
run(git, ['tag', '-a', `v${version}`, '-m', `Couchbox ${version}`]);
run(git, ['push', '--follow-tags']);
run(gh, ['release', 'create', `v${version}`, ...files, '--title', `Couchbox ${version}`, '--notes-file', notesFile]);
const assets = JSON.parse(out(gh, ['release', 'view', `v${version}`, '--json', 'assets'])).assets.map((a) => a.name);
const missing = names.filter((n) => !assets.includes(n));
if (missing.length) fail(`The release is missing: ${missing.join(', ')}. Upload them with: gh release upload v${version} <files>`);
console.log(`\n✓ Couchbox ${version} is released. Installed copies offer the update the next time they open (or straight away from Settings, App, Check for updates).\n`);
