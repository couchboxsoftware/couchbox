// Copies and versions of the same title put in the Couchbox folder by hand (Find videos already
// checks the ones it adds). Uses the same rules as Find videos:
//   - the same title is the same TMDB film, or the same show + season + episode (by name and
//     year when TMDB hasn't matched it);
//   - the exact same file (size + three samples) is always a copy, whatever its title;
//   - same title, lengths within 30 seconds: spare copies. One card, playing the best copy
//     (highest resolution, then biggest, then a name without "copy", then the shorter name). The
//     card keeps the id of the copy that was there first, so progress, My list and kids settings
//     are shared and survive the shown copy being removed. Only the best copy is converted.
//   - same title, lengths more than 30 seconds apart: different versions. Both show; the newer
//     one is marked until you choose Replace, Keep the one I have, or Keep both as versions.
// Spare copies and undecided versions raise a warning in Settings, Library, Copies and versions.
const path = require('path');
const { JsonStore } = require('./store');
const { fingerprint, fmtLen } = require('./finder');

const SAME_LENGTH_S = 30;
const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

class Copies {
  // binFile(file, label): moves a file to the conversion bin (7 days, restorable).
  // clearResume(cardId): forgets every profile's resume point for a card (keeps "watched").
  // onWarning(id, warning|null). send(channel, payload).
  constructor({ dataDir, getLibrary, binFile, clearResume, onWarning, send }) {
    this.lib = getLibrary;
    this.binFile = binFile;
    this.clearResume = clearResume;
    this.onWarning = onWarning;
    this.send = send;
    // cards: { fileId: cardId } (kept, so a card's id never changes); decisions: { pairKey: 'keepBoth' | 'versions' }
    this.state = new JsonStore(path.join(dataDir, 'copies.json'), { cards: {}, decisions: {} });
    this.reset();
  }

  reset() {
    this.skip = new Set(); // spare copies: not shown, not converted
    this.asId = new Map(); // file path -> the card id it shows as
    this.alias = new Map(); // card id -> the file path that plays
    this.labels = new Map(); // card id -> "1h 57m" (kept as separate versions)
    this.versionOf = new Map(); // card id of a new version -> card id of the one you had
    this.spares = []; // for Settings
    this.versions = []; // for Settings and the comparison
  }

  isSpare(file) {
    return this.skip.has(file);
  }

  displayId(f) {
    return this.asId.get(f.file) || f.id;
  }

