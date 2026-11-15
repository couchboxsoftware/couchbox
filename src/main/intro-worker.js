// The maths for finding intros, on a worker thread so the app never freezes (see intros.js).
//
// Fingerprints (the Philips / Haitsma-Kalker method): the first 10 minutes of sound, mono at
// 11025 Hz, cut into 4096-sample frames every 1365 samples (about 0.124 s). Each frame's energy
// in 33 bands from 300 to 2000 Hz gives 32 bits: whether the difference between neighbouring
// bands went up or down since the frame before. Matching sound gives matching bits, whatever the
// volume or encoding.
//
// Matching: line two fingerprints up at every offset; frames whose bits differ in at most 6
// places match; runs of matches (allowing gaps of up to 8 frames) are pieces. Pieces at the same
// offset with breaks of up to 12 seconds between them (a line of dialogue or a different shot
// over the theme) join into one stretch, as long as at least 60% of it matches. Stretches of at
// least 10 seconds are candidates for a shared intro; len is how much of it actually matches.
const { parentPort } = require('worker_threads');
const { spawn } = require('child_process');

const RATE = 11025;
const FRAME = 4096;
const HOP = 1365;
const STEP = HOP / RATE; // seconds per fingerprint frame
const MAX_BITS = 6;
const GAP = 8;
const MIN_FRAMES = Math.ceil(10 / STEP); // 10 seconds
const MIN_PIECE = Math.ceil(2 / STEP); // pieces shorter than 2 seconds are ignored
const BRIDGE = Math.ceil(12 / STEP); // breaks of up to 12 seconds are joined over
const DENSITY = 0.6;

/* ---------- sound in ---------- */
function decode(ffmpeg, file, seconds) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-t', String(seconds), '-i', file, '-vn', '-ac', '1', '-ar', String(RATE), '-f', 's16le', '-'], { windowsHide: true });
    const chunks = [];
    p.stdout.on('data', (d) => chunks.push(d));
    p.on('error', reject);
    p.on('close', () => {
      const buf = Buffer.concat(chunks);
      resolve(new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 2)));
    });
  });
}

/* ---------- FFT (radix 2, in place) ---------- */
const N = FRAME;
const LOG = Math.log2(N);
const rev = new Uint16Array(N);
for (let i = 0; i < N; i++) {
  let r = 0;
  for (let b = 0; b < LOG; b++) r |= ((i >> b) & 1) << (LOG - 1 - b);
  rev[i] = r;
}
const cos = new Float64Array(N / 2);
const sin = new Float64Array(N / 2);
for (let i = 0; i < N / 2; i++) {
  cos[i] = Math.cos((2 * Math.PI * i) / N);
  sin[i] = -Math.sin((2 * Math.PI * i) / N);
}
const hann = new Float64Array(N);
for (let i = 0; i < N; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));

function fft(re, im) {
  for (let i = 0; i < N; i++) {
    const j = rev[i];
    if (j > i) {
      let t = re[i];
      re[i] = re[j];
      re[j] = t;
      t = im[i];
      im[i] = im[j];
      im[j] = t;
    }
  }
  for (let size = 2; size <= N; size <<= 1) {
    const half = size >> 1;
    const step = N / size;
    for (let start = 0; start < N; start += size) {
      for (let k = 0; k < half; k++) {
        const wr = cos[k * step];
        const wi = sin[k * step];
        const a = start + k;
        const b = a + half;
        const tr = re[b] * wr - im[b] * wi;
        const ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
      }
    }
  }
}

// 33 band edges, log-spaced from 300 to 2000 Hz, as FFT bins.
const edges = [];
for (let b = 0; b <= 33; b++) edges.push(Math.round((300 * Math.pow(2000 / 300, b / 33) * N) / RATE));

