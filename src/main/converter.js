// Automatic conversion: videos Couchbox can't play are converted in place, in the background.
//
// - Each scan already reads every file's formats (library.js). A file that won't play is "fast"
//   when its video plays and only the audio (or the container) needs changing, and "slow" when
//   the video itself has to be re-encoded.
// - The queue goes in the order titles were added (a series from its first episode to its last),
//   with "Queue next" titles first. Up to 5 fast and 1 slow run at once, also while you watch.
// - The new file is written next to the original as "<name>.converting.<ext>" and checked (it
//   opens, the length matches, the start, middle and end decode). Only then does the original
//   move to the hidden ".couchbox-bin" folder in the video folder and the new file take its place.
// - A binned original is deleted once its new copy has been watched to 90% (any profile) or after
//   7 days. Until then it can be restored ("Restore and retry" or "Restore and skip").
// - Each conversion needs the file's size plus a third free on the drive. If one doesn't fit,
//   nothing new starts (running ones finish) until there's space again; a warning shows meanwhile.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const media = require('./media');
const { JsonStore } = require('./store');

const MAX = { fast: 5, slow: 1 };
const BIN = '.couchbox-bin';
const BIN_DAYS = 7;
const WATCHED = 0.9;
const SPACE_FACTOR = 4 / 3; // the file plus a third
const DAY = 864e5;
const MP4_FAMILY = new Set(['.mp4', '.m4v', '.mov']);
const MP4_AUDIO = new Set(['aac', 'mp3', 'alac', 'opus', 'flac']);

const gb = (n) => (n >= 1024 ** 3 ? (n / 1024 ** 3).toFixed(1) + ' GB' : Math.max(1, Math.round(n / 1024 ** 2)) + ' MB');

class Converter {
  // getLibrary: () => Library. getProgress: () => { profileId: { fileId: {t, d} } }.
  // migrate(oldId, newId): moves progress, My list and kids settings to a file's new id.
  // onWarning(id, warning|null). send(channel, payload). enabled(): the Settings switch.
  constructor({ dataDir, getLibrary, getProgress, migrate, onWarning, send, enabled }) {
    this.lib = getLibrary;
    this.getProgress = getProgress;
    this.migrate = migrate;
    this.onWarning = onWarning;
    this.send = send;
    this.enabled = enabled;
    this.dataDir = dataDir;
    this.state = new JsonStore(path.join(dataDir, 'conversions.json'), {
      paused: false,
      front: [], // "Queue next": file or title ids, most recent first
      failed: {}, // path -> { size, mtime, label, reason }
      skipped: {}, // path -> { label, at }
      forced: {}, // path -> true: the player couldn't play it, so convert it anyway (full conversion)
      bin: [], // { orig, binPath, newPath, oldId, newId, label, size, binnedAt }
      temps: [], // conversions in progress, deleted at start-up if the app closed mid-way
      renamed: {}, // oldId -> newId for the last few finished conversions (the player follows them)
    });
    const st = this.state.data;
    for (const k of ['front', 'bin', 'temps']) if (!Array.isArray(st[k])) st[k] = [];
    for (const k of ['failed', 'skipped', 'forced', 'renamed']) if (!st[k] || typeof st[k] !== 'object') st[k] = {};
    this.running = new Map(); // fileId -> { lane, p, started, cancel, file, temp, label, duration }
    this.swapWait = new Map(); // fileId -> job waiting for the player to let go of the original
    this.playing = null; // the file id the player has open
    this.blocked = null; // { fileId, label, need, free }
    this._snapTimer = null;
    this._progTimer = null;
    this._progress = {};
    this.speed = { fast: 0, slow: 0 }; // video seconds converted per second, last seen
  }

