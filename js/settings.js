/* Custom fields and home-screen filter choices.
 *
 * Stored on the device (localStorage) and synced to Google Drive inside
 * pottery-log-index.json under "settings". The newest save wins, like pieces.
 *
 *   { fields: [{ id, name, type, options? }],   type: text | number | date | yesno | choice
 *     filters: ['clayBody', 'cf-…', …],          fields shown as filters on the home screen
 *     glazes: ['Celadon', …],                     remembered glazes, offered in a drop-down
 *     clays: [{ name: 'B-Mix', cone: '6' }, …],   remembered clay bodies, each with its cone
 *     updatedAt: ms,
 *     sync: { root, syncedAt } }                 local bookkeeping, never uploaded
 *
 * A piece keeps its values in piece.custom = { fieldId: value }. In Drive they are
 * written by field name ("customFields": { "Kiln": "Big kiln" }) so they read naturally.
 */
(function () {
  'use strict';

  const KEY = 'potteryLog.settings';
  const TYPES = { text: 'Text', number: 'Number', date: 'Date', yesno: 'Yes / no', choice: 'Choice list' };

  // Built-in fields that can be used as home-screen filters (stage always has its chips).
  const BUILTIN_FILTERS = [
    { id: 'clayBody', name: 'Clay body' },
    { id: 'method', name: 'Forming method' },
    { id: 'glazes', name: 'Glaze' },
    { id: 'firingType', name: 'Firing type' },
    { id: 'cone', name: 'Cone' },
  ];

  const listeners = new Set();
  let cache = null;

  function load() {
    if (cache) return cache;
    let s = null;
    try { s = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { /* ignore */ }
    cache = normalize(s || {});
    return cache;
  }

  function normalize(s) {
    const fields = (Array.isArray(s.fields) ? s.fields : [])
      .filter((f) => f && f.id && f.name)
      .map((f) => ({
        id: String(f.id), name: String(f.name).trim().slice(0, 60),
        type: TYPES[f.type] ? f.type : 'text',
        ...(f.type === 'choice' ? { options: (Array.isArray(f.options) ? f.options : []).map(String).filter(Boolean) } : {}),
      }));
    const known = new Set([...BUILTIN_FILTERS.map((b) => b.id), ...fields.map((f) => f.id)]);
    const filters = (Array.isArray(s.filters) ? s.filters : []).map(String).filter((id) => known.has(id));
    const seen = new Set();
    const uniqueBy = (name) => { const k = name.toLowerCase(); if (!name || seen.has(k)) return false; seen.add(k); return true; };
    const glazes = (Array.isArray(s.glazes) ? s.glazes : []).map((g) => String(g).trim().slice(0, 120)).filter(uniqueBy);
    seen.clear();
    const clays = (Array.isArray(s.clays) ? s.clays : [])
      .map((c) => (typeof c === 'string' ? { name: c } : c || {}))
      .map((c) => ({ name: String(c.name || '').trim().slice(0, 120), cone: String(c.cone || '') }))
      .filter((c) => uniqueBy(c.name));
    return { fields, filters: [...new Set(filters)], glazes, clays, updatedAt: Number(s.updatedAt) || 0, sync: s.sync || null };
  }

  function write(s) {
    cache = s;
    try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (e) { /* ignore */ }
    listeners.forEach((fn) => fn(s));
  }

  /** Values of the custom fields, keyed by field name, for piece.json and the index. */
  function namedValues(custom) {
    const out = {};
    for (const f of load().fields) {
      const v = custom ? custom[f.id] : undefined;
      if (v === undefined || v === null || v === '') continue;
      out[f.name] = v;
    }
    return out;
  }

  /** Read "customFields" from Drive back into { fieldId: value }. Names that aren't a current
   * field (e.g. one removed on another device) are ignored. */
  function fromNamed(obj) {
    const out = {};
    if (!obj || typeof obj !== 'object') return out;
    const byName = new Map(load().fields.map((f) => [f.name.toLowerCase(), f]));
    for (const [name, raw] of Object.entries(obj)) {
      const f = byName.get(String(name).trim().toLowerCase());
      if (f) out[f.id] = coerce(f, raw);
    }
    return out;
  }

  function coerce(f, v) {
    if (f.type === 'yesno') return v === true || v === 'true' || v === 'Yes' || v === 'yes';
    if (f.type === 'number') { const n = Number(v); return v === '' || Number.isNaN(n) ? '' : n; }
    return v == null ? '' : String(v);
  }

  function slug(name) {
    return String(name).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || Math.random().toString(36).slice(2, 8);
  }

  window.Settings = {
    TYPES,
    BUILTIN_FILTERS,
    get: load,
    fields: () => load().fields,
    field: (id) => load().fields.find((f) => f.id === id),
    filters: () => load().filters,

    /** Local change by the user: bumps updatedAt so it syncs and wins over older copies. */
    update(changes) {
      write(normalize({ ...load(), ...changes, updatedAt: Date.now() }));
    },

    addField(name, type, options) {
      const s = load();
      name = String(name || '').trim().slice(0, 60);
      if (!name) throw new Error('Give the field a name');
      const lower = name.toLowerCase();
      if (s.fields.some((f) => f.name.toLowerCase() === lower) || ['title', 'stage', 'notes', 'clay body', 'glazes', 'cone', 'firing type'].includes(lower)) {
        throw new Error('There is already a field called “' + name + '”');
      }
      let id = 'cf-' + slug(name);
      while (s.fields.some((f) => f.id === id)) id += '-' + Math.random().toString(36).slice(2, 5);
      const field = { id, name, type: TYPES[type] ? type : 'text' };
      if (field.type === 'choice') {
        field.options = [...new Set((options || []).map((o) => String(o).trim()).filter(Boolean))];
        if (!field.options.length) throw new Error('Add at least one choice, separated by commas');
      }
      this.update({ fields: [...s.fields, field] });
      return field;
    },

    removeField(id) {
      const s = load();
      this.update({ fields: s.fields.filter((f) => f.id !== id), filters: s.filters.filter((x) => x !== id) });
    },

    /** Display text for a value. */
    format(f, v) {
      if (v === undefined || v === null || v === '') return '';
      if (f.type === 'yesno') return v ? 'Yes' : 'No';
      return String(v);
    },

    namedValues,
    fromNamed,
    coerce,

    // ----- remembered glazes and clays -----
    glazes: () => load().glazes,
    clays: () => load().clays,
    clay: (name) => load().clays.find((c) => c.name.toLowerCase() === String(name).toLowerCase()),

    /** Remember names used on a piece. Only saves (and syncs) when something is new.
     * quiet: keep updatedAt, so a newer copy from Drive still wins (used when seeding). */
    learn({ glazes = [], clays = [] }, { quiet = false } = {}) {
      const s = load();
      const g = [...s.glazes]; const c = [...s.clays];
      const hasG = new Set(g.map((x) => x.toLowerCase())); const hasC = new Set(c.map((x) => x.name.toLowerCase()));
      for (const name of glazes) if (name && !hasG.has(name.toLowerCase())) { g.push(name); hasG.add(name.toLowerCase()); }
      for (const x of clays) {
        const item = typeof x === 'string' ? { name: x, cone: '' } : x;
        if (item.name && !hasC.has(item.name.toLowerCase())) { c.push(item); hasC.add(item.name.toLowerCase()); }
      }
      if (g.length === s.glazes.length && c.length === s.clays.length) return false;
      if (quiet) write(normalize({ ...s, glazes: g, clays: c }));
      else this.update({ glazes: g, clays: c });
      return true;
    },
    setGlazes(list) { this.update({ glazes: list }); },
    setClays(list) { this.update({ clays: list }); },

    // ----- sync bookkeeping -----
    /** What goes into the index (no local bookkeeping). */
    forDrive() {
      const s = load();
      return { fields: s.fields, filters: s.filters, glazes: s.glazes, clays: s.clays, savedAt: s.updatedAt ? new Date(s.updatedAt).toISOString() : null };
    },
    isDirty(rootId) { const s = load(); return !!s.updatedAt && (!s.sync || s.sync.root !== rootId || s.sync.syncedAt !== s.updatedAt); },
    markSynced(rootId, at) { const s = load(); write({ ...s, sync: { root: rootId, syncedAt: at } }); },
    /** Replace with a newer copy from Drive. */
    applyRemote(remote, rootId) {
      const at = Date.parse(remote.savedAt) || 0;
      write({ ...normalize({ ...remote, updatedAt: at }), sync: { root: rootId, syncedAt: at } });
    },
    onChange(fn) { listeners.add(fn); },
  };
})();