function fingerprint(samples) {
  const frames = Math.max(0, Math.floor((samples.length - FRAME) / HOP) + 1);
  const codes = new Uint32Array(Math.max(0, frames - 1));
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  let prev = null;
  for (let f = 0; f < frames; f++) {
    const off = f * HOP;
    for (let i = 0; i < N; i++) {
      re[i] = (samples[off + i] / 32768) * hann[i];
      im[i] = 0;
    }
    fft(re, im);
    const e = new Float64Array(33);
    for (let b = 0; b < 33; b++) {
      let s = 0;
      for (let k = edges[b]; k < edges[b + 1]; k++) s += re[k] * re[k] + im[k] * im[k];
      e[b] = s;
    }
    if (prev) {
      let code = 0;
      for (let b = 0; b < 32; b++) if (e[b] - e[b + 1] - (prev[b] - prev[b + 1]) > 0) code |= 1 << b;
      codes[f - 1] = code >>> 0;
    }
    prev = e;
  }
  return codes;
}

/* ---------- matching ---------- */
function popcount(x) {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

// Runs where A and B share sound: [{ a0, a1, b0, b1, len, bits }] (frames; best first, at most
// `keep`, at different places in A).
function matchPair(A, B, keep = 5) {
  const runs = [];
  for (let shift = -(B.length - 1); shift < A.length; shift++) {
    const i0 = Math.max(0, shift);
    const i1 = Math.min(A.length, B.length + shift);
    if (i1 - i0 < MIN_FRAMES) continue;
    let start = -1;
    let last = -1;
    let gap = 0;
    let bits = 0;
    let hits = 0;
    let cur = null; // the stretch being joined: { a0, a1, len (matching frames), bits, hits }
    const finish = () => {
      if (cur && cur.a1 - cur.a0 + 1 >= MIN_FRAMES && cur.len >= DENSITY * (cur.a1 - cur.a0 + 1)) {
        runs.push({ a0: cur.a0, a1: cur.a1, b0: cur.a0 - shift, b1: cur.a1 - shift, len: cur.len, bits: cur.bits / Math.max(1, cur.hits) });
      }
      cur = null;
    };
    const close = () => {
      if (start >= 0 && last - start + 1 >= MIN_PIECE) {
        if (cur && start - cur.a1 - 1 > BRIDGE) finish();
        if (!cur) cur = { a0: start, a1: last, len: 0, bits: 0, hits: 0 };
        cur.a1 = last;
        cur.len += last - start + 1;
        cur.bits += bits;
        cur.hits += hits;
      }
      start = -1;
      gap = 0;
      bits = 0;
      hits = 0;
    };
    for (let i = i0; i < i1; i++) {
      const d = popcount(A[i] ^ B[i - shift]);
      if (d <= MAX_BITS) {
        if (start < 0) start = i;
        last = i;
        gap = 0;
        bits += d;
        hits++;
      } else if (start >= 0 && ++gap > GAP) close();
    }
    close();
    finish();
  }
  runs.sort((x, y) => y.len - x.len || x.bits - y.bits);
  const out = [];
  for (const r of runs) {
    if (out.some((o) => r.a0 < o.a1 && o.a0 < r.a1)) continue; // overlaps a better one
    out.push(r);
    if (out.length >= keep) break;
  }
  return out;
}

// The longest stretch of the reference found in an episode: { e0, e1, r0, r1, len } or null.
function matchRef(ref, codes) {
  const best = matchPair(codes, ref, 1)[0];
  return best ? { e0: best.a0, e1: best.a1, r0: best.b0, r1: best.b1, len: best.len } : null;
}

parentPort.on('message', async (msg) => {
  try {
    if (msg.type === 'fingerprint') {
      const samples = await decode(msg.ffmpeg, msg.file, msg.seconds || 600);
      const codes = fingerprint(samples);
      parentPort.postMessage({ id: msg.id, codes, seconds: samples.length / RATE }, [codes.buffer]);
    } else if (msg.type === 'pair') {
      parentPort.postMessage({ id: msg.id, runs: matchPair(new Uint32Array(msg.a), new Uint32Array(msg.b)) });
    } else if (msg.type === 'ref') {
      parentPort.postMessage({ id: msg.id, hit: matchRef(new Uint32Array(msg.ref), new Uint32Array(msg.codes)) });
    }
  } catch (e) {
    parentPort.postMessage({ id: msg.id, error: e.message });
  }
});