  /* ---------- start-up ---------- */
  start() {
    const st = this.state.data;
    // Conversions that were running when Couchbox closed start again from the beginning.
    for (const t of st.temps) fs.rmSync(t, { force: true });
    st.temps = [];
    // Copies made by the old "Convert now" button live in the app's data folder. They're no
    // longer used: those videos are converted in place like everything else.
    if (!st.oldCopiesCleared) {
      fs.rmSync(path.join(this.dataDir, 'converted'), { recursive: true, force: true });
      for (const info of Object.values(this.lib().meta.data.files)) delete info.converted;
      this.lib().meta.save();
      st.oldCopiesCleared = true;
    }
    this.state.save();
    this.checkBin();
    this._binTimer = setInterval(() => this.checkBin(), 60 * 60 * 1000);
    const every = Number(process.env.COUCHBOX_SPACE_RECHECK_MS) || 3 * 60 * 1000;
    this._spaceTimer = setInterval(() => this.blocked && this.pump(), every);
  }

  stopAll() {
    for (const j of this.running.values()) j.cancel();
    clearInterval(this._binTimer);
    clearInterval(this._spaceTimer);
  }

  /* ---------- what needs converting, in order ---------- */
  root() {
    return this.lib().root;
  }

  lane(f) {
    // Still downloading, unfinished, or not checked yet: leave it alone (see downloads.js).
    if (f.partial || (this.lib().downloads && this.lib().downloads.blocks(f.file))) return null;
    const info = this.lib().meta.data.files[f.file];
    if (!info || !info.duration || !info.videoCodec) return null; // unreadable: nothing to do
    if (this.state.data.forced[f.file]) return 'slow';
    if (info.playable) return null;
    return media.PLAY_VIDEO.has(info.videoCodec) ? 'fast' : 'slow';
  }

  // Every file that won't play, in queue order, with what's happening to it.
  jobs() {
    const lib = this.lib();
    if (!lib.root) return [];
    const st = this.state.data;
    const units = [];
    for (const f of lib.scan.films) units.push({ id: f.id, at: f.added, files: [f] });
    for (const s of lib.scan.series) units.push({ id: s.id, at: Math.min(...s.episodes.map((e) => e.added)), files: s.episodes });
    units.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
    const all = [];
    for (const u of units)
      for (const f of u.files) {
        const lane = this.lane(f);
        if (!lane) continue;
        let s = 'waiting';
        const fail = st.failed[f.file];
        if (this.running.has(f.id)) s = 'converting';
        else if (this.swapWait.has(f.id)) s = 'finishing';
        else if (fail && fail.size === f.size && fail.mtime === f.mtime) s = 'failed';
        else if (st.skipped[f.file]) s = 'skipped';
        all.push({ f, id: f.id, unit: u.id, lane, s });
      }
    // "Queue next": the most recent first. A key is a file id or a title id (all its episodes).
    const out = [];
    const seen = new Set();
    const take = (j) => !seen.has(j.id) && seen.add(j.id) && out.push(j);
    for (const key of st.front) for (const j of all) if (j.id === key || j.unit === key) take(j);
    all.forEach(take);
    return out;
  }

  /* ---------- running the queue ---------- */
  pump() {
    clearTimeout(this._pumpTimer);
    this._pumpTimer = setTimeout(async () => {
      // One pass at a time (a pass waits on the free-space check); a request meanwhile runs one more.
      if (this._pumping) return (this._pumpAgain = true);
      this._pumping = true;
      try {
        do {
          this._pumpAgain = false;
          await this._pump();
        } while (this._pumpAgain);
      } catch (e) {
        console.error('[converter]', e);
      }
      this._pumping = false;
    }, 50);
  }

  async _pump() {
    const lib = this.lib();
    if (!this.enabled() || this.state.data.paused || !lib.root) {
      this.setBlocked(null);
      return this.snapshot();
    }
    const jobs = this.jobs();
    const count = (lane) => [...this.running.values()].filter((j) => j.lane === lane).length;
    // The next waiting file decides: if it doesn't fit, nothing new starts (even smaller ones).
    for (const lane of ['fast', 'slow']) {
      while (count(lane) < MAX[lane]) {
        const next = jobs.find((j) => j.lane === lane && j.s === 'waiting');
        if (!next) break;
        const free = await this.freeSpace();
        const need = Math.ceil(next.f.size * SPACE_FACTOR);
        if (free != null && free < need) {
          this.setBlocked({ fileId: next.id, label: lib.labelFor(next.f), need, free });
          return this.snapshot();
        }
        next.s = 'converting';
        this.begin(next);
      }
    }
    this.setBlocked(null);
    this.snapshot();
  }