  /* ---------- working it out (after each scan) ---------- */
  async update() {
    const lib = this.lib();
    const m = lib.meta.data;
    const titles = m.titles;
    const blocked = (f) => f.partial || (lib.downloads && lib.downloads.blocks(f.file));
    const all = [];
    for (const f of lib.scan.films) {
      if (blocked(f)) continue;
      const t = titles[f.id];
      all.push({ f, kind: 'film', identity: t && t.tmdbId ? 'movie:' + t.tmdbId : 'name:' + norm(f.title) + ':' + (f.year || '') });
    }
    for (const s of lib.scan.series) {
      const t = titles[s.id];
      const show = t && t.tmdbId ? 'tv:' + t.tmdbId : 'show:' + s.id;
      for (const e of s.episodes) if (!blocked(e)) all.push({ f: e, kind: 'episode', identity: `${show}:${e.season}:${e.episode}`, show: s });
    }
    for (const x of all) {
      const info = m.files[x.f.file] || {};
      x.duration = info.duration || 0;
      x.height = info.height || 0;
      x.width = info.width || 0;
      x.size = x.f.size;
    }

    // Fingerprints (cached with the file's details) for anything that might be a copy: files
    // that share a title, and files that share an exact size.
    const byIdentity = group(all, (x) => x.identity);
    const bySize = group(all, (x) => String(x.size));
    const need = new Set();
    for (const list of [...byIdentity.values(), ...bySize.values()]) if (list.length > 1) list.forEach((x) => need.add(x));
    for (const x of need) {
      const info = m.files[x.f.file];
      if (info && info.fp && info.fpSize === x.size) x.fp = info.fp;
      else {
        try {
          x.fp = await fingerprint(x.f.file, x.size);
          if (info) Object.assign(info, { fp: x.fp, fpSize: x.size });
        } catch (_) {
          x.fp = 'x:' + x.f.file;
        }
      }
    }
    lib.meta.save();

    // Clusters: the same title within 30 seconds, plus exact copies of each other (any title).
    const parent = new Map(all.map((x) => [x, x]));
    const find = (x) => (parent.get(x) === x ? x : (parent.set(x, find(parent.get(x))), parent.get(x)));
    const join = (a, b) => parent.set(find(a), find(b));
    for (const list of byIdentity.values()) {
      if (list.length < 2) continue;
      const sorted = [...list].sort((a, b) => a.duration - b.duration);
      for (let i = 1; i < sorted.length; i++) if (Math.abs(sorted[i].duration - sorted[i - 1].duration) <= SAME_LENGTH_S && sorted[i].duration && sorted[i - 1].duration) join(sorted[i], sorted[i - 1]);
    }
    for (const list of bySize.values()) {
      const byFp = group(list.filter((x) => x.fp), (x) => x.fp);
      for (const same of byFp.values()) for (let i = 1; i < same.length; i++) join(same[i], same[0]);
    }
    const clusters = [...group(all, (x) => find(x)).values()];

    this.reset();
    const st = this.state.data;
    const clusterOf = new Map();
    for (const c of clusters) {
      c.sort((a, b) => a.f.added - b.f.added || a.f.file.localeCompare(b.f.file));
      // The card's id: one this cluster already had, or the id of the copy that was there first.
      // It's only remembered once there really are copies (or after a "Replace"), so a file
      // that was checked a moment before its twin doesn't take the card.
      const cardId = c.map((x) => st.cards[x.f.id]).find(Boolean) || c[0].f.id;
      if (c.length > 1) for (const x of c) st.cards[x.f.id] = cardId;
      c.cardId = cardId;
      c.best = pickBest(c);
      c.added = c[0].f.added;
      for (const x of c) clusterOf.set(x, c);
    }
    // A card id belongs to one cluster: if two clusters claim it (a version split off), the
    // newer one gets its own id.
    const owner = new Map();
    for (const c of [...clusters].sort((a, b) => a.added - b.added)) {
      if (owner.has(c.cardId)) {
        c.cardId = c.best.f.id;
        for (const x of c) {
          if (c.length > 1) st.cards[x.f.id] = c.cardId;
          else delete st.cards[x.f.id];
        }
      }
      owner.set(c.cardId, c);
    }
    for (const c of clusters) {
      // The best copy plays under the card's id (when that isn't its own).
      if (c.cardId !== c.best.f.id) {
        this.asId.set(c.best.f.file, c.cardId);
        this.alias.set(c.cardId, c.best.f.file);
      }
      for (const x of c) {
        if (x === c.best) continue;
        this.skip.add(x.f.file);
        const key = pairKey(c.best, x);
        if (st.decisions[key] !== 'keepBoth') this.spares.push({ key, cardId: c.cardId, ...describe(lib, x), best: describe(lib, c.best), label: lib.labelFor(c.best.f) });
      }
    }
    this.state.save();

    // Different versions: clusters with the same title but different lengths.
    const versionGroups = group(clusters, (c) => c.best.identity);
    for (const cs of versionGroups.values()) {
      if (cs.length < 2) continue;
      cs.sort((a, b) => a.added - b.added);
      const mine = cs[0];
      for (const other of cs.slice(1)) {
        const key = pairKey(mine.best, other.best);
        if (st.decisions[key] === 'versions') {
          this.labels.set(mine.cardId, fmtLen(mine.best.duration));
          this.labels.set(other.cardId, fmtLen(other.best.duration));
          continue;
        }
        this.versionOf.set(other.cardId, mine.cardId);
        this.versions.push({
          key,
          mine: { cardId: mine.cardId, ...describe(lib, mine.best) },
          theirs: { cardId: other.cardId, ...describe(lib, other.best) },
          label: lib.labelFor(mine.best.f),
        });
      }
    }
    this.clusters = clusters;
    this.announce();
  }

