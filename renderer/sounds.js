/* Couchbox sounds, generated with the Web Audio API (no audio files):
   - organ: the splash "picture palace" organ with a soft choir in a hall echo
   - bloom: the warm chord when the main window appears
   - tap:   the quiet click for buttons, tabs, cards and toggles
   Used by splash.html and the main window. Works with an OfflineAudioContext too, so
   tools can render the sounds to a file. */
const Sounds = (() => {
  let live = null;
  const irCache = new WeakMap();
  const played = []; // names of sounds played, for the tests

  const liveCtx = () => live || (live = new (window.AudioContext || window.webkitAudioContext)());

  function env(g, t, a, peak, hold, rel) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + a);
    g.gain.setValueAtTime(peak, t + a + hold);
    g.gain.exponentialRampToValueAtTime(0.0001, t + a + hold + rel);
  }

  // A big, soft hall: a stereo impulse of decaying noise, mixed with the dry sound.
  function hall(c, out) {
    let ir = irCache.get(c);
    if (!ir) {
      const len = Math.floor(c.sampleRate * 3.2);
      ir = c.createBuffer(2, len, c.sampleRate);
      for (let ch = 0; ch < 2; ch++) {
        const d = ir.getChannelData(ch);
        for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3.2);
      }
      irCache.set(c, ir);
    }
    const conv = c.createConvolver();
    conv.buffer = ir;
    const wet = c.createGain();
    wet.gain.value = 0.55;
    const dry = c.createGain();
    dry.gain.value = 0.7;
    const bus = c.createGain();
    bus.connect(conv).connect(wet).connect(out);
    bus.connect(dry).connect(out);
    return bus;
  }

  function tone(c, out, f, t, a, hold, rel, peak, type = 'sine', vib) {
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.frequency.value = f;
    if (vib) vib.connect(o.frequency);
    env(g, t, a, peak, hold, rel);
    o.connect(g).connect(out);
    o.start(t);
    o.stop(t + a + hold + rel + 0.1);
    return o;
  }

  function lfo(c, t, rate, depth, dur) {
    const o = c.createOscillator();
    const g = c.createGain();
    o.frequency.value = rate;
    g.gain.value = depth;
    o.connect(g);
    o.start(t);
    o.stop(t + dur);
    return g;
  }

  const DRAWBARS = [[1, 1], [2, 0.5], [3, 0.22], [4, 0.16], [6, 0.06], [8, 0.04]];
  function organ(c, out, notes, t, a, hold, rel, vol, vib) {
    const v = lfo(c, t, 5.8, vib, a + hold + rel + 0.2);
    for (const f of notes) for (const [h, w] of DRAWBARS) tone(c, out, f * h, t, a, hold, rel, vol * w, 'sine', v);
  }

  // A soft "aah": detuned saw waves through three vowel formants.
  function choir(c, out, notes, t, a, hold, rel, vol) {
    notes.forEach((f, i) => {
      const g = c.createGain();
      env(g, t, a, vol, hold, rel);
      for (const [ff, gg, q] of [[730, 1, 8], [1090, 0.5, 9], [2440, 0.25, 10]]) {
        const bp = c.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = ff;
        bp.Q.value = q;
        const gn = c.createGain();
        gn.gain.value = gg;
        bp.connect(gn).connect(g);
        for (const det of [-6, 0, 6]) {
          const o = c.createOscillator();
          o.type = 'sawtooth';
          o.frequency.value = f;
          o.detune.value = det + (i % 2 ? 3 : -3);
          o.connect(bp);
          o.start(t);
          o.stop(t + a + hold + rel + 0.1);
        }
      }
      g.connect(out);
    });
  }

  const SOUNDS = {
    // Q6 "Picture palace": warm theatre organ with its wobble, a soft choir, a big hall. ~3.5 s.
    organ(c, out, t) {
      const h = hall(c, out);
      const G3 = 196, B3 = 246.95, D4 = 293.66, G4 = 392, B4 = 493.88, D5 = 587.33;
      organ(c, h, [G3, B3, D4, G4], t, 0.5, 1.4, 1.5, 0.06, 3);
      choir(c, h, [B4, D5], t + 0.5, 0.9, 1.0, 1.5, 0.03);
    },
    // B "Warm bloom": a cosy chord that swells open and fades. ~2 s.
    bloom(c, out, t) {
      const f = c.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.setValueAtTime(300, t);
      f.frequency.exponentialRampToValueAtTime(3200, t + 0.9);
      f.connect(out);
      [261.6, 329.6, 392, 493.9, 130.8].forEach((n, i) => {
        const o = c.createOscillator();
        const g = c.createGain();
        o.type = i === 4 ? 'sine' : 'triangle';
        o.frequency.value = n;
        const s = t + i * 0.03;
        g.gain.setValueAtTime(0.0001, s);
        g.gain.exponentialRampToValueAtTime(i === 4 ? 0.18 : 0.09, s + 0.45);
        g.gain.exponentialRampToValueAtTime(0.0001, s + 2.05);
        o.connect(g).connect(f);
        o.start(s);
        o.stop(s + 2.2);
      });
    },
    // 1 "Soft tap": a tiny clean blip.
    tap(c, out, t) {
      const o = c.createOscillator();
      const g = c.createGain();
      o.type = 'sine';
      o.frequency.value = 1400;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.18, t + 0.002);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.037);
      o.connect(g).connect(out);
      o.start(t);
      o.stop(t + 0.06);
    },
  };

  // volume: 0..1 (the Settings slider). opts.ctx / opts.dest / opts.at let tools render offline.
  function play(name, volume, opts = {}) {
    if (!SOUNDS[name] || !(volume > 0)) return;
    const c = opts.ctx || liveCtx();
    if (c.state === 'suspended' && c.resume) c.resume().catch(() => {});
    const master = c.createGain();
    master.gain.value = Math.min(1, volume) * 1.2;
    master.connect(opts.dest || c.destination);
    SOUNDS[name](c, master, (opts.at != null ? opts.at : c.currentTime) + 0.02);
    played.push(name);
  }

  return { play, played };
})();