  async freeSpace() {
    // Tests put a pretend free-space figure (in bytes) in this file.
    if (process.env.COUCHBOX_FAKE_FREE_FILE) {
      try {
        return Number(fs.readFileSync(process.env.COUCHBOX_FAKE_FREE_FILE, 'utf8'));
      } catch (_) {}
    }
    try {
      const s = await fs.promises.statfs(this.root());
      return s.bavail * s.bsize;
    } catch (_) {
      return null; // can't tell: don't hold anything up
    }
  }

  setBlocked(b) {
    const was = this.blocked;
    this.blocked = b;
    if (!b) {
      if (was) this.onWarning('space', null);
      return;
    }
    if (was && was.fileId === b.fileId && Math.abs(was.free - b.free) < 50 * 1024 ** 2) return;
    this.onWarning('space', {
      tab: 'playback',
      section: 'conversions',
      title: 'Conversions are stopped',
      text: `Not enough space for ${b.label}. It needs ${gb(b.need)} free (the file plus a third) and the drive has ${gb(b.free)}. They start again by themselves once there's room.`,
      action: this.state.data.bin.length ? { act: 'conv-empty-bin', label: 'Empty the bin' } : null,
    });
  }

  // Works out the FFmpeg command for one file.
  async plan(f, lane) {
    const src = await media.streams(f.file);
    const ext = path.extname(f.file).toLowerCase();
    const audio = src.streams.filter((s) => s.type === 'audio');
    const subs = src.streams.filter((s) => s.type === 'subtitle');
    const attach = src.streams.some((s) => s.type === 'attachment');
    const audioBad = audio.some((a) => !media.PLAY_AUDIO.has(a.codec));
    // Keep the container (and so the name) when the player can use it; otherwise MP4, or MKV
    // when there are subtitles or attachments MP4 can't hold, so nothing is lost.
    let out = ext;
    if (!media.PLAY_CONTAINERS.has(ext) || (ext === '.webm' && (audioBad || lane === 'slow'))) {
      out = subs.length || attach ? '.mkv' : '.mp4';
    }
    if (MP4_FAMILY.has(out) && (attach || subs.some((s) => s.codec !== 'mov_text'))) out = '.mkv';
    const mp4 = MP4_FAMILY.has(out);
    const dir = path.dirname(f.file);
    const base = path.basename(f.file, path.extname(f.file));
    const temp = path.join(dir, base + '.converting' + out);

    const args = ['-hide_banner', '-nostdin', '-y'];
    // Tests: read at this fraction of real time, so conversions last long enough to watch.
    if (process.env.COUCHBOX_CONV_RATE) args.push('-readrate', process.env.COUCHBOX_CONV_RATE);
    args.push('-i', f.file);
    if (mp4) args.push('-map', '0:v:0', '-map', '0:a?', ...(subs.length ? ['-map', '0:s?'] : []));
    else args.push('-map', lane === 'slow' ? '0:v:0' : '0:v', '-map', '0:a?', '-map', '0:s?', '-map', '0:t?');
    args.push('-c', 'copy');
    if (lane === 'slow') args.push('-c:v:0', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p');
    else if (mp4 && src.streams.find((s) => s.type === 'video')?.codec === 'hevc') args.push('-tag:v', 'hvc1');
    audio.forEach((a, i) => {
      const ok = mp4 ? MP4_AUDIO.has(a.codec) && media.PLAY_AUDIO.has(a.codec) : media.PLAY_AUDIO.has(a.codec);
      if (ok) return;
      // Surround stays surround (5.1 at most); stereo and mono stay as they are.
      const ch = Math.min(6, a.channels || 2);
      args.push(`-c:a:${i}`, 'aac', `-b:a:${i}`, ch > 2 ? '384k' : '192k', `-ac:a:${i}`, String(ch));
    });
    if (mp4) args.push('-movflags', '+faststart');
    args.push('-max_muxing_queue_size', '9999', temp);
    return { args, temp, out, duration: src.duration, audioCount: audio.length };
  }

  async begin(j) {
    const lib = this.lib();
    const f = j.f;
    const label = lib.labelFor(f);
    const job = { lane: j.lane, p: 0, started: Date.now(), cancel: () => {}, file: f.file, label, temp: null, duration: 0, f };
    this.running.set(f.id, job);
    this.snapshot();
    try {
      const plan = await this.plan(f, j.lane);
      job.temp = plan.temp;
      job.duration = plan.duration;
      this.state.data.temps.push(plan.temp);
      this.state.save();
      const run = media.convertRun(plan.args, plan.duration, (p) => {
        job.p = p;
        this.progress(f.id, p);
      });
      job.cancel = run.cancel;
      if (job.cancelled) run.cancel();
      const r = await run.promise;
      if (r.killed || job.cancelled) return this.dropTemp(job);
      if (!r.ok) return this.fail(job, "FFmpeg couldn't convert it: " + (r.error || 'unknown error'));
      job.p = 1;
      const bad = await this.verify(plan.temp, plan);
      if (bad) return this.fail(job, bad);
      this.speed[j.lane] = plan.duration / Math.max(1, (Date.now() - job.started) / 1000);
      job.plan = plan;
      this.swapWait.set(f.id, job);
      this.trySwap(f.id);
    } catch (e) {
      this.fail(job, e.message);
    } finally {
      this.running.delete(f.id);
      this.pump();
    }
  }

  // Checks a finished conversion. Returns a problem in words, or '' when it's good.
  async verify(file, plan) {
    // Tests: pretend the check failed for matching files, to exercise "Couldn't convert".
    if (process.env.COUCHBOX_TEST_FAIL_VERIFY && file.includes(process.env.COUCHBOX_TEST_FAIL_VERIFY)) return 'Test: the check was made to fail.';
    const info = await media.streams(file);
    if (!info.duration || !info.streams.some((s) => s.type === 'video')) return "The converted file doesn't open.";
    const slack = Math.max(2, plan.duration * 0.005);
    if (Math.abs(info.duration - plan.duration) > slack)
      return `The converted file is ${Math.round(info.duration)} s long, but the original is ${Math.round(plan.duration)} s.`;
    if (info.streams.filter((s) => s.type === 'audio').length !== plan.audioCount) return 'The converted file lost a sound track.';
    for (const at of [0, plan.duration / 2, Math.max(0, plan.duration - 6)])
      if (!(await media.decodeCheck(file, at))) return `Part of the converted file doesn't play (at ${Math.round(at)} s).`;
    return '';
  }

  dropTemp(job) {
    if (job.temp) fs.rmSync(job.temp, { force: true });
    this.state.data.temps = this.state.data.temps.filter((t) => t !== job.temp);
    this.state.save();
  }

  fail(job, reason) {
    this.dropTemp(job);
    const f = job.f;
    this.state.data.failed[f.file] = { size: f.size, mtime: f.mtime, label: job.label, reason };
    delete this.state.data.forced[f.file];
    this.state.save();
    console.error('[converter] failed', f.file, reason);
    this.snapshot();
  }

  // Swaps the checked file in. Waits while the player has the original open.
  trySwap(fileId) {
    const job = this.swapWait.get(fileId);
    if (!job) return;
    if (this.playing === fileId) return this.snapshot();
    const lib = this.lib();
    const root = lib.root;
    const f = job.f;
    // The original changed while it was converting (it was still downloading): throw the
    // conversion away. It's queued again once the file is finished.
    let now;
    try {
      now = fs.statSync(f.file);
    } catch (_) {
      now = null;
    }
    if (!now || now.size !== f.size || now.mtimeMs !== f.mtime) {
      this.swapWait.delete(fileId);
      this.dropTemp(job);
      return this.pump();
    }
    const binRoot = path.join(root, BIN);
    let binPath = path.join(binRoot, path.relative(root, f.file));
    for (let n = 2; fs.existsSync(binPath); n++) binPath = path.join(path.dirname(binPath), `${path.basename(f.file, path.extname(f.file))} (${n})${path.extname(f.file)}`);
    let newPath = path.join(path.dirname(f.file), path.basename(f.file, path.extname(f.file)) + job.plan.out);
    if (newPath.toLowerCase() !== f.file.toLowerCase() && fs.existsSync(newPath))
      newPath = path.join(path.dirname(f.file), path.basename(f.file, path.extname(f.file)) + ' (converted)' + job.plan.out);
    try {
      fs.mkdirSync(path.dirname(binPath), { recursive: true });
      hide(binRoot);
      fs.renameSync(f.file, binPath);
    } catch (e) {
      // Something else has the file open. Try again in a minute; give up after an hour.
      job.tries = (job.tries || 0) + 1;
      if (job.tries > 60) {
        this.swapWait.delete(fileId);
        return this.fail(job, "Couldn't move the original: " + e.message);
      }
      clearTimeout(job.retry);
      job.retry = setTimeout(() => this.trySwap(fileId), 60 * 1000);
      return this.snapshot();
    }
    try {
      fs.renameSync(job.temp, newPath);
    } catch (e) {
      try {
        fs.renameSync(binPath, f.file);
      } catch (_) {}
      this.swapWait.delete(fileId);
      return this.fail(job, "Couldn't put the converted file in place: " + e.message);
    }
    this.swapWait.delete(fileId);
    const st = this.state.data;
    st.temps = st.temps.filter((t) => t !== job.temp);
    delete st.failed[f.file];
    delete st.forced[f.file];
    const prefix = f.id.slice(0, f.id.indexOf(':') + 1);
    const newId = prefix + path.relative(root, newPath).toLowerCase();
    st.bin.push({ orig: f.file, binPath, newPath, oldId: f.id, newId, label: job.label, size: f.size, binnedAt: Date.now() });
    if (newId !== f.id) {
      st.renamed[f.id] = newId;
      const keys = Object.keys(st.renamed);
      if (keys.length > 50) delete st.renamed[keys[0]];
      st.front = st.front.map((k) => (k === f.id ? newId : k));
      this.migrate(f.id, newId);
    }
    this.state.save();
    // Tell the library about the new file now, so it doesn't read it again or show it as new.
    const m = lib.meta.data;
    const old = m.files[f.file] || {};
    const stat = fs.statSync(newPath);
    if (newPath !== f.file) delete m.files[f.file];
    m.files[newPath] = { ...old, playable: true, videoCodec: job.lane === 'slow' ? 'h264' : old.videoCodec, audioCodec: 'aac', size: stat.size, mtime: stat.mtimeMs, duration: job.plan.duration };
    m.added[newPath] = m.added[f.file] || f.added;
    if (newPath !== f.file) delete m.added[f.file];
    lib.meta.save();
    lib.refresh();
    this.snapshot();
  }

  /* ---------- the player ---------- */
  setPlaying(fileId) {
    const was = this.playing;
    this.playing = fileId || null;
    if (was && was !== this.playing && this.swapWait.has(was)) this.trySwap(was);
  }

  /* ---------- the bin ---------- */
  checkBin() {
    const progress = this.getProgress();
    const now = Date.now();
    const keep = [];
    let removed = false;
    for (const b of this.state.data.bin) {
      const watched = Object.values(progress).some((p) => p && p[b.newId] && p[b.newId].d > 0 && p[b.newId].t / p[b.newId].d >= WATCHED);
      if ((watched || now - b.binnedAt >= BIN_DAYS * DAY) && this.deleteBinned(b)) removed = true;
      else keep.push(b);
    }
    if (!removed) return;
    this.state.data.bin = keep;
    this.state.save();
    this.pump();
  }

  // Deletes a binned original. Returns false if Windows won't let it go (it's kept for next time).
  deleteBinned(b) {
    try {
      // Downloaded videos are often marked read-only, which stops Windows deleting them.
      if (fs.existsSync(b.binPath)) fs.chmodSync(b.binPath, 0o666);
      fs.rmSync(b.binPath, { force: true });
    } catch (e) {
      console.error('[converter] could not delete', b.binPath, e.message);
      return false;
    }
    pruneEmpty(b.binPath);
    return true;
  }

  // Returns a message if some couldn't be deleted, or ''.
  emptyBin() {
    const st = this.state.data;
    st.bin = st.bin.filter((b) => !this.deleteBinned(b));
    this.state.save();
    this.pump();
    return st.bin.length ? `${st.bin.length === 1 ? 'One original' : st.bin.length + ' originals'} couldn't be deleted. Windows may still be using ${st.bin.length === 1 ? 'it' : 'them'}; Couchbox tries again later.` : '';
  }

  // Puts an original back. mode 'retry' queues it again; 'skip' leaves it as it is.
  restore(binPath, mode) {
    const st = this.state.data;
    const b = st.bin.find((x) => x.binPath === binPath);
    if (!b) return 'That original is no longer in the bin.';
    if (!fs.existsSync(b.binPath)) {
      st.bin = st.bin.filter((x) => x !== b);
      this.state.save();
      this.snapshot();
      return 'That original has already been deleted.';
    }
    try {
      if (fs.existsSync(b.newPath)) fs.rmSync(b.newPath, { force: true });
      fs.mkdirSync(path.dirname(b.orig), { recursive: true });
      fs.renameSync(b.binPath, b.orig);
    } catch (e) {
      return "Couldn't put the original back: " + e.message;
    }
    st.bin = st.bin.filter((x) => x !== b);
    if (b.newId !== b.oldId) {
      this.migrate(b.newId, b.oldId);
      delete st.renamed[b.oldId];
    }
    delete st.failed[b.orig];
    if (mode === 'skip') st.skipped[b.orig] = { label: b.label, at: Date.now() };
    else delete st.skipped[b.orig];
    const m = this.lib().meta.data;
    delete m.files[b.newPath]; // the original is read again on the next scan
    if (b.newPath !== b.orig) delete m.added[b.newPath];
    this.lib().meta.save();
    this.state.save();
    pruneEmpty(b.binPath);
    this.lib().refresh();
    this.pump();
    return '';
  }

  binDir() {
    return this.root() ? path.join(this.root(), BIN) : null;
  }

  /* ---------- buttons ---------- */
  queueNext(key) {
    const st = this.state.data;
    st.front = [key, ...st.front.filter((k) => k !== key)].slice(0, 200);
    this.state.save();
    this.pump();
  }

  retry(fileId) {
    const f = this.lib().findFile(fileId);
    if (!f) return;
    const st = this.state.data;
    delete st.failed[f.file];
    delete st.skipped[f.file];
    this.state.save();
    this.queueNext(fileId);
  }

  // The player couldn't play a file the scan thought was fine: convert it fully, next.
  force(fileId) {
    const f = this.lib().findFile(fileId);
    if (!f) return;
    this.state.data.forced[f.file] = true;
    delete this.state.data.failed[f.file];
    delete this.state.data.skipped[f.file];
    this.queueNext(fileId);
  }

  setPaused(paused) {
    this.state.data.paused = !!paused;
    this.state.save();
    if (paused) this.cancelRunning();
    this.pump();
  }

  // A file started changing (it's downloading after all): stop converting it and drop the result.
  cancelPath(file) {
    for (const j of this.running.values()) {
      if (j.file !== file) continue;
      j.cancelled = true;
      j.cancel();
    }
    for (const [id, j] of this.swapWait) {
      if (j.file !== file) continue;
      clearTimeout(j.retry);
      this.swapWait.delete(id);
      this.dropTemp(j);
    }
    this.snapshot();
  }

  // Stops what's running (the switch turned off, or Pause all). They start again from the beginning.
  cancelRunning() {
    for (const j of this.running.values()) {
      j.cancelled = true;
      j.cancel();
    }
  }

  /* ---------- telling the app ---------- */
  progress(fileId, p) {
    this._progress[fileId] = p;
    if (this._progTimer) return;
    this._progTimer = setTimeout(() => {
      this._progTimer = null;
      this.send('conv-progress', this._progress);
      this._progress = {};
    }, 700);
  }

  snapshot() {
    clearTimeout(this._snapTimer);
    this._snapTimer = setTimeout(() => this.send('conversions', this.view()), 150);
  }

  view() {
    const lib = this.lib();
    const st = this.state.data;
    const jobs = this.jobs();
    const files = {};
    const queue = [];
    const failed = [];
    const skipped = [];
    const on = !!this.enabled();
    for (const j of jobs) {
      // With the switch off nothing is waiting: the app just says the file needs converting.
      if (!on && j.s === 'waiting') continue;
      const run = this.running.get(j.id);
      const row = { id: j.id, unit: j.unit, label: lib.labelFor(j.f), lane: j.lane, s: j.s, p: run ? run.p : j.s === 'finishing' ? 1 : 0 };
      files[j.id] = { s: j.s, p: row.p, lane: j.lane };
      if (j.s === 'failed') failed.push({ ...row, reason: (st.failed[j.f.file] || {}).reason || '' });
      else if (j.s === 'skipped') skipped.push(row);
      else queue.push(row);
    }
    queue.sort((a, b) => (b.s !== 'waiting') - (a.s !== 'waiting'));
    const now = Date.now();
    const bin = st.bin.map((b) => ({ key: b.binPath, label: b.label, size: b.size, deleteAt: b.binnedAt + BIN_DAYS * DAY, newId: b.newId }));
    // A rough time left: what's left in each lane at the speed seen so far.
    let eta = null;
    for (const lane of ['fast', 'slow']) {
      const speed = this.speedOf(lane);
      if (!speed) continue;
      let secs = 0;
      for (const j of jobs) {
        if (j.lane !== lane || (j.s !== 'waiting' && j.s !== 'converting')) continue;
        const info = lib.meta.data.files[j.f.file] || {};
        const run = this.running.get(j.id);
        secs += (info.duration || 0) * (1 - (run ? run.p : 0));
      }
      const t = secs / speed / MAX[lane];
      eta = Math.max(eta || 0, t);
    }
    return {
      enabled: on,
      paused: !!st.paused,
      blocked: this.blocked ? { label: this.blocked.label, need: this.blocked.need, free: this.blocked.free } : null,
      converting: queue.filter((r) => r.s === 'converting').length,
      waiting: queue.filter((r) => r.s === 'waiting').length,
      eta: eta && isFinite(eta) ? Math.round(eta) : null,
      files,
      queue,
      failed,
      skipped,
      bin,
      binSize: st.bin.reduce((n, b) => n + (b.size || 0), 0),
      renamed: st.renamed,
      at: now,
    };
  }

  speedOf(lane) {
    const live = [...this.running.values()].filter((j) => j.lane === lane && j.p > 0.02 && j.duration);
    if (live.length) {
      const s = live.reduce((n, j) => n + (j.p * j.duration) / Math.max(1, (Date.now() - j.started) / 1000), 0) / live.length;
      if (s > 0) return s;
    }
    return this.speed[lane];
  }
}

// Removes folders left empty inside the bin above a removed file (and the bin itself, if empty).
function pruneEmpty(file) {
  const marker = path.sep + BIN;
  const i = file.toLowerCase().lastIndexOf(marker.toLowerCase() + path.sep);
  if (i < 0) return;
  const binRoot = file.slice(0, i + marker.length);
  for (let dir = path.dirname(file); dir.length >= binRoot.length; dir = path.dirname(dir)) {
    try {
      fs.rmdirSync(dir);
    } catch (_) {
      break;
    }
    if (dir === binRoot) {
      hidden.delete(dir);
      break;
    }
  }
}

// Marks the bin folder hidden in File Explorer (it still shows with "Hidden items" ticked).
const hidden = new Set();
function hide(dir) {
  if (hidden.has(dir)) return;
  hidden.add(dir);
  if (process.platform === 'win32') execFile('attrib', ['+h', dir], { windowsHide: true }, () => {});
}

module.exports = { Converter, BIN };
