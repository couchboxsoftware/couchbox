// Your own collections: made by hand, mixing films, whole series, single seasons and single
// episodes. Each belongs to the profile that made it, which can share it with everyone, with
// everyone except kids, or not at all; only its maker can change it (checked here, not just on
// screen). Stored in couchbox-data.json as `collections`.
//
// An item is { kind: 'film' | 'series' | 'season' | 'episode', id, season? } (a season's id is
// its show's). Items follow their titles when ids change (Fix match tidying, conversions, merged
// season folders: main.js calls migrate). Items whose files are gone stay stored and are simply
// not shown, so they come back if the file does.
const crypto = require('crypto');

const SHARE = new Set(['none', 'all', 'grownups']);
const ORDER = new Set(['manual', 'release', 'az']);
const KINDS = new Set(['film', 'series', 'season', 'episode']);
const keyOf = (it) => `${it.kind}:${it.id}${it.kind === 'season' ? ':' + it.season : ''}`;

function create({ store }) {
  const all = () => (store.data.collections = store.data.collections || []);
  const profile = (pid) => (store.data.profiles || []).find((p) => p.id === pid);
  const find = (id) => all().find((c) => c.id === id);
  const canSee = (c, pid) => {
    if (c.owner === pid) return true;
    const p = profile(pid);
    if (!p) return false;
    return c.share === 'all' || (c.share === 'grownups' && !p.kids);
  };
  // The collections a profile sees, newest first, with who made them.
  const view = (pid) =>
    all()
      .filter((c) => canSee(c, pid))
      .sort((a, b) => b.created - a.created)
      .map((c) => ({ ...c, mine: c.owner === pid, ownerName: (profile(c.owner) || {}).name || '' }));

  // Runs a change on a collection the profile owns; returns the new view or { error }.
  const edit = (pid, id, fn) => {
    const c = find(id);
    if (!c) return { error: 'That collection no longer exists.' };
    if (c.owner !== pid) return { error: 'Only the profile that made a collection can change it.' };
    const err = fn(c);
    if (err) return { error: err };
    store.save();
    return { collections: view(pid) };
  };
  const cleanItem = (it) => {
    if (!it || !KINDS.has(it.kind) || typeof it.id !== 'string') return null;
    const out = { kind: it.kind, id: it.id };
    if (it.kind === 'season') {
      if (!Number.isInteger(it.season)) return null;
      out.season = it.season;
    }
    return out;
  };

  return {
    keyOf,
    view,

    create(pid, name) {
      if (!profile(pid)) return { error: 'Pick a profile first.' };
      name = String(name || '').trim().slice(0, 60);
      if (!name) return { error: 'Give the collection a name.' };
      const c = { id: 'col-' + crypto.randomBytes(6).toString('hex'), name, owner: pid, share: 'none', order: 'manual', items: [], created: Date.now() };
      all().push(c);
      store.save();
      return { collections: view(pid), id: c.id };
    },

    // changes: { name?, share?, order? }
    update(pid, id, changes = {}) {
      return edit(pid, id, (c) => {
        if (changes.name != null) {
          const n = String(changes.name).trim().slice(0, 60);
          if (!n) return 'Give the collection a name.';
          c.name = n;
        }
        if (changes.share != null) {
          if (!SHARE.has(changes.share)) return 'Unknown sharing choice.';
          c.share = changes.share;
        }
        if (changes.order != null) {
          if (!ORDER.has(changes.order)) return 'Unknown order.';
          c.order = changes.order;
        }
      });
    },

    remove(pid, id) {
      const c = find(id);
      if (!c) return { collections: view(pid) };
      if (c.owner !== pid) return { error: 'Only the profile that made a collection can delete it.' };
      store.data.collections = all().filter((x) => x.id !== id);
      store.save();
      return { collections: view(pid) };
    },

    addItem(pid, id, item) {
      const it = cleanItem(item);
      if (!it) return { error: "That can't go in a collection." };
      return edit(pid, id, (c) => {
        if (!c.items.some((x) => keyOf(x) === keyOf(it))) c.items.push(it);
      });
    },

    removeItem(pid, id, key) {
      return edit(pid, id, (c) => {
        c.items = c.items.filter((x) => keyOf(x) !== key);
      });
    },

    // Moves an item to a new place (your own order).
    moveItem(pid, id, key, to) {
      return edit(pid, id, (c) => {
        const from = c.items.findIndex((x) => keyOf(x) === key);
        if (from < 0) return null;
        const [it] = c.items.splice(from, 1);
        c.items.splice(Math.max(0, Math.min(c.items.length, Number(to) || 0)), 0, it);
      });
    },

    // Ids that changed: map { oldId: newId }. Duplicates that this creates are merged.
    migrate(map) {
      let changed = false;
      for (const c of all()) {
        const seen = new Set();
        const next = [];
        for (const it of c.items) {
          if (map[it.id]) {
            it.id = map[it.id];
            changed = true;
          }
          const k = keyOf(it);
          if (seen.has(k)) {
            changed = true;
            continue;
          }
          seen.add(k);
          next.push(it);
        }
        c.items = next;
      }
      return changed;
    },

    // A deleted profile's collections go with it.
    removeProfiles(keepIds) {
      const before = all().length;
      store.data.collections = all().filter((c) => keepIds.has(c.owner));
      return store.data.collections.length !== before;
    },
  };
}

module.exports = { create, keyOf };
