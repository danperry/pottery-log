/* Pottery Log – UI, routing and backup orchestration. */
(function () {
  'use strict';

  const STAGES = [
    { id: 'greenware', label: 'Greenware', date: 'dateMade' },
    { id: 'bisque', label: 'Bisque', date: 'dateBisque' },
    { id: 'glazed', label: 'Glazed', date: 'dateGlazed' },
    { id: 'done', label: 'Done', date: 'dateDone' },
  ];
  const STAGE_BY_ID = Object.fromEntries(STAGES.map((s) => [s.id, s]));
  const METHOD_LABEL = { wheel: 'Wheel', 'hand-built': 'Hand-built' };
  const CONES = ['022', '021', '020', '019', '018', '017', '016', '015', '014', '013', '012', '011', '010',
    '09', '08', '07', '06', '05', '04', '03', '02', '01',
    '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13', '14'];
  const FIRING_TYPES = ['Electric (oxidation)', 'Gas (reduction)', 'Gas (oxidation)', 'Raku', 'Wood', 'Soda', 'Salt', 'Pit / smoke', 'Other'];
  const PHOTO_MAX = 1600;
  const THUMB_MAX = 480;
  const LAST_SYNC_KEY = 'potteryLog.lastSync';
  const FILTER_KEY = 'potteryLog.filter';
  const CONNECT_TIP_KEY = 'potteryLog.connectTipDismissed';
  const FIELD_FILTER_KEY = 'potteryLog.fieldFilters'; // chosen values, per device
  const INSTALL_TIP_KEY = 'potteryLog.installTipDismissed';

  const $ = (sel, root = document) => root.querySelector(sel);
  const app = $('#app');
  const titleEl = $('#pageTitle');
  const backBtn = $('#backBtn');
  const addBtn = $('#addBtn');
  const backupNavBtn = $('#backupNavBtn');

  const ICON_X = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  const ICON_EDIT = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4"/></svg>';
  const ICON_POT = '<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M22 10h20M24 10c0 6-10 10-10 24 0 12 8 20 18 20s18-8 18-20c0-14-10-18-10-24"/></svg>';

  /* ---------- small helpers ---------- */

  function store(key, val) {
    try {
      if (val === undefined) return JSON.parse(localStorage.getItem(key) || 'null');
      if (val === null) localStorage.removeItem(key);
      else localStorage.setItem(key, JSON.stringify(val));
    } catch (e) { return null; }
  }

  function today() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function fmtDate(iso) {
    if (!iso) return '';
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }

  function fmtDateTime(ms) {
    return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  }

  function fmtBytes(n) {
    if (!n && n !== 0) return '';
    if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  }

  function el(tag, attrs, ...children) {
    const e = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === 'class') e.className = v;
        else if (k === 'html') e.innerHTML = v;
        else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
        else e.setAttribute(k, v === true ? '' : v);
      }
    }
    children.flat().forEach((c) => { if (c != null) e.append(c); });
    return e;
  }

  let toastTimer = null;
  function toast(msg, ms = 2600) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), ms);
  }

  function stagePill(stage) {
    const s = STAGE_BY_ID[stage] || STAGES[0];
    return el('span', { class: 'stage-pill st-' + s.id }, s.label);
  }

  function coneLabel(c) { return c ? 'Cone ' + c : ''; }

  /* ---------- object URLs (revoked on every navigation) ---------- */

  let liveUrls = [];
  function blobUrl(blob) {
    const u = URL.createObjectURL(blob);
    liveUrls.push(u);
    return u;
  }
  function revokeUrls() {
    liveUrls.forEach((u) => URL.revokeObjectURL(u));
    liveUrls = [];
  }

  async function photoUrl(id, which = 'thumb') {
    const p = await DB.getPhoto(id);
    if (!p) return null;
    return blobUrl(which === 'full' ? p.blob : (p.thumb || p.blob));
  }

  // Photos of pieces synced from another device are downloaded the first time they're shown,
  // a few at a time.
  const photoFetches = new Map();
  let photoSlots = 3;
  const photoWaiters = [];
  async function fetchPhotoOnce(piece, pid) {
    const fileId = piece.sync && piece.sync.photoFiles && piece.sync.photoFiles[pid];
    if (!fileId || !Drive.isSignedIn() || !navigator.onLine) return;
    if (!photoFetches.has(pid)) {
      photoFetches.set(pid, (async () => {
        if (photoSlots === 0) await new Promise((res) => photoWaiters.push(res));
        photoSlots--;
        try { await Sync.fetchPhoto(pid, fileId); } catch (e) { /* stays a placeholder */ } finally {
          photoSlots++;
          const next = photoWaiters.shift(); if (next) next();
          photoFetches.delete(pid);
        }
      })());
    }
    return photoFetches.get(pid);
  }

  /** Like photoUrl, but downloads the photo from Drive if it isn't on this device yet. */
  async function piecePhotoUrl(piece, pid, which) {
    const u = await photoUrl(pid, which);
    if (u) return u;
    await fetchPhotoOnce(piece, pid);
    return photoUrl(pid, which);
  }

  /* ---------- image processing ---------- */

  async function decodeImage(blob) {
    if (window.createImageBitmap) {
      try { return await createImageBitmap(blob, { imageOrientation: 'from-image' }); } catch (e) { /* fall back */ }
    }
    return new Promise((resolve, reject) => {
      const img = new Image();
      const u = URL.createObjectURL(blob);
      img.onload = () => { URL.revokeObjectURL(u); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(u); reject(new Error('Could not read that image.')); };
      img.src = u;
    });
  }

  function scaleTo(img, max, quality) {
    const w = img.width || img.naturalWidth;
    const h = img.height || img.naturalHeight;
    const scale = Math.min(1, max / Math.max(w, h));
    const cw = Math.round(w * scale);
    const ch = Math.round(h * scale);
    const canvas = document.createElement('canvas');
    canvas.width = cw; canvas.height = ch;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, cw, ch);
    return new Promise((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not process image.'))), 'image/jpeg', quality);
    });
  }

  async function processPhoto(file) {
    const img = await decodeImage(file);
    const blob = await scaleTo(img, PHOTO_MAX, 0.85);
    const thumb = await scaleTo(img, THUMB_MAX, 0.8);
    if (img.close) img.close();
    return { blob, thumb };
  }

  async function makeThumb(blob) {
    const img = await decodeImage(blob);
    const t = await scaleTo(img, THUMB_MAX, 0.8);
    if (img.close) img.close();
    return t;
  }

  /* ---------- routing ---------- */

  function nav(hash, replace) {
    if (replace) location.replace(hash);
    else location.hash = hash;
  }

  function route() {
    revokeUrls();
    if (typeof updateBadge === 'function') updateBadge();
    const h = location.hash.replace(/^#\/?/, '');
    const [view, id] = h.split('/');
    window.scrollTo(0, 0);
    if (view === 'piece' && id) return renderDetail(decodeURIComponent(id));
    if (view === 'edit' && id) return renderEdit(decodeURIComponent(id));
    if (view === 'new') return renderEdit(null);
    if (view === 'backup') return renderBackup();
    return renderList();
  }

  function setChrome({ title, back, fab }) {
    titleEl.textContent = title;
    document.title = title === 'Pottery Log' ? 'Pottery Log' : title + ' · Pottery Log';
    backBtn.hidden = !back;
    addBtn.hidden = !fab;
    backupNavBtn.hidden = !!back;
  }

  // history.back() would leave the app on a fresh deep link, so track in-app navigation.
  let inAppNavs = 0;
  window.addEventListener('hashchange', () => { inAppNavs++; });
  backBtn.addEventListener('click', () => {
    if (inAppNavs > 0) history.back(); else nav('#/', true);
  });
  addBtn.addEventListener('click', () => nav('#/new'));
  backupNavBtn.addEventListener('click', () => nav('#/backup'));

  function mount(tplId) {
    app.replaceChildren($('#' + tplId).content.cloneNode(true));
  }

  /* ---------- "add to home screen" tip ---------- */

  const ICON_SHARE = '<svg class="tip-glyph" viewBox="0 0 24 24" aria-label="Share"><path d="M12 15V3M8 7l4-4 4 4M6 11H5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-1"/></svg>';
  const ICON_MENU = '<svg class="tip-glyph" viewBox="0 0 24 24" aria-label="menu"><path d="M12 5h.01M12 12h.01M12 19h.01" stroke-width="3"/></svg>';
  let installPrompt = null; // Chrome/Android's own install dialog, when it offers one

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); // show our tip instead of Chrome's mini bar
    installPrompt = e;
    if (location.hash.replace(/^#\/?/, '') === '') drawInstallTip();
  });
  window.addEventListener('appinstalled', () => {
    installPrompt = null;
    const tip = $('#installTip'); if (tip) tip.hidden = true;
  });

  function isInstalled() {
    return window.matchMedia('(display-mode: standalone)').matches ||
      window.matchMedia('(display-mode: fullscreen)').matches || navigator.standalone === true;
  }

  function phoneKind() {
    const ua = navigator.userAgent;
    // iPadOS reports itself as a Mac, so also check for touch.
    if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'ios';
    if (/Android/.test(ua)) return 'android';
    return null;
  }

  /** How to add the app on this phone, or null when it's already installed or not a phone. */
  function installHowTo() {
    if (isInstalled()) return null;
    const kind = phoneKind();
    if (!kind) return null;
    if (kind === 'ios') {
      return 'Tap ' + ICON_SHARE + ' <strong>Share</strong> in the browser toolbar, then <strong>Add to Home Screen</strong>.' +
        (/CriOS|FxiOS|EdgiOS/.test(navigator.userAgent) ? '' : ' (In Safari, Share is at the bottom of the screen, or behind ••• on newer iPhones.)');
    }
    if (installPrompt) return 'It opens full screen, works offline, and your phone is less likely to clear its storage.';
    return 'Tap ' + ICON_MENU + ' the browser menu, then <strong>Add to Home screen</strong> or <strong>Install app</strong>.';
  }

  /** First-use tip: connect Google Drive. Returns true if shown. */
  function drawConnectTip() {
    const tip = $('#connectTip');
    if (!tip) return false;
    const show = Drive.configured && !Drive.isSignedIn() && !Drive.needsReconnect() && !store(CONNECT_TIP_KEY);
    tip.hidden = !show;
    if (!show) return false;
    tip.replaceChildren(
      el('img', { src: 'icons/icon-192.png', alt: '' }),
      el('div', { class: 'tip-body' },
        el('strong', { class: 'tip-title' }, 'Keep your pieces safe in Google Drive'),
        el('p', null, 'Connect once and every piece, with its photos, syncs to a folder in your own Drive and to your other devices.'),
        el('button', { class: 'btn btn-primary btn-small', type: 'button', onclick: () => Drive.signIn() }, 'Connect Google Drive')),
      el('button', {
        class: 'icon-btn', type: 'button', 'aria-label': 'Dismiss tip', html: ICON_X,
        onclick: () => { store(CONNECT_TIP_KEY, Date.now()); tip.hidden = true; drawInstallTip(); },
      }));
    return true;
  }

  function drawInstallTip() {
    const tip = $('#installTip');
    if (!tip) return;
    if (drawConnectTip()) { tip.hidden = true; return; } // one tip at a time
    const how = store(INSTALL_TIP_KEY) ? null : installHowTo();
    if (!how) { tip.hidden = true; return; }
    const body = el('div', { class: 'tip-body' },
      el('strong', { class: 'tip-title' }, 'Add Pottery Log to your home screen'),
      el('p', { html: how }));
    if (installPrompt) {
      body.append(el('button', {
        class: 'btn btn-primary btn-small', type: 'button',
        onclick: async () => {
          const p = installPrompt; installPrompt = null;
          p.prompt();
          const { outcome } = await p.userChoice.catch(() => ({}));
          if (outcome === 'accepted') tip.hidden = true; else drawInstallTip();
        },
      }, 'Install app'));
    }
    tip.replaceChildren(
      el('img', { src: 'icons/icon-192.png', alt: '' }),
      body,
      el('button', {
        class: 'icon-btn', type: 'button', 'aria-label': 'Dismiss tip', html: ICON_X,
        onclick: () => { store(INSTALL_TIP_KEY, Date.now()); tip.hidden = true; },
      }));
    tip.hidden = false;
  }

  /* ---------- clays and glazes ---------- */

  /** Clay bodies of a piece (older records had one clayBody string). */
  const claysOf = (p) => (Array.isArray(p.clays) ? p.clays : p.clayBody ? [p.clayBody] : []);

  /** Bisque and glaze firing of a piece (older records had one firingType/cone, used for the glaze firing). */
  const firingsOf = (p) => ({
    bisqueFiringType: p.bisqueFiringType || '', bisqueCone: p.bisqueCone || '',
    glazeFiringType: p.glazeFiringType ?? p.firingType ?? '', glazeCone: p.glazeCone ?? p.cone ?? '',
  });

  function clayLabel(name) {
    const c = Settings.clay(name);
    return c && c.cone ? name + ' (cone ' + c.cone + ')' : name;
  }

  function coneOptions(selected, emptyLabel) {
    return [el('option', { value: '' }, emptyLabel || 'Cone —'),
      ...CONES.map((c) => el('option', { value: c, selected: c === selected }, 'Cone ' + c))];
  }

  /**
   * A remembered text field: a drop-down of its remembered values with "+ New…" to type one.
   * The form control is named `name` whichever of the two is showing.
   */
  function valuePicker(cf, current, name) {
    const row = el('div', { class: 'pick-row' });
    let typing = !cf.values.length && !current;
    function draw() {
      if (typing) {
        const input = el('input', { name, maxlength: '200', autocomplete: 'off', placeholder: 'New ' + cf.name.toLowerCase(), 'aria-label': cf.name, value: current || null });
        input.addEventListener('input', () => { current = input.value; });
        const parts = [input];
        if (cf.values.length) {
          parts.push(el('button', { type: 'button', class: 'btn btn-secondary btn-small', onclick: () => { typing = false; current = cf.values.includes(current) ? current : ''; draw(); } }, 'List'));
        }
        row.replaceChildren(...parts);
        return;
      }
      const opts = [...cf.values];
      if (current && !opts.includes(current)) opts.push(current); // keep a value taken off the list
      const sel = el('select', { name, 'aria-label': cf.name },
        el('option', { value: '' }, '—'),
        opts.map((o) => el('option', { value: o, selected: o === current }, o)),
        el('option', { value: '__new' }, '+ New ' + cf.name.toLowerCase() + '…'));
      sel.addEventListener('change', () => {
        if (sel.value === '__new') { typing = true; current = ''; draw(); row.querySelector('input').focus(); } else current = sel.value;
      });
      row.replaceChildren(sel);
    }
    draw();
    return el('div', { class: 'field' }, el('span', null, cf.name), row);
  }

  /**
   * Chosen values as tags, plus a drop-down of remembered ones and a "New…" option to type
   * one. kind is 'glaze' or 'clay' (new clays also get a cone).
   * Returns { flush() } to add anything typed but not yet added, and newCones for new clays.
   */
  function tagPicker(box, values, kind) {
    const noun = kind === 'clay' ? 'clay body' : 'glaze';
    const known = () => (kind === 'clay' ? Settings.clays().map((c) => c.name) : Settings.glazes());
    const newCones = {};
    const tags = el('div', { class: 'tags' });
    const row = el('div', { class: 'pick-row' });
    let typing = false;
    const has = (v) => values.some((x) => x.toLowerCase() === v.toLowerCase());
    function add(v, cone) {
      v = String(v || '').trim().slice(0, 120);
      if (!v || has(v)) return;
      values.push(v);
      if (kind === 'clay' && cone !== undefined && !Settings.clay(v)) newCones[v] = cone;
    }
    function drawTags() {
      tags.replaceChildren(...values.map((v, i) => el('span', { class: 'tag' }, v,
        kind === 'clay' && (Settings.clay(v) || {}).cone ? el('span', { class: 'cone-note' }, 'cone ' + Settings.clay(v).cone)
          : kind === 'clay' && newCones[v] ? el('span', { class: 'cone-note' }, 'cone ' + newCones[v]) : null,
        el('button', { type: 'button', 'aria-label': 'Remove ' + v, html: ICON_X, onclick: () => { values.splice(i, 1); draw(); } }))));
    }
    function drawRow() {
      if (typing) {
        const input = el('input', { maxlength: '120', autocomplete: 'off', placeholder: 'New ' + noun + ' name', 'aria-label': 'New ' + noun + ' name' });
        const cone = kind === 'clay' ? el('select', { class: 'cone', 'aria-label': 'Cone for this clay' }, coneOptions('', 'Cone')) : null;
        const commit = () => { add(input.value, cone ? cone.value : undefined); typing = false; draw(); };
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } if (e.key === 'Escape') { typing = false; draw(); } });
        row.replaceChildren(...[input, cone].filter(Boolean), el('button', { type: 'button', class: 'btn btn-secondary btn-small', onclick: commit }, 'Add'));
        row.flush = () => { if (input.value.trim()) add(input.value, cone ? cone.value : undefined); };
        input.focus();
        return;
      }
      row.flush = () => {};
      const options = known().filter((v) => !has(v)).sort((a, b) => a.localeCompare(b));
      const sel = el('select', { 'aria-label': 'Add a ' + noun },
        el('option', { value: '' }, values.length ? 'Add another ' + noun + '…' : 'Choose a ' + noun + '…'),
        options.map((v) => el('option', { value: v }, kind === 'clay' ? clayLabel(v) : v)),
        el('option', { value: '__new' }, '+ New ' + noun + '…'));
      sel.addEventListener('change', () => {
        if (sel.value === '__new') typing = true; else if (sel.value) add(sel.value);
        draw();
      });
      row.replaceChildren(sel);
    }
    function draw() { drawTags(); drawRow(); }
    box.replaceChildren(tags, row);
    draw();
    return { flush: () => row.flush(), newCones };
  }

  /* ---------- field values (built-in and custom), for filters and display ---------- */

  function filterDefs() {
    return [...Settings.BUILTIN_FILTERS.map((b) => ({ ...b, builtin: true })), ...Settings.fields()];
  }

  /** The value(s) of a field on a piece, as display strings. */
  function fieldValues(p, id) {
    if (id === 'glazes') return p.glazes || [];
    if (id === 'method') return p.method ? [METHOD_LABEL[p.method] || p.method] : [];
    if (id === 'clayBody') return claysOf(p);
    if (id === 'bisqueCone' || id === 'glazeCone') { const c = firingsOf(p)[id]; return c ? [coneLabel(c)] : []; }
    if (id === 'bisqueFiringType' || id === 'glazeFiringType') { const t = firingsOf(p)[id]; return t ? [t] : []; }
    const f = Settings.field(id);
    const v = f ? Settings.format(f, (p.custom || {})[id]) : '';
    return v ? [v] : [];
  }

  function sortValues(def, values) {
    const f = def.builtin ? null : def;
    if (def.id === 'bisqueCone' || def.id === 'glazeCone') return values.sort((a, b) => CONES.indexOf(a.slice(5)) - CONES.indexOf(b.slice(5)));
    if (f && f.type === 'number') return values.sort((a, b) => Number(a) - Number(b));
    if (f && f.type === 'date') return values.sort().reverse();
    if (f && f.type === 'choice') return values.sort((a, b) => (f.options.indexOf(a) + 1 || 999) - (f.options.indexOf(b) + 1 || 999) || a.localeCompare(b));
    return values.sort((a, b) => a.localeCompare(b));
  }

  /* ---------- list view ---------- */

  async function renderList() {
    setChrome({ title: 'Pottery Log', back: false, fab: true });
    mount('tpl-list');
    const view = app.firstElementChild;
    const pieces = (await DB.allPieces()).filter((p) => !p.deleted);
    if (!view.isConnected) return; // moved on while reading
    pieces.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

    let filter = store(FILTER_KEY) || 'all';
    let fieldFilter = store(FIELD_FILTER_KEY) || {}; // { fieldId: value }
    let query = '';
    const chipsEl = $('#stageFilter');
    const listEl = $('#cardList');
    const searchEl = $('#searchInput');

    const counts = { all: pieces.length };
    STAGES.forEach((s) => { counts[s.id] = pieces.filter((p) => p.stage === s.id).length; });

    function drawChips() {
      chipsEl.replaceChildren(...[{ id: 'all', label: 'All' }, ...STAGES].map((s) =>
        el('button', {
          class: 'chip', role: 'tab', 'aria-selected': String(filter === s.id),
          onclick: () => { filter = s.id; store(FILTER_KEY, filter); drawChips(); drawCards(); },
        }, s.label, el('span', { class: 'n' }, String(counts[s.id])))));
    }

    function matches(p) {
      if (filter !== 'all' && p.stage !== filter) return false;
      for (const id of Settings.filters()) {
        const want = fieldFilter[id];
        if (want && !fieldValues(p, id).includes(want)) return false;
      }
      if (!query) return true;
      const hay = [p.title, claysOf(p).join(' '), METHOD_LABEL[p.method], (p.glazes || []).join(' '),
        ...['bisqueFiringType', 'bisqueCone', 'glazeFiringType', 'glazeCone'].flatMap((id) => fieldValues(p, id)), p.notes, ...Settings.fields().flatMap((f) => fieldValues(p, f.id))].join(' ').toLowerCase();
      return query.split(/\s+/).every((w) => hay.includes(w));
    }

    function drawCards() {
      const shown = pieces.filter(matches);
      $('#emptyState').hidden = pieces.length > 0;
      $('#countLabel').hidden = pieces.length === 0;
      $('#countLabel').textContent = shown.length === pieces.length
        ? pieces.length + (pieces.length === 1 ? ' piece' : ' pieces')
        : shown.length + ' of ' + pieces.length + ' pieces';
      listEl.replaceChildren(...shown.map((p) => {
        const thumb = el('div', { class: 'thumb', html: ICON_POT });
        if (p.photoIds && p.photoIds[0]) {
          piecePhotoUrl(p, p.photoIds[0]).then((u) => { if (u) thumb.replaceChildren(el('img', { src: u, alt: '', loading: 'lazy' })); });
        }
        const sub = [claysOf(p).join(', '), (p.glazes || []).join(', ')].filter(Boolean).join(' · ') || METHOD_LABEL[p.method] || '';
        return el('li', null, el('button', { class: 'card', onclick: () => nav('#/piece/' + encodeURIComponent(p.id)) },
          thumb,
          el('div', { class: 'meta' },
            el('div', { class: 'title' }, p.title || 'Untitled'),
            sub ? el('div', { class: 'sub' }, sub) : null,
            stagePill(p.stage))));
      }));
    }

    // One drop-down per chosen field, listing the values your pieces actually have.
    function drawFieldFilters() {
      const box = $('#fieldFilters');
      const defs = filterDefs();
      const chosen = Settings.filters().map((id) => defs.find((d) => d.id === id)).filter(Boolean);
      // forget values that no longer exist (e.g. a field was removed)
      fieldFilter = Object.fromEntries(Object.entries(fieldFilter).filter(([id]) => chosen.some((d) => d.id === id)));
      const active = Object.values(fieldFilter).filter(Boolean).length;
      $('#filterBadge').hidden = !chosen.length;
      $('#filterBadge').textContent = String(chosen.length);
      box.hidden = !chosen.length;
      box.replaceChildren(...chosen.map((d) => {
        const values = sortValues(d, [...new Set(pieces.flatMap((p) => fieldValues(p, d.id)))]);
        const cur = fieldFilter[d.id] || '';
        if (cur && !values.includes(cur)) values.unshift(cur);
        const sel = el('select', { 'aria-label': 'Filter by ' + d.name, class: cur ? 'active' : '' },
          el('option', { value: '' }, d.name + ': any'),
          values.map((v) => el('option', { value: v }, d.name + ': ' + v)));
        sel.value = cur;
        sel.addEventListener('change', () => {
          if (sel.value) fieldFilter[d.id] = sel.value; else delete fieldFilter[d.id];
          store(FIELD_FILTER_KEY, fieldFilter);
          drawFieldFilters(); drawCards();
        });
        return sel;
      }), active ? el('button', {
        class: 'clear', type: 'button',
        onclick: () => { fieldFilter = {}; store(FIELD_FILTER_KEY, null); drawFieldFilters(); drawCards(); },
      }, 'Clear') : '');
    }

    // Pop-up for choosing which fields appear as filters.
    const dialog = $('#filterDialog');
    $('#filterBtn').addEventListener('click', () => {
      const chosen = new Set(Settings.filters());
      const row = (d) => el('label', null,
        el('input', { type: 'checkbox', value: d.id, checked: chosen.has(d.id) }),
        el('span', null, d.name),
        d.builtin ? null : el('span', { class: 'type' }, Settings.TYPES[d.type]));
      const custom = Settings.fields();
      $('#filterChoices').replaceChildren(
        el('h3', null, 'Pottery details'), ...Settings.BUILTIN_FILTERS.map((b) => row({ ...b, builtin: true })),
        custom.length ? el('h3', null, 'Your fields') : '', ...custom.map(row));
      $('#filterNoCustom').hidden = custom.length > 0;
      if (dialog.showModal) dialog.showModal(); else dialog.setAttribute('open', '');
    });
    $('#filterNoCustom a').addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => {
      const picked = [...dialog.querySelectorAll('#filterChoices input:checked')].map((i) => i.value);
      const order = filterDefs().map((d) => d.id);
      picked.sort((a, b) => order.indexOf(a) - order.indexOf(b));
      if (picked.join() !== Settings.filters().join()) {
        Settings.update({ filters: picked });
        markChanged();
      }
      drawFieldFilters(); drawCards();
    });

    searchEl.addEventListener('input', () => { query = searchEl.value.trim().toLowerCase(); drawCards(); });
    drawInstallTip();
    drawChips();
    drawFieldFilters();
    drawCards();
  }

  /* ---------- detail view ---------- */

  async function renderDetail(id) {
    const p = await DB.getPiece(id);
    if (!p || p.deleted) { toast('That piece was not found.'); return nav('#/', true); }
    setChrome({ title: p.title || 'Untitled', back: true, fab: false });
    mount('tpl-detail');
    const here = location.hash;

    // A piece synced from another device shows its summary first; notes and photos load now.
    if (p.stub) {
      const note = el('p', { class: 'muted small loading-note' }, 'Loading notes and photos from Google Drive…');
      $('#dTitle').after(note);
      loadOnDemand(p.id).then(() => { if (location.hash === here) route(); }).catch((err) => {
        note.textContent = err.reconnect ? 'Tap Reconnect at the top to see this piece\'s notes and photos.'
          : !navigator.onLine ? 'You\'re offline. Notes and photos will load when you\'re back online.'
          : 'Could not load this piece from Google Drive: ' + err.message;
      });
    }

    const gallery = $('#gallery');
    const ids = p.photoIds || [];
    if (!ids.length || p.stub) {
      gallery.replaceChildren(el('div', { class: 'no-photo', html: ICON_POT }));
    } else {
      gallery.classList.toggle('single', ids.length === 1);
      const imgs = await Promise.all(ids.map(async (pid) => {
        const u = await piecePhotoUrl(p, pid, 'full');
        return u ? el('img', { src: u, alt: p.title || 'Photo', onclick: () => lightbox(u) }) : null;
      }));
      gallery.replaceChildren(...imgs.filter(Boolean));
      if (ids.length > 1) {
        const dots = el('div', { class: 'gallery-dots' }, ids.map((_, i) => el('span', { class: i === 0 ? 'on' : '' })));
        gallery.after(dots);
        gallery.addEventListener('scroll', () => {
          const i = Math.round(gallery.scrollLeft / gallery.clientWidth);
          [...dots.children].forEach((d, j) => d.classList.toggle('on', i === j));
        }, { passive: true });
      }
    }

    $('#dTitle').textContent = p.title || 'Untitled';
    $('#dStage').replaceWith(stagePill(p.stage));

    const idx = Math.max(0, STAGES.findIndex((s) => s.id === p.stage));
    $('#dTrack').replaceChildren(...STAGES.map((s, i) =>
      el('li', { class: (i <= idx ? 'reached' : '') + (i === idx ? ' current' : ''), 'aria-current': i === idx ? 'step' : null }, s.label)));

    const next = STAGES[idx + 1];
    const adv = $('#advanceBtn');
    if (next && !p.stub) {
      adv.hidden = false;
      adv.textContent = 'Mark as ' + next.label.toLowerCase();
      adv.onclick = async () => {
        p.stage = next.id;
        if (!p[next.date]) p[next.date] = today();
        p.updatedAt = Date.now();
        await DB.putPiece(p);
        markChanged();
        toast('Moved to ' + next.label);
        route();
      };
    }

    const facts = [];
    const add = (k, v) => { if (v) facts.push(el('dt', null, k), el('dd', null, v)); };
    const clays = claysOf(p);
    if (clays.length) add(clays.length > 1 ? 'Clay bodies' : 'Clay body', clays.map(clayLabel).join(', '));
    add('Forming', METHOD_LABEL[p.method]);
    if (p.glazes && p.glazes.length) add('Glazes', el('div', { class: 'glaze-list' }, p.glazes.map((g) => el('span', null, g))));
    const fire = firingsOf(p);
    add('Bisque firing', [fire.bisqueFiringType, coneLabel(fire.bisqueCone)].filter(Boolean).join(', '));
    add('Glaze firing', [fire.glazeFiringType, coneLabel(fire.glazeCone)].filter(Boolean).join(', '));
    add('Made', fmtDate(p.dateMade));
    add('Bisque fired', fmtDate(p.dateBisque));
    add('Glaze fired', fmtDate(p.dateGlazed));
    add('Finished', fmtDate(p.dateDone));
    for (const f of Settings.fields()) {
      const v = (p.custom || {})[f.id];
      add(f.name, f.type === 'date' ? fmtDate(v) : Settings.format(f, v));
    }
    const factsEl = $('#dFacts');
    if (facts.length) factsEl.replaceChildren(...facts); else factsEl.hidden = true;

    if (p.notes) { $('#dNotesWrap').hidden = false; $('#dNotes').textContent = p.notes; }

    $('#editBtn').hidden = !!p.stub;
    $('#editBtn').onclick = () => nav('#/edit/' + encodeURIComponent(p.id));
    $('#deleteBtn').onclick = async () => {
      const inDrive = p.sync && p.sync.folderId;
      if (!confirm('Delete "' + (p.title || 'Untitled') + '" and its photos?' +
        (inDrive ? ' Its folder in Google Drive will be moved to the trash.' : ' This cannot be undone.'))) return;
      await DB.deletePiece(p.id);
      // Remember the delete so other devices delete it too.
      if (p.sync) await DB.putPiece({ id: p.id, title: p.title, deleted: true, updatedAt: Date.now(), sync: p.sync });
      markChanged();
      toast('Piece deleted');
      nav('#/', true);
    };
  }

  function lightbox(url) {
    const box = el('div', { class: 'lightbox', role: 'dialog', 'aria-label': 'Photo' },
      el('img', { src: url, alt: '' }),
      el('button', { class: 'icon-btn', 'aria-label': 'Close', html: ICON_X }));
    const close = () => { box.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    box.addEventListener('click', close);
    document.addEventListener('keydown', onKey);
    document.body.append(box);
  }

  /* ---------- edit / new view ---------- */

  async function renderEdit(id) {
    const existing = id ? await DB.getPiece(id) : null;
    if (id && (!existing || existing.deleted)) { toast('That piece was not found.'); return nav('#/', true); }
    if (existing && existing.stub) { // synced from another device: load its details first
      setChrome({ title: 'Edit piece', back: true, fab: false });
      app.replaceChildren(el('p', { class: 'muted center loading-note' }, 'Loading from Google Drive…'));
      const here = location.hash;
      return loadOnDemand(id).then(() => { if (location.hash === here) route(); }).catch((err) => {
        toast(err.reconnect ? 'Reconnect Google Drive to edit this piece.' : !navigator.onLine ? 'You\'re offline. This piece will load when you\'re back online.' : err.message, 4000);
        nav('#/piece/' + encodeURIComponent(id), true);
      });
    }
    const isNew = !existing;
    const piece = existing ? structuredClone(existing) : {
      id: DB.uid(), title: '', photoIds: [], clays: [], method: 'wheel', glazes: [],
      bisqueFiringType: '', bisqueCone: '', glazeFiringType: '', glazeCone: '', stage: 'greenware', dateMade: today(), dateBisque: '', dateGlazed: '',
      dateDone: '', notes: '', createdAt: Date.now(),
    };
    const originalPhotos = new Set(existing ? existing.photoIds || [] : []);
    const addedPhotos = new Set();
    let saved = false;

    setChrome({ title: isNew ? 'New piece' : 'Edit piece', back: true, fab: false });
    mount('tpl-edit');
    const form = $('#editForm');
    const f = form.elements;

    const all = (await DB.allPieces()).filter((p) => !p.deleted);
    piece.clays = [...claysOf(piece)];
    delete piece.clayBody;
    piece.glazes = [...(piece.glazes || [])];
    const hadNames = new Set([...piece.clays, ...piece.glazes].map((v) => v.toLowerCase())); // removed from a list stays removed
    const clayPick = tagPicker($('#clayPicker'), piece.clays, 'clay');
    const glazePick = tagPicker($('#glazePicker'), piece.glazes, 'glaze');

    // Bisque and glaze firing: the same two drop-downs in each section.
    Object.assign(piece, firingsOf(piece));
    delete piece.firingType; delete piece.cone;
    for (const k of ['bisque', 'glaze']) {
      f[k + 'FiringType'].append(...FIRING_TYPES.map((t) => el('option', null, t)));
      f[k + 'Cone'].append(...CONES.map((c) => el('option', { value: c }, 'Cone ' + c)));
    }

    // Stage segmented control.
    $('#stageSeg').replaceChildren(...STAGES.map((s) =>
      el('label', null, el('input', { type: 'radio', name: 'stage', value: s.id }), el('span', null, s.label))));

    // Fill values.
    f.title.value = piece.title;
    form.querySelectorAll('input[name=method]').forEach((r) => { r.checked = r.value === piece.method; });
    for (const k of ['bisqueFiringType', 'glazeFiringType']) {
      f[k].value = piece[k];
      if (piece[k] && f[k].value !== piece[k]) { f[k].append(el('option', null, piece[k])); f[k].value = piece[k]; }
    }
    f.bisqueCone.value = piece.bisqueCone;
    f.glazeCone.value = piece.glazeCone;
    form.querySelectorAll('input[name=stage]').forEach((r) => { r.checked = r.value === piece.stage; });
    ['dateMade', 'dateBisque', 'dateGlazed', 'dateDone'].forEach((k) => { f[k].value = piece[k] || ''; });
    f.notes.value = piece.notes;

    // Custom fields.
    const custom = { ...(piece.custom || {}) };
    $('#customFields').replaceChildren(...Settings.fields().map((cf) => {
      const name = 'cf:' + cf.id;
      const v = custom[cf.id];
      if (cf.type === 'yesno') {
        return el('div', { class: 'field' }, el('span', null, cf.name),
          el('label', { class: 'yesno' }, el('input', { type: 'checkbox', name, checked: v === true }), el('b', null, 'Yes')));
      }
      let input;
      if (cf.type === 'choice') {
        const opts = [...cf.options];
        if (v && !opts.includes(v)) opts.push(v); // keep a value that was removed from the list
        input = el('select', { name }, el('option', { value: '' }, '—'), opts.map((o) => el('option', { value: o }, o)));
      } else if (cf.type === 'text' && cf.remember) {
        return valuePicker(cf, typeof v === 'string' ? v : '', name);
      } else if (cf.type === 'text') {
        const listId = 'dl-' + cf.id;
        input = el('input', { name, maxlength: '200', autocomplete: 'off', list: listId, value: typeof v === 'string' ? v : null });
        const seen = [...new Set(all.map((p) => (p.custom || {})[cf.id]).filter((x) => typeof x === 'string' && x))].sort();
        return el('label', { class: 'field' }, el('span', null, cf.name), input,
          el('datalist', { id: listId }, seen.map((x) => el('option', { value: x }))));
      } else {
        input = el('input', { name, type: cf.type === 'number' ? 'number' : 'date', step: cf.type === 'number' ? 'any' : null, inputmode: cf.type === 'number' ? 'decimal' : null });
      }
      if (v !== undefined && v !== null) input.value = String(v);
      return el('label', { class: 'field' }, el('span', null, cf.name), input);
    }));

    // Stage change fills in that stage's date if empty.
    form.querySelectorAll('input[name=stage]').forEach((r) => r.addEventListener('change', () => {
      const s = STAGE_BY_ID[r.value];
      if (s && !f[s.date].value) f[s.date].value = today();
    }));

    // Photos.
    const grid = $('#photoGrid');
    async function drawPhotos() {
      const items = await Promise.all(piece.photoIds.map(async (pid, i) => {
        const u = await piecePhotoUrl(piece, pid);
        return el('div', { class: 'photo-item' },
          u ? el('img', { src: u, alt: 'Photo ' + (i + 1) }) : null,
          i === 0 && piece.photoIds.length > 1 ? el('span', { class: 'cover' }, 'Cover') : null,
          el('button', {
            type: 'button', class: 'remove', 'aria-label': 'Remove photo', html: ICON_X,
            onclick: () => { piece.photoIds.splice(i, 1); drawPhotos(); },
          }));
      }));
      grid.replaceChildren(...items);
    }
    $('#photoInput').addEventListener('change', async (e) => {
      const files = [...e.target.files];
      e.target.value = '';
      for (const file of files) {
        const ph = el('div', { class: 'photo-item pending' }, 'Adding…');
        grid.append(ph);
        try {
          const { blob, thumb } = await processPhoto(file);
          const pid = DB.uid();
          await DB.putPhoto({ id: pid, blob, thumb, type: blob.type, addedAt: Date.now() });
          addedPhotos.add(pid);
          piece.photoIds.push(pid);
        } catch (err) {
          toast(err.message || 'Could not add that photo.');
        }
      }
      drawPhotos();
    });
    drawPhotos();

    // Cleanup of unsaved new photos when leaving without saving.
    const onLeave = () => {
      window.removeEventListener('hashchange', onLeave);
      if (!saved && addedPhotos.size) DB.deletePhotos([...addedPhotos]);
    };
    window.addEventListener('hashchange', onLeave);

    $('#cancelBtn').addEventListener('click', () => backBtn.click());

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      clayPick.flush(); glazePick.flush();
      const title = f.title.value.trim();
      if (!title) { toast('Give the piece a title'); f.title.focus(); return; }
      piece.title = title;
      piece.method = (form.querySelector('input[name=method]:checked') || {}).value || '';
      for (const k of ['bisqueFiringType', 'bisqueCone', 'glazeFiringType', 'glazeCone']) piece[k] = f[k].value;
      piece.stage = (form.querySelector('input[name=stage]:checked') || {}).value || 'greenware';
      ['dateMade', 'dateBisque', 'dateGlazed', 'dateDone'].forEach((k) => { piece[k] = f[k].value; });
      piece.notes = f.notes.value.trim();
      for (const cf of Settings.fields()) {
        const input = form.elements['cf:' + cf.id];
        if (!input) continue;
        const v = cf.type === 'yesno' ? input.checked : Settings.coerce(cf, input.value.trim());
        if (v === '' || (cf.type === 'yesno' && !v && custom[cf.id] === undefined)) delete custom[cf.id];
        else custom[cf.id] = v;
      }
      // Remember values newly typed into remembered text fields (one taken off a list stays off).
      const before = piece.custom || {};
      Settings.learnValues(Object.fromEntries(Object.entries(custom).filter(([id, v]) => v !== before[id])));
      piece.custom = custom;
      // Remember new glazes and clays for the drop-downs (synced with the other settings).
      const isNew = (v) => !hadNames.has(v.toLowerCase());
      Settings.learn({ glazes: piece.glazes.filter(isNew), clays: piece.clays.filter(isNew).map((name) => ({ name, cone: clayPick.newCones[name] || '' })) });
      piece.updatedAt = Date.now();
      await DB.putPiece(piece);
      saved = true;
      const kept = new Set(piece.photoIds);
      const removed = [...originalPhotos, ...addedPhotos].filter((pid) => !kept.has(pid));
      await DB.deletePhotos(removed);
      markChanged();
      toast((isNew ? 'Piece added' : 'Saved') + (!navigator.onLine && connected() ? '. It will sync when you\'re back online.' : ''), !navigator.onLine ? 3000 : undefined);
      DB.requestPersistence();
      if (isNew) nav('#/piece/' + encodeURIComponent(piece.id), true);
      else backBtn.click();
    });

    if (isNew) f.title.focus();
  }

  /* ---------- backup view ---------- */

  async function renderBackup() {
    setChrome({ title: 'Settings', back: true, fab: false });
    mount('tpl-backup');
    const view = app.firstElementChild;

    const pieces = (await DB.allPieces()).filter((p) => !p.deleted);
    const photoIds = await DB.allPhotoIds();
    const est = await DB.estimate();
    if (!view.isConnected) return; // left Settings while reading
    const stubs = pieces.filter((p) => p.stub).length;
    $('#localStats').textContent = pieces.length + (pieces.length === 1 ? ' piece' : ' pieces') + ', ' +
      photoIds.length + (photoIds.length === 1 ? ' photo' : ' photos') +
      (est && est.usage ? ' · about ' + fmtBytes(est.usage) + ' used' : '') +
      (stubs ? '. ' + stubs + ' synced ' + (stubs === 1 ? 'piece loads its' : 'pieces load their') + ' notes and photos when opened.' : '');
    const persisted = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted().catch(() => false) : false;
    if (!view.isConnected) return;
    const how = installHowTo();
    if (persisted) $('#persistLabel').textContent = 'Storage is marked persistent, so the browser won\'t clear it on its own.';
    else if (how) $('#persistLabel').innerHTML = 'Add the app to your home screen so the browser is less likely to clear its storage. ' + how;
    else if (!isInstalled()) $('#persistLabel').textContent = 'Tip: install the app (or add it to your home screen) so the browser is less likely to clear its storage.';
    else $('#persistLabel').hidden = true;

    function draw() {
      $('#driveUnconfigured').hidden = Drive.configured;
      $('#driveSignedOut').hidden = !Drive.configured || Drive.isSignedIn();
      const reconnect = Drive.needsReconnect();
      $('#reconnectNote').hidden = !reconnect;
      $('#signInLabel').textContent = reconnect ? 'Reconnect Google Drive' : 'Sign in with Google';
      $('#driveSignedIn').hidden = !Drive.configured || !Drive.isSignedIn();
      const acct = Drive.getAccount();
      if (acct) $('#accountLabel').textContent = 'Signed in as ' + (acct.email || acct.name || 'Google user');
      const folder = Drive.getFolder();
      $('#folderLabel').textContent = folder ? folder.name : 'Not chosen yet';
      $('#pickFolderBtn').textContent = folder ? 'Change folder' : 'Choose folder';
      const last = store(LAST_SYNC_KEY);
      let label = syncing ? 'Syncing…'
        : last && folder && last.root === folder.id ? 'Last synced: ' + fmtDateTime(last.at) + '.' : 'Not synced yet from this device.';
      if (!syncing && pendingCount) label += ' ' + pendingCount + (pendingCount === 1 ? ' change is' : ' changes are') + ' waiting to sync.';
      $('#lastSyncLabel').textContent = label;
      updateBadge();
    }
    draw();

    const progress = $('#driveProgress');
    const bar = $('#driveProgressBar');
    const ptext = $('#driveProgressText');
    const buttons = ['#syncBtn', '#signOutBtn', '#pickFolderBtn', '#newFolderBtn'].map((s) => $(s));
    function busy(on, text, frac) {
      buttons.forEach((b) => { b.disabled = on; });
      progress.hidden = !on;
      if (on) { ptext.textContent = text || ''; bar.style.width = Math.round((frac || 0) * 100) + '%'; }
    }

    // Redraw when a background sync finishes while this page is open.
    onBackupStateChange = draw;

    $('#signInBtn').addEventListener('click', () => Drive.signIn());

    // Custom fields.
    const fieldMeta = (f) => Settings.TYPES[f.type] +
      (f.type === 'choice' ? ': ' + f.options.join(', ')
        : f.type === 'text' && f.remember ? ', remembered' + (f.values.length ? ': ' + f.values.join(', ') : '') : '');
    function drawCustomFields() {
      const fields = Settings.fields();
      $('#cfList').replaceChildren(...fields.map((f) => {
        const li = el('li', null,
          el('span', { class: 'cf-name' }, f.name),
          el('span', { class: 'cf-meta' }, fieldMeta(f)),
          el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Edit ' + f.name, html: ICON_EDIT, onclick: () => editField(li, f) }),
          el('button', {
            class: 'icon-btn', type: 'button', 'aria-label': 'Remove ' + f.name, html: ICON_X,
            onclick: () => {
              if (!confirm('Remove the field “' + f.name + '”? It disappears from every piece, here and on your other devices, and is left out of piece.json from then on.')) return;
              Settings.removeField(f.id);
              drawCustomFields();
              markChanged();
            },
          }));
        return li;
      }));
      $('#cfList').hidden = !fields.length;
    }
    // Edit a field in place: name, type, "remember values", and its list (choices or remembered values).
    function editField(li, f) {
      const name = el('input', { maxlength: '60', value: f.name, autocomplete: 'off' });
      const type = el('select', null, Object.entries(Settings.TYPES).map(([v, label]) => el('option', { value: v, selected: v === f.type }, label)));
      const remember = el('input', { type: 'checkbox', checked: f.type !== 'text' || f.remember !== false });
      const rememberRow = el('label', { class: 'yesno' }, remember, el('b', null, 'Remember values for a drop-down'));
      const list = el('textarea', { rows: '4' });
      list.value = (f.type === 'choice' ? f.options : f.values || []).join('\n');
      const listLabel = el('span');
      const listRow = el('label', { class: 'field' }, listLabel, list);
      function sync() {
        const t = type.value;
        if (t === 'text' && type.dataset.was === 'choice') remember.checked = true; // choices become remembered values
        type.dataset.was = t;
        rememberRow.hidden = t !== 'text';
        listRow.hidden = !(t === 'choice' || (t === 'text' && remember.checked));
        listLabel.textContent = t === 'choice' ? 'Choices, one per line' : 'Remembered values, one per line';
      }
      type.dataset.was = f.type;
      type.addEventListener('change', sync); remember.addEventListener('change', sync);
      sync();
      const save = (e) => {
        e.preventDefault();
        try {
          Settings.editField(f.id, { name: name.value, type: type.value, remember: remember.checked, list: list.value.split('\n') });
          drawCustomFields(); markChanged();
          toast('Saved “' + name.value.trim() + '”');
        } catch (err) { toast(err.message); }
      };
      const form = el('form', { class: 'cf-edit' },
        el('div', { class: 'field-row' },
          el('label', { class: 'field' }, el('span', null, 'Field name'), name),
          el('label', { class: 'field' }, el('span', null, 'Type'), type)),
        el('div', { class: 'field' }, rememberRow), listRow,
        el('div', { class: 'cf-edit-actions' },
          el('button', { type: 'submit', class: 'btn btn-secondary btn-small' }, 'Save'),
          el('button', { type: 'button', class: 'btn btn-ghost btn-small', onclick: drawCustomFields }, 'Cancel')));
      form.addEventListener('submit', save);
      li.classList.add('editing');
      li.replaceChildren(form);
      name.focus();
    }
    $('#cfType').replaceChildren(...Object.entries(Settings.TYPES).map(([v, label]) => el('option', { value: v }, label)));
    const syncAddForm = () => { $('#cfOptionsRow').hidden = $('#cfType').value !== 'choice'; $('#cfRememberRow').hidden = $('#cfType').value !== 'text'; };
    $('#cfType').addEventListener('change', syncAddForm);
    syncAddForm();
    $('#cfAddForm').addEventListener('submit', (e) => {
      e.preventDefault();
      try {
        const type = $('#cfType').value;
        const f = Settings.addField($('#cfName').value, type, type === 'choice' ? $('#cfOptions').value.split(',') : [], $('#cfRemember').checked);
        $('#cfName').value = ''; $('#cfOptions').value = '';
        drawCustomFields();
        markChanged();
        toast('Added “' + f.name + '” to every piece');
      } catch (err) {
        toast(err.message);
      }
    });
    drawCustomFields();

    // Glaze and clay lists.
    function drawLists() {
      const clays = Settings.clays();
      $('#clayListEdit').replaceChildren(...clays.map((c, i) => {
        const cone = el('select', { 'aria-label': 'Cone for ' + c.name }, coneOptions(c.cone));
        cone.addEventListener('change', () => {
          Settings.setClays(clays.map((x, j) => (j === i ? { ...x, cone: cone.value } : x)));
          markChanged();
        });
        return el('li', null, el('span', { class: 'cf-name' }, c.name), el('span', { class: 'cf-meta' }), cone,
          el('button', {
            class: 'icon-btn', type: 'button', 'aria-label': 'Remove ' + c.name, html: ICON_X,
            onclick: () => { Settings.setClays(clays.filter((_, j) => j !== i)); drawLists(); markChanged(); },
          }));
      }));
      const glazes = Settings.glazes();
      $('#glazeListEdit').replaceChildren(...glazes.map((g, i) => el('li', null,
        el('span', { class: 'cf-name' }, g), el('span', { class: 'cf-meta' }),
        el('button', {
          class: 'icon-btn', type: 'button', 'aria-label': 'Remove ' + g, html: ICON_X,
          onclick: () => { Settings.setGlazes(glazes.filter((_, j) => j !== i)); drawLists(); markChanged(); },
        }))));
      $('#clayListEdit').hidden = !clays.length;
      $('#glazeListEdit').hidden = !glazes.length;
    }
    $('#clayAddCone').replaceChildren(...coneOptions('', 'Cone'));
    $('#clayAddForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const name = $('#clayAddName').value.trim();
      if (!name) return;
      if (Settings.clay(name)) { toast('“' + name + '” is already in the list'); return; }
      Settings.setClays([...Settings.clays(), { name, cone: $('#clayAddCone').value }]);
      $('#clayAddName').value = ''; $('#clayAddCone').value = '';
      drawLists(); markChanged();
    });
    $('#glazeAddForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const name = $('#glazeAddName').value.trim();
      if (!name) return;
      if (!Settings.learn({ glazes: [name] })) { toast('“' + name + '” is already in the list'); return; }
      $('#glazeAddName').value = '';
      drawLists(); markChanged();
    });
    drawLists();
    onBackupStateChange = () => { draw(); if (!$('#cfList .editing')) drawCustomFields(); drawLists(); }; // keep an open field editor

    // Check the saved folder still exists, and offer Pottery Log folders already in Drive
    // (works without the picker, e.g. on a new device or in browsers that block it).
    if (Drive.configured && Drive.isSignedIn()) {
      Drive.resolveFolder().then(draw).catch((err) => { if (err.reconnect) draw(); });
      Drive.findLibraries().then((libs) => {
        const cur = Drive.getFolder();
        const others = libs.filter((f) => !cur || f.id !== cur.id);
        if (!others.length || !$('#foundFolders')) return;
        $('#foundFolderBtns').replaceChildren(...others.map((f) => el('button', {
          class: 'btn btn-secondary btn-small', type: 'button',
          onclick: () => { Drive.useFolder(f); $('#foundFolders').hidden = true; draw(); afterFolderChange(f.name, 'Syncing with'); },
        }, f.name)));
        $('#foundFolders').hidden = false;
      }).catch(() => {});
    }

    async function afterFolderChange(name, verb) {
      await refreshPending();
      draw();
      toast(verb + ' “' + name + '”. Syncing…');
      runSync({ quiet: false });
    }

    $('#pickFolderBtn').addEventListener('click', async () => {
      try {
        $('#pickerHint').hidden = true;
        const f = await Drive.pickFolder();
        if (f) afterFolderChange(f.name, 'Syncing with');
        else $('#pickerHint').hidden = false; // closed without picking: maybe the picker failed
      } catch (err) {
        draw();
        toast(err.message, 4000);
      }
    });

    const newForm = $('#newFolderForm');
    $('#newFolderBtn').addEventListener('click', () => {
      newForm.hidden = !newForm.hidden;
      if (!newForm.hidden) { $('#newFolderName').focus(); $('#newFolderName').select(); }
    });
    $('#newFolderCancel').addEventListener('click', () => { newForm.hidden = true; });
    newForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = $('#newFolderName').value.trim();
      if (!name) { toast('Give the folder a name'); return; }
      try {
        busy(true, 'Creating folder…', 0.5);
        const f = await Drive.createFolder(name);
        busy(false);
        newForm.hidden = true;
        afterFolderChange(f.name, 'Created');
      } catch (err) {
        busy(false);
        draw();
        toast(err.message, 4000);
      }
    });

    $('#signOutBtn').addEventListener('click', async () => {
      if (!confirm('Disconnect Google Drive? Your files stay in Drive and your pieces stay on this device. Pieces from Drive that haven\'t been opened here yet will show only their summary until you reconnect.')) return;
      busy(true, 'Disconnecting…', 0.5);
      const { revoked } = await Drive.disconnect();
      busy(false);
      draw();
      toast(revoked ? 'Disconnected from Google Drive'
        : 'Disconnected on this device. Google could not be reached, so also remove access at myaccount.google.com/connections.', revoked ? 2600 : 7000);
    });

    $('#syncBtn').addEventListener('click', async () => {
      try {
        const stats = await runSync({ quiet: true, throws: true, onProgress: (t) => busy(true, t, 0.5) });
        busy(false);
        draw();
        toast(syncSummary(stats) || 'Everything is up to date');
      } catch (err) {
        busy(false);
        draw();
        toast(err.message, 4000);
      }
    });
  }

  const NO_FOLDER = 'Choose or create a Google Drive folder first.';

  /* ---------- sync with Google Drive ---------- */

  let onBackupStateChange = null;
  let syncQueued = false;
  let syncing = false;
  let pendingCount = 0;
  let taskChain = Promise.resolve();

  /** Run Drive tasks one at a time so manual and automatic syncs never overlap. */
  function queueTask(fn) {
    const p = taskChain.then(fn, fn);
    taskChain = p.catch(() => {});
    return p;
  }

  const connected = () => Drive.configured && Drive.isSignedIn();

  async function refreshPending() {
    const f = Drive.getFolder();
    pendingCount = connected() && f ? await Sync.pendingCount(f.id) : 0;
    updateBadge();
  }

  function updateBadge() {
    const pending = Drive.configured && ((Drive.isSignedIn() && pendingCount > 0) || Drive.needsReconnect());
    backupNavBtn.classList.toggle('dirty', pending && !syncing);
    backupNavBtn.classList.toggle('syncing', syncing);
    backupNavBtn.setAttribute('aria-label', syncing ? 'Settings (syncing…)'
      : Drive.needsReconnect() ? 'Settings (Google Drive needs reconnecting)'
      : pending ? 'Settings (changes not synced yet)' : 'Settings');
    // Offline: a calm note that nothing is lost (and that it syncs later, when Drive is connected).
    const offline = !navigator.onLine;
    $('#offlineNote').hidden = !offline;
    $('#offlineNoteText').textContent = Drive.configured && (Drive.isSignedIn() || Drive.needsReconnect())
      ? 'You\'re offline. Everything is saved on this device and will sync when you\'re back online.'
      : 'You\'re offline. Everything is saved on this device.';
    // Lost the Google connection: say so on every screen, with a one-tap fix (not while offline).
    $('#reconnectBar').hidden = offline || !(Drive.configured && Drive.needsReconnect()) || location.hash.startsWith('#/backup');
  }
  window.addEventListener('online', () => updateBadge());
  window.addEventListener('offline', () => updateBadge());
  $('#reconnectBarBtn').addEventListener('click', () => Drive.signIn());

  /** Call after any local change to a piece. */
  function markChanged() {
    refreshPending().then(() => { if (connected() && pendingCount) runSync({ quiet: true }); });
  }

  function syncSummary(st) {
    if (!st) return '';
    const parts = [];
    if (st.pulled) parts.push(st.pulled + (st.pulled === 1 ? ' piece' : ' pieces') + ' updated from Drive');
    if (st.removed) parts.push(st.removed + ' removed');
    if (st.pushed) parts.push(st.pushed + ' saved to Drive');
    if (st.settings === 'pulled') parts.push('fields and filters updated');
    return parts.join(', ');
  }

  /**
   * Sync this device with the Drive folder: pull newer pieces, push local changes.
   * opts.quiet: no toast unless something came from Drive. opts.throws: reject on errors.
   */
  function runSync(opts = {}) {
    if (!connected() || !Drive.getFolder()) {
      return opts.throws ? Promise.reject(new Error(connected() ? NO_FOLDER : 'Sign in to Google Drive first.')) : Promise.resolve(null);
    }
    if (syncQueued && !opts.throws) return Promise.resolve(null); // one already waiting will cover this
    syncQueued = true;
    return queueTask(async () => {
      syncQueued = false;
      syncing = true; updateBadge();
      let stats = null;
      let failed = null;
      try {
        const chosen = await Drive.resolveFolder();
        if (!chosen) throw new Error('The Drive folder was deleted or can\'t be reached. ' + NO_FOLDER);
        stats = await Sync.run(chosen.id, opts.onProgress || (() => {}));
        store(LAST_SYNC_KEY, { at: Date.now(), root: chosen.id });
      } catch (err) {
        failed = err;
      } finally {
        syncing = false;
        await refreshPending().catch(() => {});
        if (onBackupStateChange && location.hash.startsWith('#/backup')) onBackupStateChange();
      }
      if (failed) {
        if (opts.throws) throw failed;
        if (navigator.onLine || failed.reconnect) {
          if (!failed.reconnect) toast('Sync failed: ' + failed.message, 5000); // a lost sign-in shows the Reconnect bar
        }
        return null; // wait for the next save, launch or reconnect instead of retrying in a loop
      }
      if (stats.pulled || stats.removed || stats.settings === 'pulled') {
        if (!opts.throws) toast(syncSummary(stats), 2500);
        // Show what came from Drive, unless a form is being edited.
        if (!/^#\/(edit|new|backup)/.test(location.hash)) route();
      } else if (stats.pushed && !opts.quiet && !opts.throws) {
        toast('Synced with Google Drive', 1600);
      }
      if (await seedLists(true)) await refreshPending();
      if (pendingCount && connected()) runSync({ quiet: true }); // changes made while syncing
      return stats;
    });
  }

  /** First run with glaze/clay lists: remember what existing pieces already use. */
  // Fill the glaze and clay lists from pieces saved before the lists existed. The names are
  // noted once at startup, before anything comes down from Drive, and used quietly so lists
  // already in Drive aren't replaced. After the first sync they're added for real, on top of
  // whatever came down from Drive.
  let seedNames = null;
  function noteSeedNames() {
    if (!seedNames) {
      seedNames = (async () => {
        let names = store('potteryLog.listsSeed');
        if (!names) {
          const ps = (await DB.allPieces()).filter((p) => !p.deleted);
          names = { glazes: ps.flatMap((p) => p.glazes || []), clays: ps.flatMap(claysOf) };
          store('potteryLog.listsSeed', names);
        }
        return names;
      })();
    }
    return seedNames;
  }
  async function seedLists(afterSync) {
    // Starter fields, and "remember values" for text fields made before that option existed.
    const ps = (await DB.allPieces()).filter((p) => !p.deleted);
    const valuesFor = (id) => ps.map((p) => (p.custom || {})[id]).filter((v) => typeof v === 'string' && v);
    // Before the first sync it's quiet (Drive's copy still wins), unless settings were already
    // edited here, when it's a normal change. When connected, it waits for the sync.
    let changed = afterSync ? Settings.setUp(valuesFor)
      : connected() ? false : Settings.setUp(valuesFor, { quiet: !Settings.get().updatedAt });
    if (!store('potteryLog.listsSeeded')) {
      const names = await noteSeedNames();
      if (!afterSync) return Settings.learn(names, { quiet: true }) || changed;
      store('potteryLog.listsSeeded', Date.now());
      store('potteryLog.listsSeed', null);
      changed = Settings.learn(names) || changed;
    }
    if (!afterSync || changed) return changed;
    const s = Settings.get(); // set up quietly and Drive had nothing newer: upload it
    if (!s.updatedAt && (s.glazes.length || s.clays.length || s.fields.length)) { Settings.update({}); return true; }
    return false;
  }

  /** Load a synced piece's notes and photos the first time it's opened on this device. */
  const loading = new Map();
  function loadOnDemand(id) {
    if (!connected()) return Promise.reject(Object.assign(new Error('Not connected'), { reconnect: true }));
    if (!loading.has(id)) {
      loading.set(id, Sync.loadPiece(id).finally(() => loading.delete(id)));
    }
    return loading.get(id);
  }

  /* ---------- boot ---------- */

  const AUTH_ERRORS = {
    access_denied: 'Google Drive access was not granted.',
    no_refresh_token: 'Google did not allow offline access. Please try again.',
    scope_not_granted: 'Google Drive access was not granted.',
    expired: 'Sign-in took too long. Please try again.',
    state_mismatch: 'Sign-in could not be verified. Please try again.',
    invalid_state: 'Sign-in could not be verified. Please try again.',
  };

  async function boot() {
    // Finish a Google sign-in that just returned here (this also cleans the URL) before routing.
    let auth = null;
    if (Drive.configured) {
      try { auth = await Drive.init(); } catch (e) { /* app works fully offline without Drive */ }
    }
    window.addEventListener('hashchange', route);
    route();

    Sync.init({ makeThumb });
    seedLists(false);
    try { localStorage.removeItem('potteryLog.changeSeq'); localStorage.removeItem('potteryLog.backedSeq'); localStorage.removeItem('potteryLog.lastBackup'); localStorage.removeItem('potteryLog.deviceId'); } catch (e) { /* ignore */ }
    refreshPending().catch(() => {});

    if (auth && auth.connected) {
      try { localStorage.removeItem('potteryLog.autoBackup'); } catch (e) { /* sync is always on now */ }
      toast(Drive.getFolder() ? 'Connected to Google Drive' : 'Connected. Now choose or create a backup folder.', 3500);
      if (onBackupStateChange && location.hash.startsWith('#/backup')) onBackupStateChange();
    } else if (auth && auth.error) {
      toast(AUTH_ERRORS[auth.error] || 'Google sign-in failed (' + auth.error + ').', 5000);
    }

    // Sync on open (pulls changes from other devices, pushes anything left from last time),
    // when the connection comes back, and when returning to the app after a while.
    if (connected()) {
      runSync({ quiet: true });
      window.addEventListener('online', () => runSync({ quiet: true }));
      document.addEventListener('visibilitychange', () => {
        const last = store(LAST_SYNC_KEY);
        if (document.visibilityState === 'visible' && connected() && (!last || Date.now() - last.at > 60 * 1000)) runSync({ quiet: true });
      });
    }
  }

  boot();

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  }
})();
