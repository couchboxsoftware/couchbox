// After "Fix match": files are tidied into the Couchbox folder layout, like Find videos does.
//   films     Films\Title (Year).ext
//   episodes  Series\Show\Season 01\Show - S01E02.ext
// Subtitles with the same name go too. Nothing is ever overwritten: on a clash the match is kept
// and that file stays where it is. A file that's converting, waiting to convert or still
// downloading is moved later, once it's done. Everything attached to a file (progress, My list,
// kids setting) follows it to its new id.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { showIdOf } = require('./scanner');

const SUB_EXT = new Set(['.srt', '.vtt']);
const safeName = (s) => String(s).replace(/[<>:"/\\|?*\x00-\x1f]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '');
const pad2 = (n) => String(n).padStart(2, '0');

class Tidy {
  // migrateFile(oldId, newId): progress etc. for one file. migrateShow({ old: new }): My list,
  // kids and intro settings for titles. store: where moves waiting for a conversion are kept.
  constructor({ getLibrary, getConverter, migrateFile, migrateShow, store }) {
    this.lib = getLibrary;
    this.conv = getConverter;
    this.migrateFile = migrateFile;
    this.migrateShow = migrateShow;
    this.store = store;
    if (!Array.isArray(store.data.pendingMoves)) store.data.pendingMoves = [];
  }

  /* ---------- where things go ---------- */
  filmBase(root, title, year) {
    return path.join(root, 'Films', safeName(`${title}${year ? ` (${year})` : ''}`));
  }

  episodeBase(root, show, season, episode) {
    const s = safeName(show);
    return path.join(root, 'Series', s, `Season ${pad2(season)}`, `${s} - S${pad2(season)}E${pad2(episode)}`);
  }

  // The id a file at `file` gets from the scanner ("film:films\x (2019).mkv", "ep:series\…").
  idFor(file) {
    const rel = path.relative(this.lib().root, file);
    return (/^series[\\/]/i.test(rel) ? 'ep:' : 'film:') + rel.toLowerCase();
  }

  /* ---------- after a match ---------- */
  // item: the film or series that was matched. target: { kind: 'film' | 'tv', title, year,
  // tmdbId, season, episode }. Returns { moved, clashes: [message], later }.
  async afterMatch(item, target) {
    const lib = this.lib();
    const root = lib.root;
    const out = { moved: 0, clashes: [], later: 0 };
    if (!root) return out;
    const plan = [];
    if (item.kind === 'film' && target.kind === 'film') {
      plan.push({ f: item, base: this.filmBase(root, target.title, target.year) });
    } else if (item.kind === 'film' && target.kind === 'tv') {
      // A single file that's really an episode of a show.
      plan.push({ f: item, base: this.episodeBase(root, target.title, target.season, target.episode), toShow: true });
    } else if (item.kind === 'series') {
      for (const e of item.episodes) plan.push({ f: e, base: this.episodeBase(root, target.title, e.season, e.episode) });
    }
    // The show's new id (from its new folder), so its match, My list and kids setting follow.
    const newShowId = target.kind === 'tv' ? showIdOf(safeName(target.title)) : null;
    if (newShowId) {
      const m = lib.meta.data;
      m.overrides[newShowId] = target.tmdbId;
      if (item.kind === 'series' && item.id !== newShowId) {
        if (m.titles[item.id]) m.titles[newShowId] = m.titles[item.id];
        if (m.seasons[item.id]) m.seasons[newShowId] = m.seasons[item.id];
      }
      lib.meta.save();
      if (item.id !== newShowId) this.migrateShow({ [item.id]: newShowId });
    }
    for (const step of plan) {
      const r = await this.moveOrWait(step.f, step.base);
      if (r === 'moved') out.moved++;
      else if (r === 'later') out.later++;
      else if (r) out.clashes.push(r);
      step.result = r;
    }
    // The title's id from now on (so the app can open its page again).
    if (newShowId) out.itemId = newShowId;
    else out.itemId = plan[0].result === 'moved' ? this.idFor(plan[0].base + path.extname(item.file).toLowerCase()) : item.id;
    if (item.kind === 'film' && target.kind === 'tv') {
      // The film card is gone: its old match isn't needed.
      delete lib.meta.data.titles[item.id];
      delete lib.meta.data.overrides[item.id];
      lib.meta.save();
    }
    lib.refresh();
    return out;
  }

  // Moves now, or remembers to move once the file is free. Returns 'moved', 'later', '' (already
  // in place) or a clash message.
  async moveOrWait(f, base) {
    if (this.busy(f)) {
      const list = this.store.data.pendingMoves.filter((p) => p.fileId !== f.id);
      list.push({ fileId: f.id, base });
      this.store.data.pendingMoves = list;
      this.store.save();
      return 'later';
    }
    return this.move(f, base);
  }

  // Converting, waiting to convert, or still downloading.
  busy(f) {
    const conv = this.conv();
    const lib = this.lib();
    if (lib.downloads && lib.downloads.blocks(f.file)) return true;
    if (!conv) return false;
    if (conv.running.has(f.id) || conv.swapWait.has(f.id)) return true;
    return !!conv.enabled() && !!conv.lane(f) && !conv.state.data.skipped[f.file];
  }

  async move(f, base) {
    const lib = this.lib();
    const from = f.file;
    const to = base + path.extname(from).toLowerCase();
    if (from.toLowerCase() === to.toLowerCase()) return '';
    if (fs.existsSync(to)) return `Couldn't move ${path.basename(from)}: a file with that name is already in ${path.relative(lib.root, path.dirname(to))}.`;
    const subs = subtitlesOf(from);
    try {
      await fsp.mkdir(path.dirname(to), { recursive: true });
      await moveFile(from, to);
    } catch (e) {
      return `Couldn't move ${path.basename(from)}: ${e.message}`;
    }
    for (const s of subs) {
      const sd = base + s.suffix;
      if (!fs.existsSync(sd)) await moveFile(s.file, sd).catch(() => {});
    }
    // The library already knows this file: keep its details (no need to read it again), and its
    // "added" time, so it doesn't show as new.
    const m = lib.meta.data;
    if (m.files[from]) m.files[to] = m.files[from];
    m.added[to] = m.added[from] || f.added;
    if (m.verified[from]) m.verified[to] = m.verified[from];
    delete m.files[from];
    delete m.added[from];
    delete m.verified[from];
    lib.meta.save();
    const newId = this.idFor(to);
    if (newId !== f.id) this.migrateFile(f.id, newId);
    pruneEmpty(path.dirname(from), lib.root);
    return 'moved';
  }

  // Moves that waited for a conversion or download: done once the file is free. Called after
  // each scan.
  async runPending() {
    const st = this.store.data;
    if (!st.pendingMoves.length || this._running) return;
    this._running = true;
    try {
      const lib = this.lib();
      const conv = this.conv();
      const renamed = (conv && conv.state.data.renamed) || {};
      let moved = false;
      for (const p of [...st.pendingMoves]) {
        const f = lib.findFile(p.fileId) || lib.findFile(renamed[p.fileId]);
        if (!f) {
          st.pendingMoves = st.pendingMoves.filter((x) => x !== p);
          continue;
        }
        if (this.busy(f)) continue;
        await this.move(f, p.base);
        st.pendingMoves = st.pendingMoves.filter((x) => x !== p);
        moved = true;
      }
      this.store.save();
      if (moved) lib.refresh();
    } finally {
      this._running = false;
    }
  }
}

// A rename on the same drive; otherwise copy, check the size, then delete the original.
async function moveFile(from, to) {
  try {
    await fsp.rename(from, to);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    const tmp = to + '.part';
    await fsp.copyFile(from, tmp);
    if ((await fsp.stat(tmp)).size !== (await fsp.stat(from)).size) {
      await fsp.unlink(tmp).catch(() => {});
      throw new Error("the copy didn't match the original");
    }
    await fsp.rename(tmp, to);
    await fsp.unlink(from);
  }
}

function subtitlesOf(file) {
  const dir = path.dirname(file);
  const base = path.basename(file, path.extname(file)).toLowerCase();
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch (_) {}
  return names.filter((n) => SUB_EXT.has(path.extname(n).toLowerCase()) && n.toLowerCase().startsWith(base)).map((n) => ({ file: path.join(dir, n), suffix: n.slice(base.length) }));
}

// Removes folders left empty by a move (never the Couchbox folder or its Films, Series and
// Imported folders).
function pruneEmpty(dir, root) {
  const keep = new Set([root, ...['Films', 'Series', 'Imported'].map((d) => path.join(root, d))].map((d) => d.toLowerCase()));
  while (dir.toLowerCase().startsWith(root.toLowerCase()) && !keep.has(dir.toLowerCase())) {
    try {
      if (fs.readdirSync(dir).length) return;
      fs.rmdirSync(dir);
    } catch (_) {
      return;
    }
    dir = path.dirname(dir);
  }
}

module.exports = { Tidy, safeName };
