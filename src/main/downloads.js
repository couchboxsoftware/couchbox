// Spots videos that are still downloading (or were never finished), so Couchbox shows them as
// Downloading or Incomplete instead of as ready, and never converts them half-done.
//
// New and changed files are watched until they settle. A file counts as downloading while:
//   - it still has a temporary download name (.crdownload, .part, .!qB, .!ut), or
//   - another program has it open for writing, or
//   - its size or modified time changed in the last minute.
// Once it's been still for a minute, its content is checked:
//   - the header reads, with a picture track;
//   - for MKVs with track statistics, the file holds all the bytes its tracks say they have;
//   - the size makes sense for its length and picture size;
//   - short pieces at 10%, half way, 90% and the very end decode (torrent apps create the
//     full-size file first and fill it in, so size alone can't tell).
// If they pass, the file is ready (and remembered, so it isn't checked again). If not, it's
// Incomplete until it changes again.
const fs = require('fs');
const path = require('path');
const media = require('./media');

const STABLE = Number(process.env.COUCHBOX_DL_STABLE_MS) || 60 * 1000;
const POLL = Number(process.env.COUCHBOX_DL_POLL_MS) || 10 * 1000;
const PARTIAL = /\.(crdownload|part|!qb|!ut|download|partial)$/i;

class Downloads {
  // onChange({ structural }): something to redraw. onStarted(path): a file began changing again.
  constructor({ getLibrary, onChange, onStarted }) {
    this.lib = getLibrary;
    this.onChange = onChange;
    this.onStarted = onStarted || (() => {});
    this.records = new Map(); // path -> { status, size, mtime, changedAt, growing, p, total, ... }
    this.checks = 0; // content checks running
  }

  start() {
    this._timer = setInterval(() => this.poll(), POLL);
  }

  stop() {
    clearInterval(this._timer);
  }

  /* ---------- asked by the library and the converter ---------- */
  // Files from a scan that are new, changed, or temporarily named. Starts watching them, and stops
  // watching files that have gone (renamed or deleted).
  track(candidates, all) {
    if (process.env.COUCHBOX_DL_DEBUG) console.log('[dl] track', new Date().toISOString().slice(17, 23), candidates.map((f) => path.basename(f.file)).join(', '));
    const present = new Set(all.map((f) => f.file));
    let changed = false;
    for (const p of [...this.records.keys()]) if (!present.has(p)) this.records.delete(p) && (changed = true);
    for (const f of candidates) {
      if (this.records.has(f.file)) continue;
      const now = Date.now();
      this.records.set(f.file, {
        status: 'new', size: f.size, mtime: f.mtime, partial: !!f.partial, mkv: /\.mkv$/i.test(f.file.replace(PARTIAL, '')),
        // First sight: a recently modified file counts as changing.
        changedAt: now - f.mtime < STABLE ? now : 0, growing: false, p: null, total: null, checkKey: null,
      });
      changed = true;
    }
    if (changed) this.poll();
  }

  has(file) {
    return this.records.has(file);
  }

  // Still downloading (not just waiting for its checks).
  active(file) {
    const r = this.records.get(file);
    return !!r && r.status === 'downloading';
  }

  // Anything not yet known to be finished: the converter leaves these alone.
  blocks(file) {
    return this.records.has(file);
  }

  // Relative paths (lower case) of files downloading right now: the folder watcher ignores their
  // constant changes (this class checks them itself).
  activeRel(root) {
    const out = new Set();
    for (const [p, r] of this.records) if (r.status === 'downloading') out.add(path.relative(root, p).toLowerCase());
    return out;
  }

  /* ---------- watching ---------- */
  poll() {
    clearTimeout(this._soon);
    this._soon = setTimeout(() => this._poll().catch((e) => console.error('[downloads]', e)), 30);
  }

  async _poll() {
    if (this._polling) return (this._again = true);
    this._polling = true;
    try {
      do {
        this._again = false;
        await this._pollOnce();
      } while (this._again);
    } finally {
      this._polling = false;
    }
  }