  announce() {
    const n = this.spares.length;
    const v = this.versions.length;
    if (!n && !v) this.onWarning('copies', null);
    else {
      const parts = [];
      if (n) parts.push(`${n === 1 ? '1 spare copy' : n + ' spare copies'} found. Couchbox is only showing the best copy of each.`);
      if (v) parts.push(`${v === 1 ? '1 title has' : v + ' titles have'} a second version with a different length: possibly a different cut.`);
      this.onWarning('copies', { tab: 'library', section: 'copies', title: 'Copies and versions to check', text: parts.join(' ') });
    }
    this.send('copies', this.view());
  }

  view() {
    return {
      spares: this.spares,
      versions: this.versions,
      versionOf: Object.fromEntries(this.versionOf),
      labels: Object.fromEntries(this.labels),
    };
  }

  /* ---------- buttons ---------- */
  // Spare copy: to the bin (7 days, restorable).
  moveSpare(file) {
    const s = this.spares.find((x) => x.path === file);
    if (!s) return 'That copy has already gone.';
    return this.binFile(file, `${s.label} (spare copy)`);
  }

  keepBoth(key) {
    this.state.data.decisions[key] = 'keepBoth';
    this.state.save();
    this.spares = this.spares.filter((s) => s.key !== key);
    this.announce();
  }

  // Versions. choice: 'replace' (the new one takes the card; the old one goes to the bin;
  // resume points are cleared), 'keepMine' (the new one goes to the bin), 'both'.
  async decideVersion(key, choice) {
    const v = this.versions.find((x) => x.key === key);
    if (!v) return 'That has already been decided.';
    const clusterOf = (cardId) => (this.clusters || []).find((c) => c.cardId === cardId);
    const mine = clusterOf(v.mine.cardId);
    const theirs = clusterOf(v.theirs.cardId);
    const st = this.state.data;
    if (choice === 'both') {
      st.decisions[key] = 'versions';
      this.state.save();
    } else if (choice === 'keepMine') {
      for (const x of theirs || []) {
        const err = this.binFile(x.f.file, `${v.label} (other version, ${fmtLen(x.duration)})`);
        if (err) return err;
      }
    } else if (choice === 'replace') {
      // The new version takes over the card (so My list, the watched tick and kids settings
      // carry over); where you'd got up to is cleared, because the timings differ.
      for (const x of theirs || []) st.cards[x.f.id] = v.mine.cardId;
      this.state.save();
      this.clearResume(v.mine.cardId);
      for (const x of mine || []) {
        const err = this.binFile(x.f.file, `${v.label} (old version, ${fmtLen(x.duration)})`);
        if (err) return err;
      }
    }
    this.lib().refresh();
    return '';
  }
}

function group(items, keyOf) {
  const out = new Map();
  for (const x of items) {
    const k = keyOf(x);
    if (!out.has(k)) out.set(k, []);
    out.get(k).push(x);
  }
  return out;
}

// Highest resolution, then biggest file, then a name without "copy", then one already filed in
// Films or Series (not Imported), then the shorter name.
function pickBest(c) {
  const copyish = (x) => (/\bcopy\b|\(\d+\)\s*$/i.test(path.basename(x.f.file, path.extname(x.f.file))) ? 1 : 0);
  const imported = (x) => (x.f.imported ? 1 : 0);
  return [...c].sort((a, b) => b.height - a.height || b.size - a.size || copyish(a) - copyish(b) || imported(a) - imported(b) || path.basename(a.f.file).length - path.basename(b.f.file).length)[0];
}

// Two files, whichever order: remembered even if the files move (it's their content).
const pairKey = (a, b) => [a.fp || a.f.file, b.fp || b.f.file].sort().join('|');

function describe(lib, x) {
  return {
    path: x.f.file,
    fileName: path.basename(x.f.file),
    folder: path.relative(lib.root, path.dirname(x.f.file)) || '.',
    duration: x.duration,
    length: fmtLen(x.duration),
    resolution: x.height ? `${x.width}×${x.height}` : '',
    size: x.size,
    added: x.f.added,
  };
}

module.exports = { Copies };
