/* Custom fields and home-screen filter choices.
 *
 * Stored on the device (localStorage) and synced to Google Drive inside
 * pottery-log-index.json under "settings". The newest save wins, like pieces.
 *
 *   { fields: [{ id, name, type, options?,        type: text | number | currency | date | yesno | choice | link
 *                remember?, values?, currency?,   text fields: remember typed values (values)
 *                aliases? }],                      currency fields: default for new prices, e.g. 'CAD'
 *                                                  (currencyChosen: picked by hand, so it doesn't follow the country)
 *                                                  aliases: earlier names, so old piece.json still reads
 *     filters: ['clayBody', 'cf-…', …],          fields shown as filters on the home screen
 *     glazes: ['Celadon', …],                     remembered glazes, offered in a drop-down
 *     clays: [{ name: 'B-Mix' }, …],              remembered clay bodies (cones are on the bisque and glaze firing)
 *     recipes: [{ id, name, glazes: [..],         glaze recipes: a set of glazes and how they were applied.
 *                 notes, pieceId?, thumb?,         pieceId: the piece it was saved from (its last photo is the default
 *                 createdAt, updatedAt }],           thumbnail); thumb: { pieceId, photoId, fileId? } picked in Settings.
 *                                                  Changing the glazes also changes them on the pieces using it
 *                                                  (the app asks first). A removed recipe stays as
 *                                                  { id, deleted: true, updatedAt } so other devices remove it too.
 *                                                  Recipes are merged one by one when syncing, so one made on
 *                                                  another device is never lost to a newer settings save.
 *     square: { enabled: true, appId: '' },      "Integrate with Square" (on unless turned off)
 *     defaultsAdded: true, defaultsVersion: 3,    which starter fields were offered (each set once)
 *     updatedAt: ms,
 *     sync: { root, syncedAt } }                 local bookkeeping, never uploaded
 *
 * A piece keeps its values in piece.custom = { fieldId: value }. A currency value carries its own
 * currency, { amount: 24.5, currency: 'CAD' }, so changing the default never changes old prices. In Drive they are
 * written by field name ("customFields": { "Kiln": "Big kiln" }) so they read naturally.
 */