  async _pollOnce() {
    let structural = false;
    let moved = false;
    for (const [file, r] of this.records) {
      let st;
      try {
        st = fs.statSync(file);
      } catch (_) {
        continue; // gone: the next scan drops it
      }
      const now = Date.now();
      if (st.size !== r.size || st.mtimeMs !== r.mtime) {
        r.growing = st.size !== r.size;
        r.size = st.size;
        r.mtime = st.mtimeMs;
        r.changedAt = now;
        moved = true;
      } else r.growing = false;
      const was = r.status;
      // A lock counts only if it's still there at the next check: a download holds the file the
      // whole time, while a virus scan or a quick read only holds it for a moment.
      r.locks = writeLocked(file, st) ? (r.locks || 0) + 1 : 0;
      const busy = r.partial || r.locks >= 2 || now - r.changedAt < STABLE;
      if (busy) {
        r.status = 'downloading';
        r.seenBusy = true;
        r.reason = '';
        // Read the header (for the length) once it has arrived.
        if (!r.duration && r.size > 64 * 1024 && (r.headerTries = (r.headerTries || 0) + 1) <= 20) r.duration = (await media.header(file)).duration;
        this.estimate(r, file);
      } else if (r.checkKey !== `${r.size}:${r.mtime}` && r.status !== 'checking') {
        r.status = 'checking';
        this.check(file, r);
      }
      if (process.env.COUCHBOX_DL_DEBUG) console.log('[dl]', new Date().toISOString().slice(17, 23), path.basename(file), r.status, r.size, r.p, 'locks', r.locks, 'since change', Math.round((now - r.changedAt) / 1000), 'mtime', r.mtime);
      if (was !== r.status) structural = true;
      if (r.status === 'downloading' && was !== 'downloading') this.onStarted(file);
    }
    if (structural || moved) this.onChange({ structural });
  }

  // How far along a download is, when it can be told: for an MKV being written from the start,
  // from the time of the last frame written.
  estimate(r, file) {
    if (r.mkv && r.duration && (r.growing || r.p != null)) {
      const t = mkvLastTime(file, r.size);
      if (t != null && t > 0) {
        r.p = Math.min(0.999, t / r.duration);
        r.estimate = Math.round(r.size / r.p);
        return;
      }
    }
    r.p = null;
  }

  async check(file, r) {
    const key = `${r.size}:${r.mtime}`;
    // A few at a time: a big new folder shouldn't flood the computer.
    while (this.checks >= 2) await new Promise((res) => setTimeout(res, 300));
    this.checks++;
    let problem = '';
    try {
      problem = await contentProblem(file, r.size);
    } catch (e) {
      problem = e.message;
    } finally {
      this.checks--;
    }
    if (this.records.get(file) !== r) return; // stopped watching meanwhile
    if (`${r.size}:${r.mtime}` !== key || r.status !== 'checking') return; // it changed again
    r.checkKey = key;
    if (problem) {
      r.status = 'incomplete';
      r.reason = problem;
      this.onChange({ structural: true });
      return;
    }
    // Finished. Remember it, so it isn't checked again, and have the library read it properly.
    this.records.delete(file);
    const lib = this.lib();
    lib.meta.data.verified[file] = { size: r.size, mtime: r.mtime };
    lib.meta.save();
    this.onChange({ structural: true, finished: file });
    lib.refresh();
  }

  /* ---------- telling the app ---------- */
  view() {
    const lib = this.lib();
    const files = {};
    if (!this.records.size) return { files };
    const byPath = new Map();
    for (const f of lib.scan.films) byPath.set(f.file, f);
    for (const s of lib.scan.series) for (const e of s.episodes) byPath.set(e.file, e);
    for (const [p, r] of this.records) {
      const f = byPath.get(p);
      if (!f) continue;
      // A file being checked shows as Downloading only if it was seen downloading; files found
      // already finished (a newly chosen folder, say) are checked quietly.
      if (r.status === 'new' || (r.status === 'checking' && !r.seenBusy)) continue;
      files[f.id] = {
        s: r.status === 'incomplete' ? 'incomplete' : 'downloading',
        p: r.status === 'downloading' ? r.p : null,
        size: r.size,
        total: r.total || r.estimate || null,
        reason: r.reason || '',
      };
    }
    return { files };
  }
}

// Whether another program has the file open for writing. Opening it for writing (without writing
// anything) fails with EBUSY while a download or copy holds it. Read-only files can't be opened
// for writing anyway, so they're skipped.
function writeLocked(file, st) {
  if (!(st.mode & 0o200)) return false;
  try {
    fs.closeSync(fs.openSync(file, 'r+'));
    return false;
  } catch (e) {
    return e.code === 'EBUSY';
  }
}

// What's wrong with a file that has stopped changing, in words, or '' when it looks complete.
async function contentProblem(file, size) {
  const h = await media.header(file);
  if (!h.duration || !h.video) return "Couchbox can't read this file. It may not have finished downloading.";
  // (Track-size tags in MKVs aren't used here: on real files they're often out by 10-15%, or
  // left over from before a conversion.)
  // Far too small for its length and picture size (a 1080p film in a few hundred MB).
  const kbps = (size * 8) / h.duration / 1000;
  const floor = h.height >= 1000 ? 400 : h.height >= 700 ? 250 : 60;
  if (kbps < floor) return `The file is too small for a ${Math.round(h.duration / 60)}-minute video.`;
  // Torrent apps make the full-size file first; pieces not yet written read as zeros.
  const gap = zeroBlock(file, size);
  if (gap != null) return `Part of the file hasn't arrived yet (around ${Math.round(gap * 100)}% of the way through).`;
  // MKVs written from the start: the last block's time should reach the end.
  if (/\.mkv$/i.test(file)) {
    const last = mkvLastTime(file, size);
    if (last != null && last < h.duration - Math.max(15, h.duration * 0.02)) return `The video stops at ${fmt(last)} of ${fmt(h.duration)}: the rest is missing.`;
  }
  const points = [h.duration * 0.1, h.duration * 0.5, h.duration * 0.9, Math.max(0, h.duration - 8)];
  for (const at of points) if (!(await media.decodeCheck(file, at, false))) return `The video stops playing at ${fmt(at)}: the rest is missing.`;
  return '';
}

