/* Custom fields and home-screen filter choices.
 *
 * Stored on the device (localStorage) and synced to Google Drive inside
 * pottery-log-index.json under "settings". The newest save wins, like pieces.
 *
 *   { fields: [{ id, name, type, options?,        type: text | number | date | yesno | choice
 *                remember?, values?, aliases? }],  text fields: remember typed values (values)
 *                                                  aliases: earlier names, so old piece.json still reads
 *     filters: ['clayBody', 'cf-…', …],          fields shown as filters on the home screen
 *     glazes: ['Celadon', …],                     remembered glazes, offered in a drop-down
 *     clays: [{ name: 'B-Mix', cone: '6' }, …],   remembered clay bodies, each with its cone
 *     defaultsAdded: true,                        the starter fields were offered once
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

  // Fields every log starts with (added once; they can be edited or removed like any other).
  const DEFAULT_FIELDS = [
    { id: 'cf-line', name: 'Line', type: 'text', remember: true, values: [] },
    { id: 'cf-price', name: 'Price', type: 'number' },
    { id: 'cf-purpose', name: 'Purpose', type: 'text', remember: true, values: ['Keep', 'Give', 'Sell'] },
  ];

  const cleanList = (list, max = 120) => {
    const seen = new Set();
    return (Array.isArray(list) ? list : []).map((x) => String(x == null ? '' : x).trim().slice(0, max))
      .filter((x) => { const k = x.toLowerCase(); if (!x || seen.has(k)) return false; seen.add(k); return true; });
  };

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
      .map((f) => {
        const type = TYPES[f.type] ? f.type : 'text';
        const out = { id: String(f.id), name: String(f.name).trim().slice(0, 60), type };
        if (type === 'choice') out.options = cleanList(f.options);
        if (type === 'text') {
          if (typeof f.remember === 'boolean') out.remember = f.remember; // unset: older field, set up on first sync
          out.values = cleanList(f.values, 200);
        }
        const aliases = cleanList(f.aliases, 60).filter((a) => a.toLowerCase() !== out.name.toLowerCase());
        if (aliases.length) out.aliases = aliases;
        return out;
      });
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
    return { fields, filters: [...new Set(filters)], glazes, clays, defaultsAdded: !!s.defaultsAdded, updatedAt: Number(s.updatedAt) || 0, sync: s.sync || null };
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
    const byName = new Map();
    for (const f of load().fields) for (const n of [...(f.aliases || []), f.name]) byName.set(n.toLowerCase(), f);
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

  const RESERVED = ['title', 'stage', 'notes', 'clay body', 'clay bodies', 'glaze', 'glazes', 'cone', 'firing type', 'forming method'];
  function checkName(name, exceptId) {
    name = String(name || '').trim().slice(0, 60);
    if (!name) throw new Error('Give the field a name');
    const lower = name.toLowerCase();
    if (load().fields.some((f) => f.id !== exceptId && f.name.toLowerCase() === lower) || RESERVED.includes(lower)) {
      throw new Error('There is already a field called “' + name + '”');
    }
    return name;
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

    addField(name, type, options, remember = true) {
      const s = load();
      name = checkName(name);
      let id = 'cf-' + slug(name);
      while (s.fields.some((f) => f.id === id)) id += '-' + Math.random().toString(36).slice(2, 5);
      const field = { id, name, type: TYPES[type] ? type : 'text' };
      if (field.type === 'choice') {
        field.options = cleanList(options);
        if (!field.options.length) throw new Error('Add at least one choice');
      }
      if (field.type === 'text') { field.remember = !!remember; field.values = cleanList(options, 200); }
      this.update({ fields: [...s.fields, field] });
      return field;
    },

    /** Change a field's name, type, or its list (choices, or remembered values for text).
     * Switching text ↔ choice carries the list across. Values already on pieces are kept. */
    editField(id, { name, type, remember, list }) {
      const s = load();
      const old = s.fields.find((f) => f.id === id);
      if (!old) throw new Error('That field no longer exists');
      name = checkName(name, id);
      type = TYPES[type] ? type : old.type;
      const field = { id, name, type };
      const carried = list !== undefined ? cleanList(list) : old.type === 'choice' ? old.options : old.values || [];
      if (type === 'choice') {
        field.options = carried;
        if (!field.options.length) throw new Error('Add at least one choice');
      }
      if (type === 'text') { field.remember = remember !== undefined ? !!remember : old.type === 'choice' || old.remember !== false; field.values = carried; }
      const aliases = [...(old.aliases || [])];
      if (old.name.toLowerCase() !== name.toLowerCase()) aliases.push(old.name);
      if (aliases.length) field.aliases = aliases.slice(-5);
      this.update({ fields: s.fields.map((f) => (f.id === id ? field : f)) });
      return field;
    },

    /** Remember new values typed into remembered text fields: { fieldId: value }. */
    learnValues(byField) {
      const s = load();
      let changed = false;
      const fields = s.fields.map((f) => {
        const v = byField[f.id];
        if (f.type !== 'text' || !f.remember || typeof v !== 'string' || !v.trim()) return f;
        if ((f.values || []).some((x) => x.toLowerCase() === v.trim().toLowerCase())) return f;
        changed = true;
        return { ...f, values: [...(f.values || []), v.trim()] };
      });
      if (changed) this.update({ fields });
      return changed;
    },

    /**
     * One-time setup: add the starter fields and turn on "remember" for text fields made
     * before that option existed (filling their lists from valuesFor(fieldId)).
     * quiet: before the first sync, so anything newer in Drive still wins.
     */
    setUp(valuesFor, { quiet = false } = {}) {
      const s = load();
      let fields = s.fields;
      const needsRemember = fields.some((f) => f.type === 'text' && f.remember === undefined);
      if (s.defaultsAdded && !needsRemember) return false;
      fields = fields.map((f) => (f.type === 'text' && f.remember === undefined
        ? { ...f, remember: true, values: cleanList([...(f.values || []), ...valuesFor(f.id)], 200) } : f));
      if (!s.defaultsAdded) {
        const names = new Set(fields.map((f) => f.name.toLowerCase()));
        const ids = new Set(fields.map((f) => f.id));
        fields = [...fields, ...DEFAULT_FIELDS.filter((d) => !names.has(d.name.toLowerCase()) && !ids.has(d.id))];
      }
      const next = { ...s, fields, defaultsAdded: true };
      if (quiet) write(normalize(next)); else this.update(next);
      return true;
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
      return { fields: s.fields, filters: s.filters, glazes: s.glazes, clays: s.clays, defaultsAdded: s.defaultsAdded, savedAt: s.updatedAt ? new Date(s.updatedAt).toISOString() : null };
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