(function () {
  'use strict';

  const KEY = 'potteryLog.settings';
  const TYPES = { text: 'Text', number: 'Number', currency: 'Currency', date: 'Date', yesno: 'Yes / no', choice: 'Choice list', link: 'Link' };

  // The currency used where this device is, from its language setting's region (en-GB → GBP).
  const EURO = 'AT BE CY DE EE ES FI FR GR HR IE IT LT LU LV MT NL PT SI SK AD MC SM VA ME XK';
  const REGION_CURRENCY = {
    US: 'USD', CA: 'CAD', GB: 'GBP', AU: 'AUD', NZ: 'NZD', JP: 'JPY', CN: 'CNY', HK: 'HKD', TW: 'TWD', KR: 'KRW',
    SG: 'SGD', IN: 'INR', CH: 'CHF', LI: 'CHF', SE: 'SEK', NO: 'NOK', DK: 'DKK', IS: 'ISK', PL: 'PLN', CZ: 'CZK',
    HU: 'HUF', RO: 'RON', BG: 'BGN', MX: 'MXN', BR: 'BRL', AR: 'ARS', CL: 'CLP', CO: 'COP', PE: 'PEN', ZA: 'ZAR',
    IL: 'ILS', TR: 'TRY', AE: 'AED', SA: 'SAR', TH: 'THB', MY: 'MYR', ID: 'IDR', PH: 'PHP', VN: 'VND', UA: 'UAH',
    PR: 'USD', EC: 'USD', SV: 'USD', PA: 'USD',
  };
  EURO.split(' ').forEach((r) => { REGION_CURRENCY[r] = 'EUR'; });
  // Where the device is, from its time zone. Many phones keep the language as en-US outside
  // the US, so the time zone is checked first (America/Vancouver → Canada → CAD).
  const ZONE_REGION = {};
  const zones = (region, prefix, names) => names.split(' ').forEach((n) => { ZONE_REGION[prefix + n] = region; });
  zones('CA', 'America/', 'Vancouver Edmonton Winnipeg Regina Swift_Current Toronto Montreal Nipigon Thunder_Bay Rainy_River Atikokan ' +
    'Halifax Glace_Bay Moncton Goose_Bay St_Johns Blanc-Sablon Whitehorse Dawson Dawson_Creek Fort_Nelson Creston Yellowknife Inuvik ' +
    'Iqaluit Pangnirtung Rankin_Inlet Resolute Cambridge_Bay');
  zones('CA', 'Canada/', 'Pacific Mountain Central Saskatchewan Eastern Atlantic Newfoundland Yukon');
  zones('US', 'America/', 'New_York Chicago Denver Los_Angeles Phoenix Anchorage Boise Detroit Juneau Sitka Nome Adak Yakutat Metlakatla Menominee');
  zones('US', 'Pacific/', 'Honolulu');
  zones('MX', 'America/', 'Mexico_City Monterrey Merida Cancun Chihuahua Hermosillo Mazatlan Tijuana Bahia_Banderas Matamoros Ojinaga');
  zones('GB', 'Europe/', 'London Belfast');
  zones('NZ', 'Pacific/', 'Auckland Chatham');
  Object.assign(ZONE_REGION, {
    'Europe/Dublin': 'IE', 'Europe/Paris': 'FR', 'Europe/Berlin': 'DE', 'Europe/Madrid': 'ES', 'Europe/Rome': 'IT', 'Europe/Amsterdam': 'NL',
    'Europe/Brussels': 'BE', 'Europe/Vienna': 'AT', 'Europe/Lisbon': 'PT', 'Europe/Helsinki': 'FI', 'Europe/Athens': 'GR', 'Europe/Zurich': 'CH',
    'Europe/Stockholm': 'SE', 'Europe/Oslo': 'NO', 'Europe/Copenhagen': 'DK', 'Europe/Warsaw': 'PL', 'Europe/Prague': 'CZ', 'Asia/Tokyo': 'JP',
    'Asia/Kolkata': 'IN', 'Asia/Singapore': 'SG', 'Asia/Hong_Kong': 'HK', 'Africa/Johannesburg': 'ZA', 'America/Sao_Paulo': 'BR',
  });
  function zoneRegion() {
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
      if (ZONE_REGION[tz]) return ZONE_REGION[tz];
      if (/^America\/(Indiana|Kentucky|North_Dakota)\//.test(tz)) return 'US';
      if (tz.startsWith('Australia/')) return 'AU';
    } catch (e) { /* older browser */ }
    return null;
  }
  function localCurrency() {
    const zone = zoneRegion();
    if (zone && REGION_CURRENCY[zone]) return REGION_CURRENCY[zone];
    try { // otherwise the region in the language setting, when it names one (en-GB, fr-CA)
      for (const tag of [...(navigator.languages || []), navigator.language]) {
        const region = tag && new Intl.Locale(tag).region;
        if (region && REGION_CURRENCY[region]) return REGION_CURRENCY[region];
      }
    } catch (e) { /* older browser */ }
    return 'USD';
  }
  const isCurrency = (c) => {
    if (!/^[A-Z]{3}$/.test(String(c || ''))) return false;
    try { new Intl.NumberFormat('en', { style: 'currency', currency: c }); return true; } catch (e) { return false; }
  };
  /** Digits after the decimal point (2 for USD, 0 for JPY). */
  function minorDigits(currency) {
    try { return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits; } catch (e) { return 2; }
  }
  /** Currencies for the drop-down: what the browser knows, with names, local one first. */
  function currencyChoices() {
    let codes = Object.values(REGION_CURRENCY);
    try { if (Intl.supportedValuesOf) codes = Intl.supportedValuesOf('currency'); } catch (e) { /* keep the short list */ }
    let names = null;
    try { names = new Intl.DisplayNames(undefined, { type: 'currency' }); } catch (e) { /* codes only */ }
    const local = localCurrency();
    return [...new Set([local, ...codes])].map((code) => ({ code, label: code + (names ? ' · ' + names.of(code) : '') }));
  }

  /** A typed link: adds https:// when it's left off. Anything that isn't http(s) is refused. */
  function cleanLink(v) {
    v = String(v == null ? '' : v).trim().slice(0, 2000);
    if (!v) return '';
    if (!/^[a-z][a-z0-9+.-]*:/i.test(v)) v = 'https://' + v;
    try { const u = new URL(v); return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : ''; } catch (e) { return ''; }
  }

  // "Integrate with Square": the fields a sale fills in. Found by id, or by name for a field
  // the user made themselves before this existed.
  const SQUARE_FIELDS = [
    { role: 'price', id: 'cf-price', name: 'Price', type: 'currency' },
    { role: 'sold', id: 'cf-sold', name: 'Sold', type: 'yesno' },
    { role: 'transaction', id: 'cf-transaction', name: 'Transaction', type: 'link' },
  ];

  // Built-in fields that can be used as home-screen filters (stage always has its chips).
  const BUILTIN_FILTERS = [
    { id: 'clayBody', name: 'Clay body' },
    { id: 'method', name: 'Forming method' },
    { id: 'glazes', name: 'Glaze' },
    { id: 'recipe', name: 'Recipe' },
    { id: 'bisqueFiringType', name: 'Bisque firing type' },
    { id: 'bisqueCone', name: 'Bisque cone' },
    { id: 'glazeFiringType', name: 'Glaze firing type' },
    { id: 'glazeCone', name: 'Glaze cone' },
  ];

  // Fields every log starts with (added once; they can be edited or removed like any other).
  // Version 2 added Sold and put them in this order.
  const DEFAULT_FIELDS = [
    { id: 'cf-purpose', name: 'Purpose', type: 'text', remember: true, values: ['Keep', 'Give', 'Sell'] },
    { id: 'cf-line', name: 'Type', type: 'text', remember: true, values: ['Bowl', 'Vase', 'Mug'] },
    { id: 'cf-price', name: 'Price', type: 'currency' },
    { id: 'cf-sold', name: 'Sold', type: 'yesno' },
  ];
  // Version 3 made Price a currency field, renamed Line to Type (with Bowl, Vase and Mug), and
  // added the Square fields (when Square is on).
  const DEFAULTS_VERSION = 3;

  /* ---------- glaze recipes ---------- */

  const sameGlazes = (a, b) => {
    const k = (l) => (l || []).map((x) => String(x).toLowerCase()).sort().join('\n');
    return k(a) === k(b);
  };

  function normalizeRecipe(r) {
    if (!r || !r.id) return null;
    const id = String(r.id).slice(0, 80);
    const updatedAt = Number(r.updatedAt) || 0;
    if (r.deleted) return { id, deleted: true, updatedAt };
    const name = String(r.name || '').trim().slice(0, 80);
    if (!name) return null;
    const out = { id, name, glazes: cleanList(r.glazes), notes: String(r.notes || '').slice(0, 4000) };
    if (r.pieceId) out.pieceId = String(r.pieceId);
    const t = r.thumb;
    if (t && t.pieceId && t.photoId) {
      out.thumb = { pieceId: String(t.pieceId), photoId: String(t.photoId) };
      if (t.fileId) out.thumb.fileId = String(t.fileId);
    }
    out.createdAt = Number(r.createdAt) || updatedAt;
    out.updatedAt = updatedAt;
    return out;
  }

  /** Combine two recipe lists by id: the newer save of each recipe wins. Oldest first. */
  function mergeRecipes(a, b) {
    const byId = new Map();
    for (const r of [...(a || []), ...(b || [])]) {
      const n = normalizeRecipe(r);
      if (!n) continue;
      const cur = byId.get(n.id);
      if (!cur || n.updatedAt > cur.updatedAt) byId.set(n.id, n);
    }
    return [...byId.values()].sort((x, y) => (x.createdAt || 0) - (y.createdAt || 0) || x.id.localeCompare(y.id));
  }

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
        if (type === 'currency') {
          out.currency = isCurrency(f.currency) ? f.currency : localCurrency();
          if (f.currencyChosen) out.currencyChosen = true; // picked by the user, not the default
        }
        if (type === 'text') {
          if (typeof f.remember === 'boolean') out.remember = f.remember; // unset: older field, set up on first sync
          out.values = cleanList(f.values, 200);
        }
        const aliases = cleanList(f.aliases, 60).filter((a) => a.toLowerCase() !== out.name.toLowerCase());
        if (aliases.length) out.aliases = aliases;
        return out;
      });
    const known = new Set([...BUILTIN_FILTERS.map((b) => b.id), ...fields.map((f) => f.id)]);
    const renamed = { firingType: 'glazeFiringType', cone: 'glazeCone' }; // before bisque firing was added
    const filters = (Array.isArray(s.filters) ? s.filters : []).map((id) => renamed[id] || String(id)).filter((id) => known.has(id));
    const seen = new Set();
    const uniqueBy = (name) => { const k = name.toLowerCase(); if (!name || seen.has(k)) return false; seen.add(k); return true; };
    const glazes = (Array.isArray(s.glazes) ? s.glazes : []).map((g) => String(g).trim().slice(0, 120)).filter(uniqueBy);
    seen.clear();
    const clays = (Array.isArray(s.clays) ? s.clays : [])
      .map((c) => (typeof c === 'string' ? { name: c } : c || {}))
      .map((c) => ({ name: String(c.name || '').trim().slice(0, 120) })) // older lists had a cone per clay: dropped
      .filter((c) => uniqueBy(c.name));
    const sq = s.square && typeof s.square === 'object' ? s.square : {};
    const square = { enabled: sq.enabled !== false, appId: String(sq.appId || '').trim().slice(0, 100) };
    const recipes = mergeRecipes(s.recipes, []);
    return { fields, filters: [...new Set(filters)], glazes, clays, recipes, square, defaultsAdded: !!s.defaultsAdded,
      defaultsVersion: Number(s.defaultsVersion) || (s.defaultsAdded ? 1 : 0), updatedAt: Number(s.updatedAt) || 0, sync: s.sync || null };
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
      let v = custom ? custom[f.id] : undefined;
      if (f.type === 'yesno') v = v === true; // yes/no fields default to No
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
    if (f.type === 'currency') {
      const obj = v && typeof v === 'object';
      const n = toNumber(obj ? v.amount : v);
      if (n === '') return '';
      const currency = obj && isCurrency(v.currency) ? v.currency : pinCurrency(f);
      const k = 10 ** minorDigits(currency);
      return { amount: Math.round(n * k) / k, currency };
    }
    if (v && typeof v === 'object' && 'amount' in v) v = v.amount; // was a currency field
    if (f.type === 'number') return toNumber(v);
    if (f.type === 'link') return cleanLink(v);
    return v == null ? '' : String(v);
  }

  function toNumber(v) {
    if (v === '' || v == null) return '';
    const n = Number(typeof v === 'string' ? v.replace(/[^\d.,-]/g, '').replace(',', '.') : v);
    return Number.isNaN(n) ? '' : n;
  }
  /** The currency for a price saved before prices carried their own: the field's, if it was
   * picked by hand, otherwise the one where the device is now (when the price was entered). */
  const pinCurrency = (f) => (f.currencyChosen && isCurrency(f.currency) ? f.currency : localCurrency());
  /** A currency field's value as { amount, currency }, or null when empty. */
  function money(f, v) { const m = coerce(f, v); return m === '' ? null : m; }

  // Display text → number for currency values, so filter drop-downs sort by amount.
  const amountOf = new Map();
  function formatMoney(f, v) {
    const m = money(f, v);
    if (!m) return '';
    const n = m.amount;
    let text;
    try { text = new Intl.NumberFormat(undefined, { style: 'currency', currency: m.currency }).format(n); } catch (e) { text = String(n); }
    if (amountOf.size > 2000) amountOf.clear();
    amountOf.set(text, n);
    return text;
  }

  function squareField(role, fields = load().fields) {
    const d = SQUARE_FIELDS.find((x) => x.role === role);
    return fields.find((f) => f.id === d.id) || fields.find((f) => f.name.toLowerCase() === d.name.toLowerCase()) || null;
  }

  /** The fields with Price, Sold and Transaction present and of the right type. New ones go
   * after the existing Square fields (or at the end). Values on pieces are kept. */
  function withSquareFields(fields) {
    let out = [...fields];
    let after = -1;
    for (const d of SQUARE_FIELDS) {
      const f = squareField(d.role, out);
      if (f) {
        const i = out.indexOf(f);
        if (f.type !== d.type) {
          const next = { id: f.id, name: f.name, type: d.type };
          if (f.aliases) next.aliases = f.aliases;
          if (d.type === 'currency') next.currency = localCurrency();
          out[i] = next;
        }
        after = Math.max(after, i);
      } else {
        const next = { id: out.some((x) => x.id === d.id) ? d.id + '-' + Math.random().toString(36).slice(2, 5) : d.id, name: d.name, type: d.type };
        if (d.type === 'currency') next.currency = localCurrency();
        out.splice(after + 1, 0, next);
        after += 1;
      }
    }
    return out;
  }
  const sameFields = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  /** The Price field, when it's still on a default currency that isn't this country's. */
  function priceToFollow(fields) {
    const p = squareField('price', fields);
    return p && p.type === 'currency' && !p.currencyChosen && p.currency !== localCurrency() ? p : null;
  }
  let currencyNotice = null; // { name, from, to } after Price moved to the local currency
  /** Ids of the fields Square fills in, while it's on (they can't be removed or change type). */
  function squareLockedIds() {
    const s = load();
    if (!s.square.enabled) return new Set();
    return new Set(SQUARE_FIELDS.map((d) => squareField(d.role, s.fields)).filter(Boolean).map((f) => f.id));
  }

  const RESERVED = ['title', 'stage', 'notes', 'clay body', 'clay bodies', 'glaze', 'glazes', 'recipe', 'cone', 'firing type', 'forming method'];
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
    localCurrency,
    currencyChoices,
    minorDigits,
    get: load,
    fields: () => load().fields,
    field: (id) => load().fields.find((f) => f.id === id),
    filters: () => load().filters,

    /** Local change by the user: bumps updatedAt so it syncs and wins over older copies. */
    update(changes) {
      write(normalize({ ...load(), ...changes, updatedAt: Date.now() }));
    },

    addField(name, type, options, remember = true, currency) {
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
      if (field.type === 'currency') {
        field.currency = isCurrency(currency) ? currency : localCurrency();
        if (field.currency !== localCurrency()) field.currencyChosen = true;
      }
      this.update({ fields: [...s.fields, field] });
      return field;
    },

    /** Change a field's name, type, or its list (choices, or remembered values for text).
     * Switching text ↔ choice carries the list across. Values already on pieces are kept. */
    editField(id, { name, type, remember, list, currency }) {
      const s = load();
      const old = s.fields.find((f) => f.id === id);
      if (!old) throw new Error('That field no longer exists');
      name = checkName(name, id);
      type = TYPES[type] ? type : old.type;
      if (type !== old.type && squareLockedIds().has(id)) throw new Error('Square uses “' + old.name + '”, so its type stays ' + TYPES[old.type] + '. Turn off Integrate with Square to change it.');
      const field = { id, name, type };
      const carried = list !== undefined ? cleanList(list) : old.type === 'choice' ? old.options : old.values || [];
      if (type === 'choice') {
        field.options = carried;
        if (!field.options.length) throw new Error('Add at least one choice');
      }
      if (type === 'text') { field.remember = remember !== undefined ? !!remember : old.type === 'choice' || old.remember !== false; field.values = carried; }
      if (type === 'currency') {
        field.currency = isCurrency(currency) ? currency : old.currency || localCurrency();
        if (old.currencyChosen || (old.type === 'currency' && field.currency !== old.currency)) field.currencyChosen = true;
      }
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
      const needsSquare = s.square.enabled && !sameFields(withSquareFields(fields), fields);
      const needsCurrency = !!priceToFollow(fields);
      if (s.defaultsVersion >= DEFAULTS_VERSION && !needsRemember && !needsSquare && !needsCurrency) return false;
      fields = fields.map((f) => (f.type === 'text' && f.remember === undefined
        ? { ...f, remember: true, values: cleanList([...(f.values || []), ...valuesFor(f.id)], 200) } : f));
      if (s.defaultsVersion < 2) {
        const names = new Set(fields.map((f) => f.name.toLowerCase()));
        const ids = new Set(fields.map((f) => f.id));
        // Version 1 offered Purpose, Line and Price; ones removed since then stay removed.
        const offer = s.defaultsVersion >= 1 ? DEFAULT_FIELDS.filter((d) => d.id === 'cf-sold') : DEFAULT_FIELDS;
        fields = [...fields, ...offer.filter((d) => !names.has(d.name.toLowerCase()) && !ids.has(d.id))];
        // Starter fields first, in the order Purpose, Line, Price, Sold; the rest keep their order.
        const rank = (f) => { const i = DEFAULT_FIELDS.findIndex((d) => d.id === f.id); return i < 0 ? DEFAULT_FIELDS.length : i; };
        fields = fields.map((f, i) => [f, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(([f]) => f);
      }
      if (s.defaultsVersion < 3) {
        // Price was a plain number before currency fields existed.
        fields = fields.map((f) => (f.id === 'cf-price' && f.type === 'number' ? { ...f, type: 'currency', currency: localCurrency() } : f));
        // The starter "Line" field became "Type" (unless it was renamed, or "Type" is taken).
        // Its old name stays as an alias so existing piece.json files still read.
        const typeTaken = fields.some((f) => f.id !== 'cf-line' && f.name.toLowerCase() === 'type');
        fields = fields.map((f) => (f.id === 'cf-line' && f.name === 'Line' && !typeTaken
          ? { ...f, name: 'Type', aliases: [...(f.aliases || []), 'Line'],
            ...(f.type === 'text' ? { values: cleanList([...(f.values || []), 'Bowl', 'Vase', 'Mug'], 200) } : {}) }
          : f));
      }
      // Price follows the country the device is in, unless its currency was picked by hand.
      const moved = priceToFollow(fields);
      if (moved) {
        fields = fields.map((f) => (f === moved ? { ...f, currency: localCurrency() } : f));
        // A field that never had a currency (a new log) just takes the local one, quietly.
        if (moved.currency) currencyNotice = { name: moved.name, from: moved.currency, to: localCurrency() };
      }
      if (s.square.enabled) fields = withSquareFields(fields);
      const next = { ...s, fields, defaultsAdded: true, defaultsVersion: DEFAULTS_VERSION };
      if (quiet) write(normalize(next)); else this.update(next);
      return true;
    },

    money,
    /** Give plain-number prices (saved before prices carried a currency) their currency.
     * Returns the updated custom values, or null if nothing needed it. */
    pinPrices(custom) {
      if (!custom) return null;
      let out = null;
      for (const f of load().fields) {
        const v = custom[f.id];
        if (f.type !== 'currency' || v === undefined || v === '' || (v && typeof v === 'object')) continue;
        out = out || { ...custom };
        const m = coerce(f, v);
        if (m === '') delete out[f.id]; else out[f.id] = m;
      }
      return out;
    },
    /** What setUp changed Price's currency from and to (once), so the app can say so. */
    takeCurrencyNotice() { const n = currencyNotice; currencyNotice = null; return n; },

    /** Put the fields in this order (ids); any not listed keep their place at the end. */
    reorderFields(ids) {
      const s = load();
      const byId = new Map(s.fields.map((f) => [f.id, f]));
      const fields = [...ids.map((id) => byId.get(id)).filter(Boolean), ...s.fields.filter((f) => !ids.includes(f.id))];
      if (fields.every((f, i) => f === s.fields[i])) return false;
      this.update({ fields });
      return true;
    },

    removeField(id) {
      const s = load();
      if (squareLockedIds().has(id)) throw new Error('Square uses this field. Turn off Integrate with Square to remove it.');
      this.update({ fields: s.fields.filter((f) => f.id !== id), filters: s.filters.filter((x) => x !== id) });
    },

    /** Display text for a value. */
    format(f, v) {
      if (f.type === 'yesno') return v === true ? 'Yes' : 'No'; // unset means No
      if (v === undefined || v === null || v === '') return '';
      if (f.type === 'currency') return formatMoney(f, v);
      return String(v);
    },
    /** A number to sort a currency field's display text by. */
    amountOf: (text) => (amountOf.has(text) ? amountOf.get(text) : Number(String(text).replace(/[^\d.-]/g, ''))),

    // ----- Square -----
    square: () => load().square,
    squareField: (role) => squareField(role),
    squareLockedIds,
    /** Turn the integration on or off, or set the app ID. Turning it on adds any missing fields. */
    setSquare(changes) {
      const s = load();
      const square = { ...s.square, ...changes };
      this.update({ square, fields: square.enabled ? withSquareFields(s.fields) : s.fields });
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
        const item = { name: typeof x === 'string' ? x : x.name };
        if (item.name && !hasC.has(item.name.toLowerCase())) { c.push(item); hasC.add(item.name.toLowerCase()); }
      }
      if (g.length === s.glazes.length && c.length === s.clays.length) return false;
      if (quiet) write(normalize({ ...s, glazes: g, clays: c }));
      else this.update({ glazes: g, clays: c });
      return true;
    },
    setGlazes(list) { this.update({ glazes: list }); },

    // ----- glaze recipes -----
    sameGlazes,
    /** Recipes that haven't been removed, oldest first. */
    recipes: () => load().recipes.filter((r) => !r.deleted),
    recipe: (id) => (id ? load().recipes.find((r) => r.id === id && !r.deleted) || null : null),
    checkRecipeName(name, exceptId) {
      name = String(name || '').trim().slice(0, 80);
      if (!name) throw new Error('Give the recipe a name');
      if (this.recipes().some((r) => r.id !== exceptId && r.name.toLowerCase() === name.toLowerCase())) {
        throw new Error('There is already a recipe called “' + name + '”');
      }
      return name;
    },
    /** Save a new recipe: { name, glazes, notes, pieceId?, id? }. Its glazes are fixed from now on. */
    addRecipe({ id, name, glazes, notes, pieceId }) {
      name = this.checkRecipeName(name);
      const list = cleanList(glazes);
      if (!list.length) throw new Error('Add at least one glaze');
      const now = Date.now();
      const r = normalizeRecipe({ id: id || 'r-' + Math.random().toString(36).slice(2, 10) + now.toString(36), name, glazes: list, notes, pieceId, createdAt: now, updatedAt: now });
      this.update({ recipes: [...load().recipes.filter((x) => x.id !== r.id), r] });
      this.learn({ glazes: list });
      return r;
    },
    /** Change a recipe's name, notes, glazes or thumbnail (thumb null: back to the default).
     * The app updates the pieces using it when the glazes change. */
    editRecipe(id, changes) {
      const old = this.recipe(id);
      if (!old) throw new Error('That recipe no longer exists');
      const next = { ...old, updatedAt: Date.now() };
      if ('name' in changes) next.name = this.checkRecipeName(changes.name, id);
      if ('notes' in changes) next.notes = changes.notes;
      if ('glazes' in changes) {
        next.glazes = cleanList(changes.glazes);
        if (!next.glazes.length) throw new Error('Add at least one glaze');
      }
      if ('thumb' in changes) { if (changes.thumb) next.thumb = changes.thumb; else delete next.thumb; }
      const r = normalizeRecipe(next);
      this.update({ recipes: load().recipes.map((x) => (x.id === id ? r : x)) });
      if (changes.glazes) this.learn({ glazes: r.glazes });
      return r;
    },
    removeRecipe(id) {
      this.update({ recipes: load().recipes.map((x) => (x.id === id ? { id, deleted: true, updatedAt: Date.now() } : x)) });
    },
    setClays(list) { this.update({ clays: list }); },

    // ----- sync bookkeeping -----
    /** What goes into the index (no local bookkeeping). */
    forDrive() {
      const s = load();
      return { fields: s.fields, filters: s.filters, glazes: s.glazes, clays: s.clays, recipes: s.recipes, square: s.square, defaultsAdded: s.defaultsAdded, defaultsVersion: s.defaultsVersion, savedAt: s.updatedAt ? new Date(s.updatedAt).toISOString() : null };
    },
    isDirty(rootId) { const s = load(); return !!s.updatedAt && (!s.sync || s.sync.root !== rootId || s.sync.syncedAt !== s.updatedAt); },
    markSynced(rootId, at) { const s = load(); write({ ...s, sync: { root: rootId, syncedAt: at } }); },
    /** Replace with a newer copy from Drive. Recipes are combined with this device's, and when
     * this device had some that Drive lacked, the result is saved again so it goes up too. */
    applyRemote(remote, rootId) {
      const at = Date.parse(remote.savedAt) || 0;
      const local = load().recipes;
      const theirs = normalize({ ...remote, updatedAt: at });
      const recipes = mergeRecipes(theirs.recipes, local);
      write({ ...theirs, recipes, sync: { root: rootId, syncedAt: at } });
      if (JSON.stringify(recipes) !== JSON.stringify(theirs.recipes)) this.update({});
    },
    /** Take in recipes from an older copy in Drive (this device's settings are newer). */
    absorbRecipes(list) {
      const s = load();
      const recipes = mergeRecipes(s.recipes, list);
      if (JSON.stringify(recipes) === JSON.stringify(s.recipes)) return false;
      this.update({ recipes });
      return true;
    },
    onChange(fn) { listeners.add(fn); },
  };
})();