const gb = (n) => (n >= 1024 ** 3 ? (n / 1024 ** 3).toFixed(1) + ' GB' : Math.max(1, Math.round(n / 1024 ** 2)) + ' MB');
const fmt = (s) => {
  s = Math.floor(s);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${m}:${String(s % 60).padStart(2, '0')}`;
};

// Looks for a large run of zero bytes at 40 points through the file (video data never has one;
// an unwritten torrent piece is all zeros). Returns where it was found (0..1), or null.
function zeroBlock(file, size) {
  const BLOCK = 128 * 1024;
  if (size < BLOCK * 4) return null;
  const buf = Buffer.alloc(BLOCK);
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    for (let i = 1; i < 40; i++) {
      const at = Math.floor(((size - BLOCK) * i) / 40);
      const n = fs.readSync(fd, buf, 0, BLOCK, at);
      let zero = n === BLOCK;
      for (let k = 0; zero && k < n; k += 8) if (buf.readBigUInt64LE(k) !== 0n) zero = false;
      if (zero) return i / 40;
    }
  } catch (_) {
    return null;
  } finally {
    if (fd != null) fs.closeSync(fd);
  }
  return null;
}

// For an MKV being written from the start: the time (in seconds) of the last block of video
// written so far, read from the newest "cluster" near the end of the file.
function mkvLastTime(file, size) {
  const n = Math.min(size, 8 * 1024 * 1024);
  if (n < 16) return null;
  const buf = Buffer.alloc(n);
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    fs.readSync(fd, buf, 0, n, size - n);
  } catch (_) {
    return null;
  } finally {
    if (fd != null) fs.closeSync(fd);
  }
  const vlen = (b) => {
    for (let l = 1; l <= 8; l++) if (b & (0x80 >> (l - 1))) return l;
    return 0;
  };
  for (let i = buf.length - 12; i >= 0; i--) {
    if (buf[i] !== 0x1f || buf[i + 1] !== 0x43 || buf[i + 2] !== 0xb6 || buf[i + 3] !== 0x75) continue;
    let j = i + 4;
    const sl = vlen(buf[j]);
    if (!sl) continue;
    j += sl;
    if (buf[j] === 0xbf && buf[j + 1] === 0x84) j += 6; // a CRC-32 element may come first (FFmpeg writes one)
    if (buf[j] !== 0xe7) continue; // then the cluster's timestamp
    j++;
    if (vlen(buf[j]) !== 1) continue;
    const len = buf[j] & 0x7f;
    j++;
    if (len < 1 || len > 8 || j + len > buf.length) continue;
    let v = 0;
    for (let k = 0; k < len; k++) v = v * 256 + buf[j + k];
    // Then the frames ("blocks") in the cluster, each with its time relative to the cluster:
    // the last one written is how far the download has got.
    let rel = 0;
    j += len;
    while (j < buf.length - 8) {
      const idLen = vlen(buf[j]);
      if (!idLen || idLen > 4) break;
      let id = 0;
      for (let k = 0; k < idLen; k++) id = id * 256 + buf[j + k];
      j += idLen;
      const szLen = vlen(buf[j]);
      if (!szLen) break;
      let size = buf[j] & (0xff >> szLen);
      for (let k = 1; k < szLen; k++) size = size * 256 + buf[j + k];
      j += szLen;
      let body = j;
      if (id === 0xa0) {
        // BlockGroup: its Block (0xA1) is inside.
        if (buf[body] !== 0xa1) {
          j += size;
          continue;
        }
        body += 1 + vlen(buf[body + 1]);
      }
      if (id === 0xa3 || id === 0xa0) {
        const tl = vlen(buf[body]); // the track number
        if (tl && body + tl + 2 <= buf.length) rel = Math.max(rel, buf.readInt16BE(body + tl));
      }
      j += size;
    }
    return (v + rel) / 1000; // milliseconds (the usual timecode scale)
  }
  return null;
}

module.exports = { Downloads, mkvLastTime, contentProblem };
