// Reads CHANGELOG.md (every version and what it added) into entries for the app's What's new,
// and checks each entry follows the template. Also used by tools/release-notes.js.
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', '..', 'CHANGELOG.md');
const GROUPS = ['New', 'Improved', 'Fixed'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// [{ version, date, headline, groups: { New: [..], Improved: [..], Fixed: [..] } }], newest first.
function parse(text) {
  text = text.replace(/<!--[\s\S]*?-->/g, '').replace(/\r\n?/g, '\n');
  const entries = [];
  let cur = null;
  let group = null;
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    let m;
    if ((m = /^## (\d+\.\d+\.\d+) · (\d{1,2} [A-Z][a-z]{2} \d{4})$/.exec(line))) {
      cur = { version: m[1], date: m[2], headline: '', groups: {} };
      group = null;
      entries.push(cur);
    } else if (!cur || !line.trim()) {
      continue;
    } else if ((m = /^### (.+)$/.exec(line))) {
      group = m[1].trim();
      cur.groups[group] = cur.groups[group] || [];
    } else if ((m = /^- (.+)$/.exec(line)) && group) {
      cur.groups[group].push(m[1].trim());
    } else if (!group && !cur.headline) {
      cur.headline = line.trim();
    }
  }
  return entries;
}

function load() {
  try {
    return parse(fs.readFileSync(FILE, 'utf8'));
  } catch (_) {
    return [];
  }
}

// Problems with the file, in words ([] when it follows the template).
function problems(text) {
  const out = [];
  const entries = parse(text);
  const headers = (text.replace(/<!--[\s\S]*?-->/g, '').match(/^## .*$/gm) || []);
  if (headers.length !== entries.length) out.push('A version heading is not written as "## 1.2.3 · 15 Nov 2026".');
  let prev = null;
  for (const e of entries) {
    const at = `Version ${e.version}`;
    if (!e.headline) out.push(`${at} has no headline.`);
    else if (!/[.!?]$/.test(e.headline)) out.push(`${at}: the headline should be one sentence ending with a full stop.`);
    const [d, mon, y] = e.date.split(' ');
    if (!MONTHS.includes(mon) || +d < 1 || +d > 31 || +y < 2020) out.push(`${at} has a date that isn't like "15 Nov 2026".`);
    const names = Object.keys(e.groups);
    if (!names.length) out.push(`${at} has no New, Improved or Fixed list.`);
    for (const g of names) if (!GROUPS.includes(g)) out.push(`${at} has a group called "${g}" (use New, Improved or Fixed).`);
    const order = names.map((g) => GROUPS.indexOf(g));
    if (order.some((v, i) => i && v < order[i - 1])) out.push(`${at}: the groups should go New, Improved, Fixed.`);
    for (const g of names) {
      if (!e.groups[g].length) out.push(`${at}: the ${g} group is empty (leave it out instead).`);
      for (const item of e.groups[g]) if (!/[.!?)]$/.test(item)) out.push(`${at}: "${item.slice(0, 40)}…" should end with a full stop.`);
    }
    if (prev && compare(e.version, prev) >= 0) out.push(`${at} is out of order (newest first).`);
    prev = e.version;
  }
  return out;
}

function compare(a, b) {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

// One entry as Markdown, for the GitHub release page.
function markdown(e) {
  const parts = [e.headline, ''];
  for (const g of GROUPS) {
    if (!e.groups[g] || !e.groups[g].length) continue;
    parts.push(`### ${g}`, ...e.groups[g].map((i) => `- ${i}`), '');
  }
  return parts.join('\n').trim() + '\n';
}

module.exports = { parse, load, problems, compare, markdown, FILE, GROUPS };
