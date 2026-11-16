// Profile PINs (profile lock). Grown-up profiles can have a 4-digit PIN, asked when the profile
// is picked, edited or deleted, and when Settings is opened on it. Kids profiles can't have one.
// Once any profile has a PIN, adding a profile or turning a profile's Kids setting off needs a
// grown-up's PIN (any locked profile's), so a kids profile can't get round the locks.
//
// Everything that matters happens here in the main process: a PIN is stored only as a salted
// scrypt hash (never the PIN), the screens only ever learn `locked: true`, wrong tries are
// counted here (5 in a row = a 30-second wait), and saving profiles is refused unless the
// right PIN was entered shortly before. "Forgot PIN?" proves it's the PC's owner with Windows
// Hello, or the Windows password where there's no Hello (hello.js).
const crypto = require('crypto');

const TRIES = 5;
const WAIT_MS = Number(process.env.COUCHBOX_PIN_WAIT_MS) || 30000;
const GRANT_MS = 5 * 60 * 1000; // how long an entered PIN allows editing that profile
const ANY = '*'; // "a grown-up's PIN": any locked profile's

const hashPin = (pin, salt) => crypto.scryptSync(String(pin), Buffer.from(salt, 'hex'), 32).toString('hex');
const validPin = (pin) => /^\d{4}$/.test(String(pin || ''));

function create({ store, hello }) {
  const fails = new Map(); // key -> { n, until }
  const grants = new Map(); // profile id (or ANY) -> time the PIN was entered
  const profiles = () => store.data.profiles;
  const byId = (id) => profiles().find((p) => p.id === id);
  const anyLocked = () => profiles().some((p) => p.pin);

  function matches(p, pin) {
    if (!p || !p.pin || !validPin(pin)) return false;
    const want = Buffer.from(p.pin.hash, 'hex');
    const got = Buffer.from(hashPin(pin, p.pin.salt), 'hex');
    return want.length === got.length && crypto.timingSafeEqual(want, got);
  }

  // Counts a try against `key`. Returns { ok } or { ok: false, wait: seconds } while waiting.
  function attempt(key, test) {
    const f = fails.get(key) || { n: 0, until: 0 };
    const now = Date.now();
    if (f.until > now) return { ok: false, wait: Math.ceil((f.until - now) / 1000) };
    if (test()) {
      fails.delete(key);
      grants.set(key, now);
      return { ok: true };
    }
    f.n++;
    if (f.n >= TRIES) {
      f.n = 0;
      f.until = now + WAIT_MS;
    }
    fails.set(key, f);
    return f.until > now ? { ok: false, wait: Math.ceil(WAIT_MS / 1000) } : { ok: false, left: TRIES - f.n };
  }
  const granted = (key) => grants.has(key) && Date.now() - grants.get(key) < GRANT_MS;

  // What the screens see: everything but the hash, plus locked: true.
  const publicProfiles = () =>
    profiles().map((p) => {
      const { pin, ...rest } = p;
      return { ...rest, locked: !!pin };
    });

  return {
    publicProfiles,
    anyLocked,

    check(id, pin) {
      return attempt(id, () => matches(byId(id), pin));
    },

    // A grown-up's PIN: any locked profile's. Allows adding a profile or switching Kids off.
    checkAny(pin) {
      const r = attempt(ANY, () => profiles().some((p) => matches(p, pin)));
      if (r.ok) for (const p of profiles()) if (matches(p, pin)) grants.set(p.id, Date.now());
      return r;
    },

    // Adds, changes (newPin) or removes (newPin null) a profile's PIN. A profile that has one
    // needs it (currentPin), or a "Forgot PIN?" check moments ago.
    set(id, newPin, currentPin) {
      const p = byId(id);
      if (!p) return { ok: false, error: 'That profile no longer exists.' };
      if (p.kids) return { ok: false, error: "Kids profiles can't have a PIN." };
      if (newPin != null && !validPin(newPin)) return { ok: false, error: 'A PIN is 4 numbers.' };
      if (p.pin && !granted('forgot:' + id)) {
        const r = attempt(id, () => matches(p, currentPin));
        if (!r.ok) return { ...r, error: r.wait ? `Too many tries. Try again in ${r.wait} seconds.` : 'Wrong PIN.' };
      }
      grants.delete('forgot:' + id);
      if (newPin == null) delete p.pin;
      else {
        const salt = crypto.randomBytes(16).toString('hex');
        p.pin = { salt, hash: hashPin(newPin, salt) };
      }
      grants.set(id, Date.now());
      store.save();
      return { ok: true, profiles: publicProfiles() };
    },

    // "Forgot PIN?": Windows Hello (or the Windows password) proves it's the PC's owner. For a
    // profile, its PIN is then removed; with no profile (a grown-up's PIN was asked for), it
    // just lets this one action through.
    async forgot(id, name) {
      const what = id ? `reset the PIN for ${name || 'this profile'}` : 'continue';
      const r = await hello.verify(`Couchbox: ${what}`);
      if (!r.ok) return r;
      if (!id) {
        grants.set(ANY, Date.now());
        return { ok: true };
      }
      const p = byId(id);
      if (p) delete p.pin;
      grants.set(id, Date.now());
      grants.set('forgot:' + id, Date.now());
      store.save();
      return { ok: true, profiles: publicProfiles() };
    },

    // Checks a profiles:save from the screens against what's stored. Returns the list to store
    // (with the PINs kept, as the screens never have them), or { error }.
    guardSave(next) {
      const before = new Map(profiles().map((p) => [p.id, p]));
      const strip = ({ pin, locked, ...rest }) => rest;
      const same = (a, b) => JSON.stringify(strip(a)) === JSON.stringify(strip(b));
      const locked = anyLocked();
      const grownUp = () => granted(ANY);
      for (const old of before.values()) {
        const now = next.find((p) => p.id === old.id);
        if (old.pin && !granted(old.id) && (!now || !same(old, now))) return { error: `Enter ${old.name}'s PIN to change this profile.` };
      }
      for (const p of next) {
        const old = before.get(p.id);
        if (!old && locked && !grownUp()) return { error: "Enter a grown-up's PIN to add a profile." };
        if (old && old.kids && !p.kids && locked && !grownUp() && !granted(old.id)) return { error: "Enter a grown-up's PIN to turn Kids off." };
      }
      const out = next.map((p) => {
        const old = before.get(p.id);
        const clean = strip(p);
        if (old && old.pin && !clean.kids) clean.pin = old.pin; // kids profiles lose any PIN
        return clean;
      });
      return { profiles: out };
    },

    helloKind: () => hello.kind(),
  };
}

module.exports = { create, validPin };
