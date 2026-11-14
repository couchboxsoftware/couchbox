// Uploads the project's source code to the main branch of the GitHub repo in package.json
// ("build.publish"), as one commit, without needing Git installed. The repo ends up holding
// exactly the files listed below, so a file deleted here is deleted there too.
//
// Usage: node tools/push-source.js "Commit message"            (needs GH_TOKEN)
//        node tools/push-source.js --dry-run                     (lists the files only)
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const pkg = require('../package.json');
const { owner, repo } = pkg.build.publish;
const branch = 'main';

// Only these go public. Build output, node_modules and design previews stay local.
const INCLUDE = ['.gitignore', 'LICENSE', 'README.md', 'package.json', 'package-lock.json', 'main.js', 'preload.js', 'dev-app-update.yml', 'build/icon.png', 'renderer', 'src', 'test', 'tools'];

function listFiles() {
  const out = [];
  const walk = (rel) => {
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) return;
    if (fs.statSync(abs).isDirectory()) for (const name of fs.readdirSync(abs).sort()) walk(path.posix.join(rel, name));
    else out.push(rel);
  };
  INCLUDE.forEach(walk);
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const files = listFiles();
  if (args.includes('--dry-run')) {
    files.forEach((f) => console.log(f));
    console.log(`${files.length} files would go to ${owner}/${repo} (${branch})`);
    return;
  }
  const message = args.find((a) => !a.startsWith('--')) || `Update source (v${pkg.version})`;
  const token = process.env.GH_TOKEN;
  if (!token) throw new Error('GH_TOKEN is not set.');

  const api = async (method, url, body) => {
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}${url}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'couchbox-push-source', 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`${method} ${url} -> ${res.status} ${(await res.text()).slice(0, 300)}`);
    return res.json();
  };

  const ref = await api('GET', `/git/ref/heads/${branch}`);
  const head = await api('GET', `/git/commits/${ref.object.sha}`);

  const tree = [];
  for (const f of files) {
    const blob = await api('POST', '/git/blobs', { content: fs.readFileSync(path.join(root, f)).toString('base64'), encoding: 'base64' });
    tree.push({ path: f, mode: '100644', type: 'blob', sha: blob.sha });
  }
  const newTree = await api('POST', '/git/trees', { tree });
  if (newTree.sha === head.tree.sha) {
    console.log('Source on GitHub is already up to date.');
    return;
  }
  const commit = await api('POST', '/git/commits', { message, tree: newTree.sha, parents: [head.sha] });
  await api('PATCH', `/git/refs/heads/${branch}`, { sha: commit.sha });
  console.log(`Pushed ${files.length} files to ${owner}/${repo} (${branch}): ${commit.html_url}`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
