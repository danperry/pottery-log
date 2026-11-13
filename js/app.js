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
  const PIECE_THUMB_MAX = 320; // each piece's small list thumbnail
  const LAST_SYNC_KEY = 'potteryLog.lastSync';
  const FILTER_KEY = 'potteryLog.filter';
  const CONNECT_TIP_KEY = 'potteryLog.connectTipDismissed';
  const FIELD_FILTER_KEY = 'potteryLog.fieldFilters'; // chosen values, per device
  const NONE = '\u2205'; // field filter value for "no value set" (can't clash with a real value, which is trimmed text)
  const INSTALL_TIP_KEY = 'potteryLog.installTipDismissed';
  const LOCAL_ONLY_KEY = 'potteryLog.localOnlySnoozed'; // "Remind me later" on the only-in-this-browser warning
  const LOCAL_ONLY_SNOOZE = 7 * 24 * 3600 * 1000;
  let pieceCount = 0; // pieces on this device, as of the last list render

  const $ = (sel, root = document) => root.querySelector(sel);
  const app = $('#app');
  const titleEl = $('#pageTitle');
  const backBtn = $('#backBtn');
  const addBtn = $('#addBtn');
  const backupNavBtn = $('#backupNavBtn');

  const ICON_X = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  const ICON_GRIP = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="6" r="1.4"/><circle cx="15" cy="6" r="1.4"/><circle cx="9" cy="12" r="1.4"/><circle cx="15" cy="12" r="1.4"/><circle cx="9" cy="18" r="1.4"/><circle cx="15" cy="18" r="1.4"/></svg>';
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
    if (n >= 1024 * 1024 * 1024) return (n / 1024 / 1024 / 1024).toFixed(1).replace(/\.0$/, '') + ' GB';
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
  /** Show a short message. action: { label, run } adds a button (e.g. Undo) to it. */
  function toast(msg, ms = 2600, action) {
    const t = $('#toast');
    t.replaceChildren(el('span', null, msg));
    t.classList.toggle('has-action', !!action);
    const hide = () => { t.classList.remove('show', 'has-action'); clearTimeout(toastTimer); };
    if (action) {
      t.append(el('button', { type: 'button', class: 'toast-action', onclick: () => { hide(); action.run(); } }, action.label));
    }
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hide, ms);
  }

  /**
   * The app's own pop-up in place of the browser's confirm() and alert().
   * Resolves true when confirmed. Without cancel (cancel: null) it's a notice with one button.
   */
  function ask({ title, message, confirm = 'OK', cancel = 'Cancel', danger = false }) {
    return new Promise((resolve) => {
      const titleId = 'ask-' + Date.now();
      const body = Array.isArray(message) ? message : [message];
      const dlg = el('dialog', { class: 'sheet ask', 'aria-labelledby': titleId },
        el('form', { method: 'dialog' },
          el('h2', { id: titleId }, title),
          ...body.filter(Boolean).map((m) => (typeof m === 'string' ? el('p', { class: 'ask-text' }, m) : m)),
          el('div', { class: 'form-actions ask-actions' },
            cancel ? el('button', { type: 'submit', class: 'btn btn-ghost', value: 'cancel' }, cancel) : null,
            el('button', { type: 'submit', class: 'btn ' + (danger ? 'btn-danger' : 'btn-primary'), value: 'ok', autofocus: !danger }, confirm))));
      dlg.addEventListener('close', () => { resolve(dlg.returnValue === 'ok'); dlg.remove(); });
      document.body.append(dlg);
      dlg.showModal();
      if (danger && cancel) dlg.querySelector('[value=cancel]').focus(); // a stray Enter doesn't destroy anything
    });
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
        try { await Sync.fetchPhoto(pid, fileId); PhotoCache.check(); } catch (e) { /* stays a placeholder */ } finally {
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

  /**
   * The piece's small list thumbnail, made from its thumbnail photo (picked in Edit, or else
   * the newest). opts.download false: don't download the photo just for this.
   */
  async function pieceThumbUrl(p, opts = {}) {
    const pid = PhotoCache.coverOf(p);
    if (!pid) return null;
    const t = await DB.getPieceThumb(p.id);
    if (t && t.photoId === pid && t.thumb) return blobUrl(t.thumb);
    let photo = await DB.getPhoto(pid);
    if (!photo && opts.download !== false) { await fetchPhotoOnce(p, pid); photo = await DB.getPhoto(pid); }
    if (!photo) return null;
    const src = photo.thumb || photo.blob;
    try {
      const img = await decodeImage(src);
      const small = await scaleTo(img, PIECE_THUMB_MAX, 0.75);
      if (img.close) img.close();
      await DB.putPieceThumb(p.id, pid, small);
      PhotoCache.thumbRestored(p.id);
      PhotoCache.check();
      return blobUrl(small);
    } catch (e) {
      return blobUrl(src);
    }
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
    PhotoCache.leave();
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

  /**
   * Pieces that aren't synced live only in this browser, which can clear its storage (Safari
   * removes it from sites not opened for a few weeks unless they're on the home screen).
   * Shown while there are pieces and Drive isn't connected with a folder. Returns true if shown.
   */
  function drawLocalOnlyWarning(tip) {
    const reconnecting = Drive.configured && Drive.needsReconnect(); // the Reconnect bar says it already
    const synced = Drive.configured && Drive.isSignedIn() && Drive.getFolder();
    const snoozed = Date.now() - (Number(store(LOCAL_ONLY_KEY)) || 0) < LOCAL_ONLY_SNOOZE;
    if (!pieceCount || reconnecting || synced || snoozed) return false;
    const what = pieceCount === 1 ? 'Your piece is' : 'Your ' + pieceCount + ' pieces are';
    const ios = phoneKind() === 'ios' && !isInstalled();
    const body = el('div', { class: 'tip-body' },
      el('strong', { class: 'tip-title' }, 'Only saved in this browser'),
      el('p', null, what + ' stored only here. The browser can delete ' + (pieceCount === 1 ? 'it' : 'them') + ' if its data is cleared or, in Safari, after a few weeks unused. ' +
        (Drive.configured ? 'Connect Google Drive to keep a copy.' : 'Keep a backup somewhere else.')),
      ios ? el('p', { html: 'Adding the app to your home screen helps too: ' + ICON_SHARE + ' <strong>Share</strong> → <strong>Add to Home Screen</strong>.' }) : null);
    if (Drive.configured) {
      body.append(Drive.isSignedIn()
        ? el('button', { class: 'btn btn-primary btn-small', type: 'button', onclick: () => nav('#/backup') }, 'Choose a Drive folder')
        : el('button', { class: 'btn btn-primary btn-small', type: 'button', onclick: () => Drive.signIn() }, 'Connect Google Drive'));
    }
    tip.classList.add('tip-warn');
    tip.setAttribute('role', 'alert');
    tip.replaceChildren(
      el('img', { src: 'icons/icon-192.png', alt: '' }),
      body,
      el('button', {
        class: 'icon-btn', type: 'button', 'aria-label': 'Remind me later', title: 'Remind me in a week', html: ICON_X,
        onclick: () => { store(LOCAL_ONLY_KEY, Date.now()); store(CONNECT_TIP_KEY, Date.now()); tip.hidden = true; drawInstallTip(); },
      }));
    tip.hidden = false;
    return true;
  }

  /** First-use tip: connect Google Drive (or the warning above, once there are pieces). Returns true if shown. */
  function drawConnectTip() {
    const tip = $('#connectTip');
    if (!tip) return false;
    tip.classList.remove('tip-warn');
    tip.setAttribute('role', 'note');
    if (drawLocalOnlyWarning(tip)) return true;
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
   * one. kind is 'glaze' or 'clay'.
   * opts.locked(): true while the values can't be changed (glazes set by a glazing process).
   * opts.onChange(): after a value is added or removed.
   * Returns { flush() } to add anything typed but not yet added, and redraw().
   */
  function tagPicker(box, values, kind, opts = {}) {
    const locked = opts.locked || (() => false);
    let ready = false;
    const noun = kind === 'clay' ? 'clay body' : 'glaze';
    const known = () => (kind === 'clay' ? Settings.clays().map((c) => c.name) : Settings.glazes());
    const tags = el('div', { class: 'tags' });
    const row = el('div', { class: 'pick-row' });
    let typing = false;
    const has = (v) => values.some((x) => x.toLowerCase() === v.toLowerCase());
    function add(v) {
      v = String(v || '').trim().slice(0, 120);
      if (!v || has(v)) return;
      values.push(v);
    }
    function drawTags() {
      if (locked()) { tags.replaceChildren(...values.map((v) => el('span', { class: 'tag locked' }, v))); return; }
      tags.replaceChildren(...values.map((v, i) => el('span', { class: 'tag' }, v,
        el('button', { type: 'button', 'aria-label': 'Remove ' + v, html: ICON_X, onclick: () => { values.splice(i, 1); draw(); } }))));
    }
    function drawRow() {
      if (locked()) {
        typing = false;
        row.flush = () => {};
        row.replaceChildren(el('p', { class: 'muted small' }, 'Set by the glazing process below. Remove it to change them.'));
        return;
      }
      if (typing) {
        const input = el('input', { maxlength: '120', autocomplete: 'off', placeholder: 'New ' + noun + ' name', 'aria-label': 'New ' + noun + ' name' });
        const commit = () => { add(input.value); typing = false; draw(); };
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } if (e.key === 'Escape') { typing = false; draw(); } });
        row.replaceChildren(input, el('button', { type: 'button', class: 'btn btn-secondary btn-small', onclick: commit }, 'Add'));
        row.flush = () => { if (input.value.trim()) add(input.value); };
        input.focus();
        return;
      }
      row.flush = () => {};
      const options = known().filter((v) => !has(v)).sort((a, b) => a.localeCompare(b));
      const sel = el('select', { 'aria-label': 'Add a ' + noun },
        el('option', { value: '' }, values.length ? 'Add another ' + noun + '…' : 'Choose a ' + noun + '…'),
        options.map((v) => el('option', { value: v }, v)),
        el('option', { value: '__new' }, '+ New ' + noun + '…'));
      sel.addEventListener('change', () => {
        if (sel.value === '__new') typing = true; else if (sel.value) add(sel.value);
        draw();
      });
      row.replaceChildren(sel);
    }
    function draw() { drawTags(); drawRow(); if (ready && opts.onChange) opts.onChange(); }
    box.replaceChildren(tags, row);
    draw();
    ready = true;
    return { flush: () => row.flush(), redraw: draw };
  }

  /* ---------- glazing processes ---------- */

  const glazingProcessName = (p) => { const r = p && Settings.glazingProcess(p.glazingProcessId); return r ? r.name : ''; };

  /** A photo by its piece and id, downloaded from Drive if needed (fileId saves looking it up). */
  async function refPhotoUrl(ref, live) {
    const here = await photoUrl(ref.photoId);
    if (here) return here;
    let p = live && live.id === ref.pieceId ? live : await DB.getPiece(ref.pieceId);
    const fileOf = (x) => x && x.sync && x.sync.photoFiles && x.sync.photoFiles[ref.photoId];
    const tryFile = async (fileId) => {
      if (fileId) await fetchPhotoOnce({ sync: { photoFiles: { [ref.photoId]: fileId } } }, ref.photoId);
      return fileId ? photoUrl(ref.photoId) : null;
    };
    let u = await tryFile(ref.fileId);
    if (!u && fileOf(p) !== ref.fileId) u = await tryFile(fileOf(p)); // the piece moved to another folder
    if (!u && p && p.stub && !fileOf(p) && connected() && navigator.onLine) { // not opened on this device yet
      p = await loadDetails(p.id).catch(() => null);
      u = await tryFile(fileOf(p));
    }
    return u;
  }

  /** The default thumbnail: the last photo of the piece the glazing process was saved from. */
  async function glazingProcessDefaultRef(r, live) {
    if (!r.pieceId) return null;
    const p = live && live.id === r.pieceId ? live : await DB.getPiece(r.pieceId);
    if (!p || p.deleted) return null;
    const ids = p.photoIds || [];
    const pid = p.stub ? PhotoCache.coverOf(p) : ids[ids.length - 1];
    return pid ? { pieceId: p.id, photoId: pid } : null;
  }

  /** The glazing process's thumbnail: the one picked in Settings, or else the default. live: a piece being edited. */
  async function glazingProcessThumbUrl(r, live) {
    if (r.thumb) { const u = await refPhotoUrl(r.thumb, live).catch(() => null); if (u) return u; }
    const ref = await glazingProcessDefaultRef(r, live);
    return ref ? refPhotoUrl(ref, live).catch(() => null) : null;
  }

  function glazingProcessThumb(r, { live, big } = {}) {
    const box = el('div', { class: 'process-thumb' + (big ? ' big' : ''), html: ICON_POT });
    glazingProcessThumbUrl(r, live).then((u) => { if (u) box.replaceChildren(el('img', { src: u, alt: '' })); });
    return box;
  }

  function glazingProcessCard(r, opts = {}) {
    return el(opts.onclick ? 'button' : 'div', { class: 'process-card' + (opts.match ? ' match' : ''), type: opts.onclick ? 'button' : null, onclick: opts.onclick || null },
      glazingProcessThumb(r, opts),
      el('div', { class: 'process-meta' },
        el('strong', null, r.name),
        el('span', { class: 'sub' }, r.glazes.join(', ') + (opts.match ? ' · same glazes as this piece' : '')),
        opts.notes !== false && r.notes ? el('p', { class: 'process-notes' }, r.notes) : null));
  }

  /** A pop-up sheet with a form. build(form, close) fills it; resolves with what close() was given. */
  function sheet(title, build) {
    return new Promise((resolve) => {
      const titleId = 'sheet-' + Date.now();
      const form = el('form', { method: 'dialog' }, el('h2', { id: titleId }, title));
      const dlg = el('dialog', { class: 'sheet process-sheet', 'aria-labelledby': titleId }, form);
      let result;
      const close = (v) => { result = v; dlg.close(); };
      dlg.addEventListener('close', () => { resolve(result); dlg.remove(); });
      build(form, close);
      document.body.append(dlg);
      dlg.showModal();
    });
  }

  /** Choose one of the saved glazing processes. Resolves with the glazing process, or undefined. */
  function chooseGlazingProcess(glazes, live) {
    return sheet('Choose a glazing process', (form, close) => {
      form.append(
        el('div', { class: 'process-choices' }, Settings.glazingProcesses().map((r) =>
          glazingProcessCard(r, { live, notes: false, match: glazes.length && Settings.sameGlazes(glazes, r.glazes), onclick: () => close(r) }))),
        el('div', { class: 'form-actions ask-actions' }, el('button', { type: 'submit', class: 'btn btn-ghost', value: 'cancel' }, 'Cancel')));
    });
  }

  /** Ask for a new glazing process's name and notes. Resolves with { name, notes }, or undefined. */
  function askGlazingProcessDetails(glazes) {
    return sheet('Save as a glazing process', (form, close) => {
      const name = el('input', { maxlength: '80', autocomplete: 'off', placeholder: 'e.g. Celadon over tenmoku, dipped', required: true });
      const notes = el('textarea', { rows: '5', maxlength: '4000', placeholder: 'How you apply the glazes: order, dips, seconds, thickness, wax…' });
      form.append(
        el('p', { class: 'muted small' }, 'Glazes: ' + glazes.join(', ')),
        el('label', { class: 'field' }, el('span', null, 'Name'), name),
        el('label', { class: 'field' }, el('span', null, 'Notes'), notes),
        el('div', { class: 'form-actions ask-actions' },
          el('button', { type: 'button', class: 'btn btn-ghost', onclick: () => close() }, 'Cancel'),
          el('button', { type: 'submit', class: 'btn btn-primary', value: 'ok' }, 'Save glazing process')));
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        try { close({ name: Settings.checkGlazingProcessName(name.value), notes: notes.value.trim() }); } catch (err) { toast(err.message); name.focus(); }
      });
      setTimeout(() => name.focus(), 0);
    });
  }

  /* ---------- field values (built-in and custom), for filters and display ---------- */

  function filterDefs() {
    return [...Settings.BUILTIN_FILTERS.map((b) => ({ ...b, builtin: true })), ...Settings.fields()];
  }

  /** The value(s) of a field on a piece, as display strings. */
  function fieldValues(p, id) {
    if (id === 'glazes') return p.glazes || [];
    if (id === 'glazingProcess') { const n = glazingProcessName(p); return n ? [n] : []; }
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
    if (f && f.type === 'currency') return values.sort((a, b) => Settings.amountOf(a) - Settings.amountOf(b));
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
        if (!want) continue;
        const have = fieldValues(p, id);
        if (want === NONE ? have.length : !have.includes(want)) return false;
      }
      if (!query) return true;
      const hay = [p.title, claysOf(p).join(' '), METHOD_LABEL[p.method], (p.glazes || []).join(' '), glazingProcessName(p),
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
        if (p.photoIds && p.photoIds.length) {
          // A thumbnail removed in a storage emergency comes back when the piece is opened.
          pieceThumbUrl(p, { download: !PhotoCache.thumbDropped(p.id) })
            .then((u) => { if (u) thumb.replaceChildren(el('img', { src: u, alt: '', loading: 'lazy' })); });
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
        if (cur && cur !== NONE && !values.includes(cur)) values.unshift(cur);
        // "none" finds pieces where the field is still empty (yes/no fields always read Yes or No).
        const canBeEmpty = d.builtin || d.type !== 'yesno';
        const empty = canBeEmpty ? pieces.filter((p) => !fieldValues(p, d.id).length).length : 0;
        const sel = el('select', { 'aria-label': 'Filter by ' + d.name, class: cur ? 'active' : '' },
          el('option', { value: '' }, d.name + ': any'),
          canBeEmpty ? el('option', { value: NONE }, d.name + ': none (' + empty + ')') : null,
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
      const custom = Settings.fields().filter((f) => f.type !== 'link'); // a link per piece isn't something to filter by
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
    pieceCount = pieces.length;
    drawInstallTip();
    drawChips();
    drawFieldFilters();
    drawCards();
  }

  /* ---------- detail view ---------- */

  let showLastPhoto = false; // after adding photos from the piece view, show the newest
  async function renderDetail(id) {
    const p = await DB.getPiece(id);
    if (!p || p.deleted) { toast('That piece was not found.'); return nav('#/', true); }
    setChrome({ title: p.title || 'Untitled', back: true, fab: false });
    mount('tpl-detail');
    const here = location.hash;
    PhotoCache.touch(p.id); // recently opened pieces keep their photos on the device

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
      // Photos removed from this device to save room download again from Drive.
      const missing = (await Promise.all(ids.map((pid) => DB.getPhoto(pid)))).filter((x) => !x).length;
      let note = null;
      if (missing) {
        note = el('p', { class: 'muted small loading-note' }, navigator.onLine && connected()
          ? 'Downloading ' + (missing === 1 ? 'a photo' : missing + ' photos') + ' from Google Drive…'
          : (missing === 1 ? 'A photo is' : missing + ' photos are') + ' kept in Google Drive to save room. ' +
            (navigator.onLine ? 'Reconnect Google Drive to see them.' : 'They\'ll download when you\'re back online.'));
        gallery.parentElement.after(note);
      }
      const imgs = (await Promise.all(ids.map(async (pid) => {
        const u = await piecePhotoUrl(p, pid, 'full');
        return u ? el('img', { src: u, alt: p.title || 'Photo', onclick: () => lightbox(u) }) : null;
      }))).filter(Boolean);
      if (!gallery.isConnected) return;
      if (note && imgs.length === ids.length) note.remove();
      if (missing) PhotoCache.check();
      gallery.classList.toggle('single', imgs.length <= 1);
      if (imgs.length) gallery.replaceChildren(...imgs);
      else gallery.replaceChildren(el('div', { class: 'no-photo', html: ICON_POT }));
      if (imgs.length > 1) {
        const dots = el('div', { class: 'gallery-dots' }, imgs.map((_, i) => el('span', { class: i === 0 ? 'on' : '' })));
        gallery.parentElement.after(dots);
        // Arrows, so the carousel also works with a mouse.
        const prev = $('#galleryPrev'); const next = $('#galleryNext');
        const at = () => Math.round(gallery.scrollLeft / gallery.clientWidth);
        const go = (i) => gallery.scrollTo({ left: i * gallery.clientWidth, behavior: 'smooth' });
        const update = () => {
          const i = at();
          [...dots.children].forEach((d, j) => d.classList.toggle('on', i === j));
          prev.disabled = i <= 0;
          next.disabled = i >= gallery.children.length - 1;
        };
        prev.hidden = false; next.hidden = false;
        prev.onclick = () => go(at() - 1);
        next.onclick = () => go(at() + 1);
        gallery.addEventListener('scroll', update, { passive: true });
        if (showLastPhoto) { showLastPhoto = false; gallery.scrollLeft = gallery.scrollWidth; }
        update();
      }
    }

    // Add photos straight from the piece view (saved and synced like an edit).
    if (!p.stub) {
      $('#galleryAdd').hidden = false;
      $('#detailPhotoInput').addEventListener('change', async (e) => {
        const files = [...e.target.files];
        e.target.value = '';
        if (!files.length) return;
        toast(files.length === 1 ? 'Adding photo…' : 'Adding ' + files.length + ' photos…', 1500);
        const added = [];
        for (const file of files) {
          try {
            const { blob, thumb } = await processPhoto(file);
            const pid = DB.uid();
            await DB.putPhoto({ id: pid, blob, thumb, type: blob.type, addedAt: Date.now() });
            added.push(pid);
          } catch (err) {
            toast(err.message || 'Could not add that photo.');
          }
        }
        if (!added.length) return;
        const fresh = await DB.getPiece(p.id); // the latest copy, in case a sync updated it meanwhile
        if (!fresh || fresh.deleted) { DB.deletePhotos(added); return; }
        fresh.photoIds = [...(fresh.photoIds || []), ...added];
        fresh.updatedAt = Date.now();
        await DB.putPiece(fresh);
        markChanged();
        PhotoCache.check();
        toast(added.length === 1 ? 'Photo added' : added.length + ' photos added');
        if (location.hash === here) { showLastPhoto = true; route(); }
      });
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
    if (clays.length) add(clays.length > 1 ? 'Clay bodies' : 'Clay body', clays.join(', '));
    add('Forming', METHOD_LABEL[p.method]);
    if (p.glazes && p.glazes.length) add('Glazes', el('div', { class: 'glaze-list' }, p.glazes.map((g) => el('span', null, g))));
    const glazingProcess = Settings.glazingProcess(p.glazingProcessId);
    if (glazingProcess) {
      add('Glazing process', el('div', { class: 'process-fact' }, glazingProcessThumb(glazingProcess),
        el('div', { class: 'process-meta' }, el('strong', null, glazingProcess.name), glazingProcess.notes ? el('p', { class: 'process-notes' }, glazingProcess.notes) : null)));
    }
    const fire = firingsOf(p);
    add('Bisque firing', [fire.bisqueFiringType, coneLabel(fire.bisqueCone)].filter(Boolean).join(', '));
    add('Glaze firing', [fire.glazeFiringType, coneLabel(fire.glazeCone)].filter(Boolean).join(', '));
    add('Made', fmtDate(p.dateMade));
    add('Bisque fired', fmtDate(p.dateBisque));
    add('Glaze fired', fmtDate(p.dateGlazed));
    add('Finished', fmtDate(p.dateDone));
    for (const f of Settings.fields()) {
      const v = (p.custom || {})[f.id];
      if (f.type === 'link') { if (v) add(f.name, linkTo(v)); continue; }
      add(f.name, f.type === 'date' ? fmtDate(v) : Settings.format(f, v));
    }
    drawSquareCharge(p);
    const factsEl = $('#dFacts');
    if (facts.length) factsEl.replaceChildren(...facts); else factsEl.hidden = true;

    if (p.notes) { $('#dNotesWrap').hidden = false; $('#dNotes').textContent = p.notes; }

    $('#editBtn').hidden = !!p.stub;
    $('#editBtn').onclick = () => nav('#/edit/' + encodeURIComponent(p.id));
    $('#deleteBtn').onclick = () => deletePiece(p.id);
  }

  /** Delete a piece straight away, with Undo in the toast for a few seconds. */
  async function deletePiece(id) {
    const p = await DB.getPiece(id);
    if (!p) return;
    // Keep everything needed to put it back: the record, its photos and its list thumbnail.
    const photos = (await Promise.all((p.photoIds || []).map((pid) => DB.getPhoto(pid)))).filter(Boolean);
    const thumb = await DB.getPieceThumb(p.id);
    await DB.deletePiece(p.id);
    // Remember the delete so other devices delete it too.
    if (p.sync) await DB.putPiece({ id: p.id, title: p.title, deleted: true, updatedAt: Date.now(), sync: p.sync });
    markChanged();
    nav('#/', true);
    toast('Deleted “' + (p.title || 'Untitled') + '”', 8000, {
      label: 'Undo',
      run: async () => {
        for (const ph of photos) await DB.putPhoto(ph);
        if (thumb) await DB.putPhoto(thumb);
        // A newer save than the delete, so it comes back everywhere (its Drive folder leaves the trash).
        await DB.putPiece({ ...p, updatedAt: Date.now() });
        markChanged();
        toast('Piece restored');
        if (location.hash === '#/' || location.hash === '') route();
      },
    });
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
    if (existing) PhotoCache.touch(existing.id);
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

    // Glazing process: a saved set of glazes. While one is applied, the glazes are the glazing process's and can't
    // be changed. One saved here ("Save as a glazing process") is created when the piece is saved.
    let pendingGlazingProcess = null;
    const glazingProcessOf = (rid) => (rid && pendingGlazingProcess && pendingGlazingProcess.id === rid ? pendingGlazingProcess : Settings.glazingProcess(rid));
    if (piece.glazingProcessId && !glazingProcessOf(piece.glazingProcessId)) delete piece.glazingProcessId; // removed on another device
    const glazePick = tagPicker($('#glazePicker'), piece.glazes, 'glaze', { locked: () => !!glazingProcessOf(piece.glazingProcessId), onChange: drawGlazingProcess });
    function drawGlazingProcess() {
      const box = $('#glazingProcessBox');
      if (!box) return;
      const r = glazingProcessOf(piece.glazingProcessId);
      if (r) {
        box.replaceChildren(glazingProcessCard(r, { live: piece }),
          el('div', { class: 'process-actions' }, el('button', {
            type: 'button', class: 'btn btn-ghost btn-small',
            onclick: () => { delete piece.glazingProcessId; glazePick.redraw(); drawGlazingProcess(); },
          }, 'Remove glazing process'),
          r === pendingGlazingProcess ? el('p', { class: 'muted small' }, 'The glazing process is saved when you save the piece.') : null));
        return;
      }
      const parts = [];
      if (Settings.glazingProcesses().length) parts.push(el('button', { type: 'button', class: 'btn btn-secondary btn-small', onclick: pickGlazingProcess }, 'Choose a glazing process…'));
      if (piece.glazes.length >= 2) parts.push(el('button', { type: 'button', class: 'btn btn-ghost btn-small', onclick: saveAsGlazingProcess }, 'Save as a glazing process'));
      if (!parts.length) parts.push(el('p', { class: 'muted small' }, 'Add two or more glazes to save them as a glazing process.'));
      box.replaceChildren(el('div', { class: 'process-actions' }, ...parts));
    }
    async function pickGlazingProcess() {
      glazePick.flush();
      const r = await chooseGlazingProcess(piece.glazes, piece);
      if (!r) return;
      if (piece.glazes.length && !Settings.sameGlazes(piece.glazes, r.glazes) && !(await ask({
        title: 'Change the glazes to “' + r.name + '”?',
        message: ['This piece has ' + piece.glazes.join(', ') + '.', 'Applying the glazing process changes its glazes to ' + r.glazes.join(', ') + '.'],
        confirm: 'Apply',
      }))) return;
      piece.glazes.splice(0, piece.glazes.length, ...r.glazes);
      piece.glazingProcessId = r.id;
      glazePick.redraw();
      drawGlazingProcess();
    }
    async function saveAsGlazingProcess() {
      glazePick.flush();
      if (piece.glazes.length < 2) { drawGlazingProcess(); return; }
      const d = await askGlazingProcessDetails(piece.glazes);
      if (!d) return;
      pendingGlazingProcess = { id: 'gp-' + DB.uid(), name: d.name, notes: d.notes, glazes: [...piece.glazes], pieceId: piece.id };
      piece.glazingProcessId = pendingGlazingProcess.id;
      glazePick.redraw();
      drawGlazingProcess();
    }
    drawGlazingProcess();

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
          el('label', { class: 'yesno' }, el('input', {
            type: 'checkbox', name, checked: v === true,
            onchange: (e) => { e.target.nextElementSibling.textContent = e.target.checked ? 'Yes' : 'No'; }, // says what it's set to
          }), el('b', null, v === true ? 'Yes' : 'No')));
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
      } else if (cf.type === 'currency') {
        // Each price keeps its own currency; new ones start with the field's default.
        const m = Settings.money(cf, v);
        const cur = currencySelect(m ? m.currency : cf.currency);
        cur.name = 'cfcur:' + cf.id;
        cur.setAttribute('aria-label', cf.name + ' currency');
        cur.classList.add('money-currency');
        input = el('input', { name, type: 'number', min: '0', inputmode: 'decimal', 'aria-label': cf.name });
        const setStep = () => { const d = Settings.minorDigits(cur.value); input.step = d ? String(10 ** -d) : '1'; };
        cur.addEventListener('change', setStep); setStep();
        if (m) input.value = m.amount.toFixed(Settings.minorDigits(m.currency));
        return el('div', { class: 'field' }, el('span', null, cf.name), el('div', { class: 'money-row' }, input, cur));
      } else if (cf.type === 'link') {
        input = el('input', { name, type: 'url', inputmode: 'url', maxlength: '2000', autocomplete: 'off', placeholder: 'https://' });
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
    // Tap a photo to use it as the piece's thumbnail (the newest photo until one is picked).
    async function drawPhotos() {
      const cover = PhotoCache.coverOf(piece);
      $('#thumbHint').hidden = piece.photoIds.length < 2;
      const items = await Promise.all(piece.photoIds.map(async (pid, i) => {
        const u = await piecePhotoUrl(piece, pid);
        const isCover = pid === cover;
        return el('div', { class: 'photo-item' + (isCover && piece.photoIds.length > 1 ? ' is-cover' : '') },
          el('button', {
            type: 'button', class: 'pick-thumb', 'aria-pressed': String(isCover),
            'aria-label': isCover ? 'Photo ' + (i + 1) + ', the thumbnail' : 'Use photo ' + (i + 1) + ' as the thumbnail',
            onclick: () => { piece.coverPhotoId = pid; drawPhotos(); },
          }, u ? el('img', { src: u, alt: '' }) : null),
          isCover && piece.photoIds.length > 1 ? el('span', { class: 'cover' }, 'Thumbnail') : null,
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
      if (pendingGlazingProcess && piece.glazingProcessId === pendingGlazingProcess.id) {
        try { Settings.addGlazingProcess(pendingGlazingProcess); pendingGlazingProcess = null; } catch (err) { toast(err.message, 4000); return; }
      }
      if (!piece.glazingProcessId || !Settings.glazingProcess(piece.glazingProcessId)) delete piece.glazingProcessId;
      piece.title = title;
      piece.method = (form.querySelector('input[name=method]:checked') || {}).value || '';
      for (const k of ['bisqueFiringType', 'bisqueCone', 'glazeFiringType', 'glazeCone']) piece[k] = f[k].value;
      piece.stage = (form.querySelector('input[name=stage]:checked') || {}).value || 'greenware';
      ['dateMade', 'dateBisque', 'dateGlazed', 'dateDone'].forEach((k) => { piece[k] = f[k].value; });
      piece.notes = f.notes.value.trim();
      if (piece.coverPhotoId && !piece.photoIds.includes(piece.coverPhotoId)) delete piece.coverPhotoId; // that photo was removed
      for (const cf of Settings.fields()) {
        const input = form.elements['cf:' + cf.id];
        if (!input) continue;
        const v = cf.type === 'yesno' ? input.checked
          : cf.type === 'currency' ? Settings.coerce(cf, { amount: input.value.trim(), currency: form.elements['cfcur:' + cf.id].value })
            : Settings.coerce(cf, input.value.trim());
        if (cf.type === 'link' && v === '' && input.value.trim()) { toast('“' + cf.name + '” needs a web address, such as https://…'); input.focus(); return; }
        if (v === '') delete custom[cf.id];
        else custom[cf.id] = v;
      }
      // Remember values newly typed into remembered text fields (one taken off a list stays off).
      const before = piece.custom || {};
      Settings.learnValues(Object.fromEntries(Object.entries(custom).filter(([id, v]) => v !== before[id])));
      piece.custom = custom;
      // Remember new glazes and clays for the drop-downs (synced with the other settings).
      const unlisted = (v) => !hadNames.has(v.toLowerCase());
      Settings.learn({ glazes: piece.glazes.filter(unlisted), clays: piece.clays.filter(unlisted) });
      piece.updatedAt = Date.now();
      await DB.putPiece(piece);
      saved = true;
      const kept = new Set(piece.photoIds);
      const removed = [...originalPhotos, ...addedPhotos].filter((pid) => !kept.has(pid));
      await DB.deletePhotos(removed);
      markChanged();
      PhotoCache.check();
      toast((isNew ? 'Piece added' : 'Saved') + (!navigator.onLine && connected() ? '. It will sync when you\'re back online.' : ''), !navigator.onLine ? 3000 : undefined);
      DB.requestPersistence();
      // A new piece's form becomes its page. An edit goes back to the piece it came from, so
      // Back from there goes home rather than to a second copy of the piece.
      if (isNew || inAppNavs === 0) nav('#/piece/' + encodeURIComponent(piece.id), true);
      else history.back();
    });

    if (isNew) f.title.focus();
  }

  /* ---------- Square checkout ---------- */

  // "Charge with Square" opens the Square Point of Sale app with the piece's price and a note
  // holding its link. When the sale is done, Square opens this page again with the transaction
  // ID, which is saved on the piece (Transaction, and Sold set to Yes).
  // Docs: https://developer.squareup.com/docs/pos-api/web-technical-reference
  const SQUARE_PENDING_KEY = 'potteryLog.squarePending';
  const squareAppId = () => Settings.square().appId || (window.POTTERY_CONFIG || {}).squareAppId || '';
  const appUrl = () => location.origin + location.pathname;
  const pieceUrl = (id) => appUrl() + '#/piece/' + encodeURIComponent(id);
  // With the sign-in Worker set up, Square returns through it: the Worker keeps the result for
  // the home-screen app (on iPhone, Square comes back in Safari, which can't see its pieces).
  const relayUrl = () => ((window.POTTERY_CONFIG || {}).authWorkerUrl || '').trim().replace(/\/+$/, '');
  const squareCallbackUrl = () => (relayUrl() ? relayUrl() + '/square/return' : appUrl());
  const isAndroid = () => /Android/i.test(navigator.userAgent);
  const isIOS = () => /iPhone|iPad|iPod/i.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
  const squareSaleUrl = (id) => 'https://app.squareup.com/dashboard/sales/transactions/' + encodeURIComponent(id);

  function linkTo(url) {
    let text = url;
    try { const u = new URL(url); text = u.host.replace(/^www\./, '') + (u.pathname.length > 1 ? u.pathname : ''); } catch (e) { /* show as is */ }
    if (/squareup\.com\/dashboard\/sales\/transactions\/./.test(url)) text = 'View in Square';
    return el('a', { href: url, target: '_blank', rel: 'noopener', class: 'fact-link' }, text);
  }

  function currencySelect(selected) {
    const cur = selected || Settings.localCurrency();
    const sel = el('select', null, Settings.currencyChoices().map((c) => el('option', { value: c.code, selected: c.code === cur }, c.label)));
    sel.value = cur;
    return sel;
  }

  function drawSquareCharge(p) {
    const btn = $('#squareBtn');
    if (!btn) return;
    const price = Settings.squareField('price');
    const sold = Settings.squareField('sold');
    const custom = p.custom || {};
    const m = price && price.type === 'currency' ? Settings.money(price, custom[price.id]) : null;
    btn.hidden = !Settings.square().enabled || p.stub || !(m && m.amount > 0) || (sold && custom[sold.id] === true);
    if (btn.hidden) return;
    btn.textContent = 'Charge ' + Settings.format(price, m) + ' with Square';
    btn.onclick = () => startSquareCharge(p, m);
  }

  function startSquareCharge(p, { amount, currency }) {
    const appId = squareAppId();
    if (!appId) { toast('Add your Square application ID in Settings first.', 4000); return nav('#/backup'); }
    if (!isAndroid() && !isIOS()) { toast('Square checkout opens the Square Point of Sale app, so use it on your phone or tablet.', 4500); return; }
    const total = Math.round(amount * 10 ** Settings.minorDigits(currency));
    const note = ('Pottery Log: ' + (p.title || 'Untitled')).slice(0, 200) + ' ' + pieceUrl(p.id);
    const key = relayUrl() ? Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'[b & 63]).join('') : '';
    const state = 'pl:' + p.id + (key ? ':' + key : '');
    store(SQUARE_PENDING_KEY, { pieceId: p.id, key, at: Date.now() });
    if (isAndroid()) {
      const extra = (k, v) => k + '=' + encodeURIComponent(v) + ';';
      location.href = 'intent:#Intent;action=com.squareup.pos.action.CHARGE;package=com.squareup;' +
        extra('S.com.squareup.pos.WEB_CALLBACK_URI', squareCallbackUrl()) +
        extra('S.com.squareup.pos.CLIENT_ID', appId) +
        extra('S.com.squareup.pos.API_VERSION', 'v2.0') +
        extra('i.com.squareup.pos.TOTAL_AMOUNT', String(total)) +
        extra('S.com.squareup.pos.CURRENCY_CODE', currency) +
        extra('S.com.squareup.pos.TENDER_TYPES', 'com.squareup.pos.TENDER_CARD,com.squareup.pos.TENDER_CARD_ON_FILE,com.squareup.pos.TENDER_CASH,com.squareup.pos.TENDER_OTHER') +
        extra('S.com.squareup.pos.NOTE', note) +
        extra('S.com.squareup.pos.REQUEST_METADATA', state) +
        extra('S.browser_fallback_url', 'https://play.google.com/store/apps/details?id=com.squareup') +
        'end';
    } else {
      const data = {
        amount_money: { amount: total, currency_code: currency },
        callback_url: squareCallbackUrl(), client_id: appId, version: '1.3', notes: note, state,
        options: { supported_tender_types: ['CREDIT_CARD', 'CASH', 'OTHER', 'SQUARE_GIFT_CARD', 'CARD_ON_FILE'] },
      };
      location.href = 'square-commerce-v1://payment/create?data=' + encodeURIComponent(JSON.stringify(data));
    }
  }

  const SQUARE_ERRORS = {
    TRANSACTION_CANCELED: '', payment_canceled: '',
    NO_EMPLOYEE_LOGGED_IN: 'Sign in to the Square app first.', USER_NOT_LOGGED_IN: 'Sign in to the Square app first.', not_logged_in: 'Sign in to the Square app first.',
    UNAUTHORIZED_CLIENT_ID: 'Square didn\'t accept the application ID. Check it in Settings.', DISABLED: 'The Point of Sale API isn\'t turned on for this Square app.',
    currency_code_mismatch: 'The price\'s currency doesn\'t match your Square account. Change it on the Price field in Settings.',
    UNSUPPORTED_API_VERSION: 'Update the Square app and try again.', unsupported_api_version: 'Update the Square app and try again.',
    TRANSACTION_ALREADY_IN_PROGRESS: 'Square is already in the middle of a sale.', could_not_perform: 'Square has an unfinished sale. Finish or cancel it first.',
  };

  /** Read Square's reply from the address bar (and take it out). Returns null if there isn't one. */
  function readSquareReturn() {
    const q = new URLSearchParams(location.search);
    const P = 'com.squareup.pos.';
    let r = null;
    if (q.has(P + 'CLIENT_TRANSACTION_ID') || q.has(P + 'SERVER_TRANSACTION_ID') || q.has(P + 'ERROR_CODE')) {
      r = { serverId: q.get(P + 'SERVER_TRANSACTION_ID'), clientId: q.get(P + 'CLIENT_TRANSACTION_ID'), state: q.get(P + 'REQUEST_METADATA'),
        error: q.get(P + 'ERROR_CODE'), errorText: q.get(P + 'ERROR_DESCRIPTION') };
    } else if (q.has('data')) {
      try {
        const d = JSON.parse(q.get('data'));
        if (d && d.status) r = { serverId: d.transaction_id, clientId: d.client_transaction_id, state: d.state, error: d.status === 'ok' ? null : d.error_code || 'error' };
      } catch (e) { /* not from Square */ }
    }
    if (!r) return null;
    const pending = store(SQUARE_PENDING_KEY);
    store(SQUARE_PENDING_KEY, null);
    const m = typeof r.state === 'string' && r.state.match(/^pl:([^:]+)/);
    r.pieceId = m ? m[1] : pending && pending.pieceId;
    if (r.error) r.error = r.error.replace(/^com\.squareup\.pos\.ERROR_/, '');
    history.replaceState(null, '', location.pathname + (r.pieceId ? '#/piece/' + encodeURIComponent(r.pieceId) : '#/'));
    return r;
  }

  /** Save a finished sale on its piece: Transaction link, and Sold set to Yes. */
  async function saveSquareSale(r) {
    if (r.error) {
      const msg = SQUARE_ERRORS[r.error];
      if (msg !== '') toast(msg || 'Square: ' + (r.errorText || r.error.replace(/_/g, ' ').toLowerCase()), 5000);
      return;
    }
    const url = r.serverId ? squareSaleUrl(r.serverId) : 'https://app.squareup.com/dashboard/sales/transactions';
    const p = r.pieceId ? await DB.getPiece(r.pieceId) : null;
    if (!p || p.deleted || p.stub) {
      // E.g. Square opened the browser instead of the home-screen app, which keeps its own pieces.
      const box = el('div', { class: 'square-note', role: 'status' },
        el('p', null, relayUrl()
          ? 'The sale went through in Square. Square opened your browser, so switch back to Pottery Log on your home screen: it marks the piece sold there. If it doesn\'t, copy this link into the piece\'s Transaction field.'
          : 'The sale went through in Square, but this piece isn\'t in this copy of Pottery Log (Square may have opened your browser instead of the home-screen app). Copy the link, then open the piece in Pottery Log, tap Edit and paste it into Transaction.'),
        el('div', { class: 'folder-actions' },
          el('button', { type: 'button', class: 'btn btn-primary btn-small', onclick: () => {
            (navigator.clipboard ? navigator.clipboard.writeText(url) : Promise.reject()).then(() => toast('Link copied'), () => toast(url, 8000));
          } }, 'Copy link'),
          el('a', { class: 'btn btn-ghost btn-small', href: url, target: '_blank', rel: 'noopener' }, 'Open in Square'),
          el('button', { type: 'button', class: 'btn btn-ghost btn-small', onclick: () => box.remove() }, 'Close')));
      document.body.append(box);
      return;
    }
    p.custom = { ...(p.custom || {}) };
    const tx = Settings.squareField('transaction');
    const sold = Settings.squareField('sold');
    if (tx) p.custom[tx.id] = url;
    if (sold) p.custom[sold.id] = true;
    p.updatedAt = Date.now();
    await DB.putPiece(p);
    markChanged();
    toast(r.serverId ? 'Sold! The Square transaction is saved on this piece.' : 'Sold! Square was offline, so the transaction link will open your Square sales list.', 4000);
    if (location.hash === '#/piece/' + encodeURIComponent(p.id)) route();
  }

  /** A sale started here whose result went to the Worker (e.g. Square came back in Safari):
   * fetch it and save it. Runs on open and whenever the app comes back to the screen. */
  let relayBusy = false;
  async function checkSquareRelay() {
    const pending = store(SQUARE_PENDING_KEY);
    if (!pending || !pending.key || !relayUrl() || relayBusy) return;
    if (Date.now() - pending.at > 24 * 3600 * 1000) { store(SQUARE_PENDING_KEY, null); return; } // the Worker forgets after a day
    relayBusy = true;
    try {
      const res = await fetch(relayUrl() + '/square/result', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: pending.key }),
      });
      if (res.status === 404) return; // still in Square, or not finished yet
      if (!res.ok) return;
      const r = await res.json();
      store(SQUARE_PENDING_KEY, null);
      await saveSquareSale({ ...r, pieceId: r.pieceId || pending.pieceId });
    } catch (e) { /* offline: try again next time */ } finally { relayBusy = false; }
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkSquareRelay(); });
  window.addEventListener('pageshow', (e) => { if (e.persisted) checkSquareRelay(); });

  /** The Square panel in Settings. */
  function drawSquareSettings(onFieldsChange) {
    const toggle = $('#squareOn');
    if (!toggle) return;
    const sq = Settings.square();
    toggle.checked = sq.enabled;
    $('#squareSetup').hidden = !sq.enabled;
    const idInput = $('#squareAppId');
    if (document.activeElement !== idInput) idInput.value = sq.appId || '';
    idInput.placeholder = 'sq0idp-…';
    $('#squareCallback').textContent = squareCallbackUrl();
    $('#squareNoId').hidden = !!squareAppId();
    // With an ID built into the app (config.js), there's nothing to set up here.
    const builtIn = !!(window.POTTERY_CONFIG || {}).squareAppId && !sq.appId;
    $('#squareForm').hidden = builtIn;
    $('#squareHelp').hidden = builtIn;
    if (toggle.dataset.wired) return;
    toggle.dataset.wired = '1';
    toggle.addEventListener('change', () => {
      Settings.setSquare({ enabled: toggle.checked });
      drawSquareSettings(onFieldsChange); onFieldsChange(); markChanged();
      toast(toggle.checked ? 'Square is on. Price, Sold and Transaction are on every piece.' : 'Square is off. Its fields stay until you remove them.');
    });
    $('#squareForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const id = idInput.value.trim();
      if (id && !/^[A-Za-z0-9_-]{6,100}$/.test(id)) { toast('That doesn\'t look like a Square application ID.'); return; }
      Settings.setSquare({ appId: id });
      drawSquareSettings(onFieldsChange); markChanged();
      toast(id ? 'Saved the Square application ID' : 'Removed the Square application ID');
    });
  }

  /* ---------- backup view ---------- */

  const fmtLimit = (n) => fmtBytes(n).replace(/\.0 MB$/, ' MB');

  /** The "Photo storage" part of Settings: how much room photos use against the limit. */
  async function drawStorage(est) {
    const usageEl = $('#photoUsage');
    if (!usageEl) return;
    const [{ bytes, limit }, e] = await Promise.all([PhotoCache.usage(), est ? est : DB.estimate()]);
    if (!usageEl.isConnected) return;
    const frac = Math.min(1, bytes / limit);
    $('#photoMeterBar').style.width = Math.max(1, Math.round(frac * 100)) + '%';
    $('#photoMeter').classList.toggle('full', bytes > limit);
    let text = 'Photos use ' + fmtBytes(bytes) + ' of ' + fmtLimit(limit) + '. ';
    text += PhotoCache.canRemoveNow()
      ? 'When they need more room, full-size photos of the pieces you opened longest ago are removed from this device. They stay in Google Drive and download again when you open the piece.'
      : 'Photos are only removed from this device once they\'re in Google Drive, so ' +
        (bytes > limit ? 'this device is over the limit. Connect Google Drive to make room.' : 'connect Google Drive to let the app make room when needed.');
    if (e && e.quota && limit > e.quota * 0.8) text += ' This browser allows about ' + fmtBytes(e.quota) + ' in all.';
    usageEl.textContent = text;
  }

  /** Notes and photo list of a synced piece, without downloading its photos. */
  const detailLoads = new Map();
  function loadDetails(id) {
    if (!detailLoads.has(id)) detailLoads.set(id, Sync.loadPiece(id, { photos: false }).finally(() => detailLoads.delete(id)));
    return detailLoads.get(id);
  }

  /**
   * Pick a glazing process's thumbnail from the photos of every piece that uses it (and the piece it was
   * saved from). Photos load only as they scroll into view, a few at a time, so a big log stays
   * quick. Resolves with { pieceId, photoId, fileId }, null for the default, or undefined.
   */
  function pickGlazingProcessPhoto(r, current) {
    return sheet('Thumbnail for “' + r.name + '”', async (form, close) => {
      const box = el('div', { class: 'photo-pick' });
      form.append(
        el('p', { class: 'muted small' }, 'Photos of the pieces that use this glazing process.'),
        box,
        el('div', { class: 'form-actions ask-actions' }, el('button', { type: 'submit', class: 'btn btn-ghost', value: 'cancel' }, 'Cancel')));
      const origin = r.pieceId ? await DB.getPiece(r.pieceId) : null;
      box.append(el('button', {
        type: 'button', class: 'btn btn-ghost btn-small default-pick', 'aria-pressed': String(!current), onclick: () => close(null),
      }, origin && !origin.deleted ? 'Default: last photo of “' + (origin.title || 'Untitled') + '”' : 'Default (no photo)'));
      const pieces = (await DB.allPieces()).filter((p) => !p.deleted && (p.glazingProcessId === r.id || p.id === r.pieceId))
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      const seen = new IntersectionObserver((entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          seen.unobserve(e.target);
          e.target.load();
        }
      }, { root: box, rootMargin: '200px' });
      form.closest('dialog').addEventListener('close', () => seen.disconnect());
      let any = false;
      for (const p0 of pieces) {
        const grid = el('div', { class: 'photo-grid' });
        const note = el('p', { class: 'muted small' });
        box.append(el('h3', null, p0.title || 'Untitled'), grid, note);
        let p = p0;
        if (p.stub) {
          if (!connected() || !navigator.onLine) { note.textContent = 'Connect to Google Drive to see this piece\'s photos.'; continue; }
          note.textContent = 'Loading from Google Drive…';
          try { p = await loadDetails(p.id); note.textContent = ''; } catch (err) { note.textContent = 'Could not load its photos.'; continue; }
          if (!box.isConnected) return;
        }
        const ids = p.photoIds || [];
        if (!ids.length) { note.textContent = 'No photos yet.'; continue; }
        any = true;
        for (const pid of ids) {
          const chosen = current && current.pieceId === p.id && current.photoId === pid;
          const btn = el('button', { type: 'button', 'aria-label': 'Use this photo of ' + (p.title || 'Untitled'), onclick: () => {
            close({ pieceId: p.id, photoId: pid, fileId: (p.sync && p.sync.photoFiles && p.sync.photoFiles[pid]) || undefined });
          } });
          const item = el('div', { class: 'photo-item' + (chosen ? ' chosen' : '') }, btn);
          item.load = () => piecePhotoUrl(p, pid).then((u) => { if (u) btn.replaceChildren(el('img', { src: u, alt: '' })); }).catch(() => {});
          grid.append(item);
          seen.observe(item);
        }
      }
      if (!pieces.length || (!any && !box.querySelector('.photo-grid:not(:empty)'))) {
        box.append(el('p', { class: 'muted small' }, pieces.length ? 'None of these pieces has photos yet.' : 'No piece uses this glazing process yet. Apply it to a piece, then pick one of its photos here.'));
      }
    });
  }

  /** Give every piece using a glazing process its new glazes. Pieces synced from another device are
   * loaded first, so the change isn't lost when they upload. Nothing changes unless all can be. */
  async function setGlazingProcessGlazes(glazingProcessId, glazes) {
    let using = (await DB.allPieces()).filter((p) => !p.deleted && p.glazingProcessId === glazingProcessId);
    const stubs = using.filter((p) => p.stub);
    if (stubs.length) {
      if (!connected() || !navigator.onLine) {
        throw new Error((stubs.length === 1 ? '1 piece' : stubs.length + ' pieces') + ' using this glazing process ' + (stubs.length === 1 ? 'hasn\'t' : 'haven\'t') +
          ' been opened on this device yet. Connect to Google Drive to change its glazes.');
      }
      toast('Loading ' + (stubs.length === 1 ? '1 piece' : stubs.length + ' pieces') + ' from Google Drive…', 2000);
      for (const p of stubs) await loadDetails(p.id);
      using = (await DB.allPieces()).filter((p) => !p.deleted && p.glazingProcessId === glazingProcessId);
    }
    const now = Date.now();
    for (const p of using) await DB.putPiece({ ...p, glazes: [...glazes], updatedAt: now });
    return using.length;
  }

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
      photoIds.length + (photoIds.length === 1 ? ' full-size photo' : ' full-size photos') + ' on this device' +
      (est && est.usage ? ' · about ' + fmtBytes(est.usage) + ' used in all' : '') +
      (stubs ? '. ' + stubs + ' synced ' + (stubs === 1 ? 'piece loads its' : 'pieces load their') + ' notes and photos when opened.' : '');
    const persisted = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted().catch(() => false) : false;
    if (!view.isConnected) return;
    const how = installHowTo();
    if (persisted) $('#persistLabel').textContent = 'Storage is marked persistent, so the browser won\'t clear it on its own.';
    else if (how) $('#persistLabel').innerHTML = 'Add the app to your home screen so the browser is less likely to clear its storage. ' + how;
    else if (!isInstalled()) $('#persistLabel').textContent = 'Tip: install the app (or add it to your home screen) so the browser is less likely to clear its storage.';
    else $('#persistLabel').hidden = true;

    // Photo storage limit.
    const limitSel = $('#photoLimit');
    const choices = [...PhotoCache.CHOICES_MB];
    if (!choices.includes(PhotoCache.limitMB())) choices.push(PhotoCache.limitMB()), choices.sort((a, b) => a - b);
    limitSel.replaceChildren(...choices.map((mb) => el('option', { value: String(mb) },
      fmtLimit(mb * 1024 * 1024) + (mb === PhotoCache.DEFAULT_MB ? ' (default)' : ''))));
    limitSel.value = String(PhotoCache.limitMB());
    limitSel.addEventListener('change', async () => {
      const r = await PhotoCache.setLimitMB(Number(limitSel.value));
      if (r && r.removed) toast('Made room by removing ' + r.removed + (r.removed === 1 ? ' photo' : ' photos') + ' that are in Google Drive', 3000);
      drawStorage();
    });
    drawStorage(est);

    function draw() {
      drawStorage();
      $('#driveUnconfigured').hidden = Drive.configured;
      $('#driveSignedOut').hidden = !Drive.configured || Drive.isSignedIn();
      const reconnect = Drive.needsReconnect();
      $('#reconnectNote').hidden = !reconnect;
      $('#localOnlyNote').hidden = reconnect;
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
    const fieldMeta = (f, locked) => Settings.TYPES[f.type] + (f.type === 'currency' ? ', new prices in ' + f.currency : '') +
      (locked ? ', used by Square' : '') +
      (f.type === 'choice' ? ': ' + f.options.join(', ')
        : f.type === 'text' && f.remember ? ', remembered' + (f.values.length ? ': ' + f.values.join(', ') : '') : '');
    function drawCustomFields() {
      const fields = Settings.fields();
      const locked = Settings.squareLockedIds();
      $('#cfList').replaceChildren(...fields.map((f) => {
        const li = el('li', { 'data-id': f.id },
          el('button', {
            class: 'drag-handle', type: 'button', html: ICON_GRIP,
            'aria-label': 'Move ' + f.name + ' (drag, or use the arrow keys)',
            onpointerdown: (e) => startFieldDrag(e, li),
            onkeydown: (e) => {
              if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
              e.preventDefault();
              const sib = e.key === 'ArrowUp' ? li.previousElementSibling : li.nextElementSibling;
              if (!sib) return;
              if (e.key === 'ArrowUp') li.after(sib); else li.before(sib); // keeps focus on the handle
              saveFieldOrder();
            },
          }),
          el('span', { class: 'cf-name' }, f.name),
          el('span', { class: 'cf-meta' }, fieldMeta(f, locked.has(f.id))),
          el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Edit ' + f.name, html: ICON_EDIT, onclick: () => editField(li, f) }),
          locked.has(f.id) ? el('span', { class: 'icon-btn-space', 'aria-hidden': 'true' }) : el('button', {
            class: 'icon-btn', type: 'button', 'aria-label': 'Remove ' + f.name, html: ICON_X,
            onclick: async () => {
              if (!(await ask({
                title: 'Remove “' + f.name + '”?',
                message: 'It disappears from every piece, here and on your other devices, and is left out of piece.json from then on.',
                confirm: 'Remove', danger: true,
              }))) return;
              Settings.removeField(f.id);
              drawCustomFields();
              markChanged();
            },
          }));
        return li;
      }));
      $('#cfList').hidden = !fields.length;
    }
    // Drag a field's handle to reorder (pointer events, so touch and mouse both work).
    function saveFieldOrder() {
      const ids = [...$('#cfList').children].map((li) => li.dataset.id);
      if (Settings.reorderFields(ids)) markChanged();
    }
    function startFieldDrag(e, li) {
      if (e.button !== undefined && e.button !== 0) return;
      e.preventDefault();
      const handle = e.currentTarget;
      try { handle.setPointerCapture(e.pointerId); } catch (err) { /* keep going without capture */ }
      li.classList.add('dragging');
      let lastY = e.clientY;
      const move = (ev) => {
        lastY = ev.clientY;
        // Move the neighbours rather than the dragged row, which would drop the pointer capture.
        const mid = (x) => { const r = x.getBoundingClientRect(); return r.top + r.height / 2; };
        let p;
        while ((p = li.previousElementSibling) && lastY < mid(p)) li.after(p);
        let n;
        while ((n = li.nextElementSibling) && lastY > mid(n)) li.before(n);
      };
      const end = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', end);
        handle.removeEventListener('pointercancel', end);
        li.classList.remove('dragging');
        saveFieldOrder();
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', end);
      handle.addEventListener('pointercancel', end);
    }

    // Edit a field in place: name, type, "remember values", and its list (choices or remembered values).
    function editField(li, f) {
      const name = el('input', { maxlength: '60', value: f.name, autocomplete: 'off' });
      const locked = Settings.squareLockedIds().has(f.id);
      const type = el('select', { disabled: locked, title: locked ? 'Square uses this field, so its type is fixed while Integrate with Square is on' : null },
        Object.entries(Settings.TYPES).map(([v, label]) => el('option', { value: v, selected: v === f.type }, label)));
      const currency = currencySelect(f.currency);
      const currencyRow = el('label', { class: 'field' }, el('span', null, 'Currency for new prices'), currency);
      const remember = el('input', { type: 'checkbox', checked: f.type !== 'text' || f.remember !== false });
      const rememberRow = el('label', { class: 'yesno' }, remember, el('b', null, 'Remember entered values for a drop-down'));
      const list = el('textarea', { rows: '4' });
      list.value = (f.type === 'choice' ? f.options : f.values || []).join('\n');
      const listLabel = el('span');
      const listRow = el('label', { class: 'field' }, listLabel, list);
      function sync() {
        const t = type.value;
        if (t === 'text' && type.dataset.was === 'choice') remember.checked = true; // choices become remembered values
        type.dataset.was = t;
        rememberRow.hidden = t !== 'text';
        currencyRow.hidden = t !== 'currency';
        listRow.hidden = !(t === 'choice' || (t === 'text' && remember.checked));
        listLabel.textContent = t === 'choice' ? 'Choices, one per line' : 'Remembered values, one per line';
      }
      type.dataset.was = f.type;
      type.addEventListener('change', sync); remember.addEventListener('change', sync);
      sync();
      const save = (e) => {
        e.preventDefault();
        try {
          Settings.editField(f.id, { name: name.value, type: type.value, remember: remember.checked, list: list.value.split('\n'), currency: currency.value });
          drawCustomFields(); markChanged();
          toast('Saved “' + name.value.trim() + '”');
        } catch (err) { toast(err.message); }
      };
      const form = el('form', { class: 'cf-edit' },
        el('div', { class: 'field-row' },
          el('label', { class: 'field' }, el('span', null, 'Field name'), name),
          el('label', { class: 'field' }, el('span', null, 'Type'), type)),
        currencyRow, el('div', { class: 'field' }, rememberRow), listRow,
        el('div', { class: 'cf-edit-actions' },
          el('button', { type: 'submit', class: 'btn btn-secondary btn-small' }, 'Save'),
          el('button', { type: 'button', class: 'btn btn-ghost btn-small', onclick: drawCustomFields }, 'Cancel')));
      form.addEventListener('submit', save);
      li.classList.add('editing');
      li.replaceChildren(form);
      name.focus();
    }
    $('#cfType').replaceChildren(...Object.entries(Settings.TYPES).map(([v, label]) => el('option', { value: v }, label)));
    $('#cfCurrency').replaceWith(Object.assign(currencySelect(), { id: 'cfCurrency' }));
    const syncAddForm = () => {
      $('#cfOptionsRow').hidden = $('#cfType').value !== 'choice';
      $('#cfRememberRow').hidden = $('#cfType').value !== 'text';
      $('#cfCurrencyRow').hidden = $('#cfType').value !== 'currency';
    };
    $('#cfType').addEventListener('change', syncAddForm);
    syncAddForm();
    $('#cfAddForm').addEventListener('submit', (e) => {
      e.preventDefault();
      try {
        const type = $('#cfType').value;
        const f = Settings.addField($('#cfName').value, type, type === 'choice' ? $('#cfOptions').value.split(',') : [], $('#cfRemember').checked, $('#cfCurrency').value);
        $('#cfName').value = ''; $('#cfOptions').value = '';
        drawCustomFields();
        markChanged();
        toast('Added “' + f.name + '” to every piece');
      } catch (err) {
        toast(err.message);
      }
    });
    drawCustomFields();
    drawSquareSettings(drawCustomFields);

    // Glaze and clay lists: one row each, edited in place as one-per-line text like a field's list.
    const LISTS = [
      { id: 'clays', name: 'Clay bodies', get: () => Settings.clays().map((c) => c.name), set: (names) => Settings.setClays(names.map((name) => ({ name }))) },
      { id: 'glazes', name: 'Glazes', get: () => Settings.glazes(), set: (names) => Settings.setGlazes(names) },
    ];
    function drawLists() {
      $('#listsEdit').replaceChildren(...LISTS.map((l) => {
        const items = l.get();
        const li = el('li', { 'data-id': l.id },
          el('span', { class: 'cf-name' }, l.name),
          el('span', { class: 'cf-meta' }, items.length ? items.length + ': ' + items.join(', ') : 'none yet'),
          el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Edit ' + l.name, html: ICON_EDIT, onclick: () => editList(li, l) }));
        return li;
      }));
    }
    function editList(li, l) {
      const list = el('textarea', { rows: '6', 'aria-label': l.name + ', one per line' });
      list.value = l.get().join('\n');
      const form = el('form', { class: 'cf-edit' },
        el('label', { class: 'field' }, el('span', null, l.name + ', one per line'), list),
        el('div', { class: 'cf-edit-actions' },
          el('button', { type: 'submit', class: 'btn btn-secondary btn-small' }, 'Save'),
          el('button', { type: 'button', class: 'btn btn-ghost btn-small', onclick: drawLists }, 'Cancel')));
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const seen = new Set();
        const names = list.value.split('\n').map((x) => x.trim().slice(0, 120))
          .filter((x) => { const k = x.toLowerCase(); if (!x || seen.has(k)) return false; seen.add(k); return true; });
        if (names.join('\n') !== l.get().join('\n')) { l.set(names); markChanged(); toast('Saved ' + l.name.toLowerCase()); }
        drawLists();
      });
      li.classList.add('editing');
      li.replaceChildren(form);
      list.focus();
    }
    drawLists();

    // Glazing processes: name, notes, glazes and thumbnail can all change.
    let glazingProcessAdding = false;
    async function drawGlazingProcesses() {
      const all = (await DB.allPieces()).filter((p) => !p.deleted);
      const listEl = $('#glazingProcessList');
      if (!listEl) return;
      const glazingProcesses = Settings.glazingProcesses();
      const uses = (r) => all.filter((p) => p.glazingProcessId === r.id).length;
      listEl.replaceChildren(...glazingProcesses.map((r) => {
        const n = uses(r);
        const li = el('li', { 'data-id': r.id },
          glazingProcessThumb(r),
          el('div', { class: 'cf-text' },
            el('span', { class: 'cf-name' }, r.name),
            el('span', { class: 'cf-meta' }, r.glazes.join(', ') + ' · ' + (n ? n + (n === 1 ? ' piece' : ' pieces') : 'not used yet'))),
          el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Edit ' + r.name, html: ICON_EDIT, onclick: () => editGlazingProcess(li, r) }),
          n ? el('span', { class: 'icon-btn-space', 'aria-hidden': 'true' }) : el('button', {
            class: 'icon-btn', type: 'button', 'aria-label': 'Remove ' + r.name, html: ICON_X,
            onclick: async () => {
              if (!(await ask({ title: 'Remove “' + r.name + '”?', message: 'No piece uses it. It is removed here and on your other devices.', confirm: 'Remove', danger: true }))) return;
              Settings.removeGlazingProcess(r.id);
              drawGlazingProcesses();
              markChanged();
            },
          }));
        return li;
      }));
      listEl.hidden = !glazingProcesses.length;
      $('#glazingProcessEmpty').hidden = !!glazingProcesses.length;
      if (!glazingProcessAdding) drawGlazingProcessAdd();
    }

    function drawGlazingProcessAdd() {
      $('#glazingProcessAddBox').replaceChildren(el('button', {
        type: 'button', class: 'btn btn-secondary btn-small',
        onclick: () => { glazingProcessAdding = true; openGlazingProcessAdd(); },
      }, 'New glazing process'));
    }
    function openGlazingProcessAdd() {
      const glazes = [];
      const name = el('input', { maxlength: '80', autocomplete: 'off', placeholder: 'e.g. Celadon over tenmoku, dipped' });
      const notes = el('textarea', { rows: '4', maxlength: '4000', placeholder: 'How you apply the glazes: order, dips, seconds, thickness, wax…' });
      const pickBox = el('div', { class: 'tag-picker' });
      const form = el('form', { class: 'cf-edit' },
        el('label', { class: 'field' }, el('span', null, 'Name'), name),
        el('div', { class: 'field' }, el('span', null, 'Glazes'), pickBox),
        el('label', { class: 'field' }, el('span', null, 'Notes'), notes),
        el('p', { class: 'muted small' }, 'Its thumbnail can be picked later from photos of the pieces that use it.'),
        el('div', { class: 'cf-edit-actions' },
          el('button', { type: 'submit', class: 'btn btn-secondary btn-small' }, 'Save glazing process'),
          el('button', { type: 'button', class: 'btn btn-ghost btn-small', onclick: () => { glazingProcessAdding = false; drawGlazingProcessAdd(); } }, 'Cancel')));
      const pick = tagPicker(pickBox, glazes, 'glaze');
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        pick.flush();
        try {
          const r = Settings.addGlazingProcess({ name: name.value, glazes, notes: notes.value.trim() });
          glazingProcessAdding = false;
          drawGlazingProcesses(); drawLists(); markChanged();
          toast('Saved “' + r.name + '”');
        } catch (err) { toast(err.message); }
      });
      $('#glazingProcessAddBox').replaceChildren(form);
      name.focus();
    }

    function editGlazingProcess(li, r) {
      let thumb; // undefined: unchanged, null: back to the default, or { pieceId, photoId, fileId }
      const name = el('input', { maxlength: '80', value: r.name, autocomplete: 'off' });
      const notes = el('textarea', { rows: '5', maxlength: '4000', placeholder: 'How you apply the glazes: order, dips, seconds, thickness, wax…' });
      notes.value = r.notes || '';
      const preview = el('div', { class: 'process-thumb-row' });
      const drawPreview = () => {
        const shown = thumb === undefined ? r : { ...r, thumb: thumb || undefined };
        preview.replaceChildren(glazingProcessThumb(shown, { big: true }),
          el('button', { type: 'button', class: 'btn btn-secondary btn-small', onclick: async () => {
            const got = await pickGlazingProcessPhoto(r, thumb === undefined ? r.thumb || null : thumb);
            if (got !== undefined) { thumb = got; drawPreview(); }
          } }, 'Choose thumbnail'));
      };
      drawPreview();
      // Glazes: editable straight away while no piece uses the glazing process. Otherwise "Change glazes"
      // first says how many pieces will change, and saving updates them all.
      const glazes = [...r.glazes];
      let glazesOpen = false;
      const glazeBox = el('div', { class: 'tag-picker' });
      const glazeNote = el('p', { class: 'muted small' });
      let glazePick = { flush: () => {} };
      const openGlazes = () => { glazesOpen = true; glazePick = tagPicker(glazeBox, glazes, 'glaze'); glazeNote.hidden = true; };
      const usedBy = async () => (await DB.allPieces()).filter((p) => !p.deleted && p.glazingProcessId === r.id);
      usedBy().then((using) => {
        if (!using.length) { openGlazes(); return; }
        glazeBox.replaceChildren(el('div', { class: 'tags' }, r.glazes.map((g) => el('span', { class: 'tag locked' }, g))),
          el('div', { class: 'process-actions' }, el('button', {
            type: 'button', class: 'btn btn-ghost btn-small',
            onclick: async () => {
              const n = (await usedBy()).length;
              if (!(await ask({
                title: 'Change the glazes on ' + n + (n === 1 ? ' piece?' : ' pieces?'),
                message: [(n === 1 ? '1 piece uses' : n + ' pieces use') + ' “' + r.name + '”. When you save, the new glazes replace the glazes on ' + (n === 1 ? 'that piece' : 'all of them') + ', here and on your other devices.'],
                confirm: 'Change glazes',
              }))) return;
              openGlazes();
            },
          }, 'Change glazes')));
        glazeNote.textContent = (using.length === 1 ? '1 piece uses' : using.length + ' pieces use') + ' this glazing process, so changing its glazes changes ' + (using.length === 1 ? 'that piece' : 'those pieces') + ' too.';
      });
      const form = el('form', { class: 'cf-edit' },
        el('label', { class: 'field' }, el('span', null, 'Name'), name),
        el('div', { class: 'field' }, el('span', null, 'Glazes'), glazeBox, glazeNote),
        el('label', { class: 'field' }, el('span', null, 'Notes'), notes),
        el('div', { class: 'field' }, el('span', null, 'Thumbnail'), preview),
        el('div', { class: 'cf-edit-actions' },
          el('button', { type: 'submit', class: 'btn btn-secondary btn-small' }, 'Save'),
          el('button', { type: 'button', class: 'btn btn-ghost btn-small', onclick: drawGlazingProcesses }, 'Cancel')));
      let saving = false;
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (saving) return;
        glazePick.flush();
        const changes = {};
        if (name.value.trim() !== r.name) changes.name = name.value;
        if (notes.value.trim() !== (r.notes || '')) changes.notes = notes.value.trim();
        if (thumb !== undefined && JSON.stringify(thumb) !== JSON.stringify(r.thumb || null)) changes.thumb = thumb;
        if (glazesOpen && glazes.join('\n') !== r.glazes.join('\n')) changes.glazes = [...glazes];
        saving = true;
        try {
          if (changes.glazes && !glazes.length) throw new Error('Add at least one glaze');
          if (changes.name) Settings.checkGlazingProcessName(changes.name, r.id);
          const changed = changes.glazes ? await setGlazingProcessGlazes(r.id, glazes) : 0;
          if (Object.keys(changes).length) {
            Settings.editGlazingProcess(r.id, changes); markChanged();
            toast('Saved “' + name.value.trim() + '”' + (changed ? ' and updated ' + changed + (changed === 1 ? ' piece' : ' pieces') : ''));
          }
          drawGlazingProcesses(); drawLists();
        } catch (err) { toast(err.message, 4000); } finally { saving = false; }
      });
      li.classList.add('editing');
      li.replaceChildren(form);
      name.focus();
    }
    drawGlazingProcesses();

    onBackupStateChange = () => {
      draw(); drawSquareSettings(drawCustomFields);
      if (!$('#cfList .editing')) drawCustomFields(); // keep an open field editor
      if (!$('#listsEdit .editing')) drawLists();
      if (!$('#glazingProcessList .editing')) drawGlazingProcesses();
    };

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
      if (!(await ask({
        title: 'Disconnect Google Drive?',
        message: 'Your files stay in Drive and your pieces stay on this device. Pieces from Drive that haven\'t been opened here yet will show only their summary until you reconnect.',
        confirm: 'Disconnect', danger: true,
      }))) return;
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

  /** Tell the person when the same field was changed on two devices, and which change was kept. */
  function showConflicts(list) {
    const items = el('ul', { class: 'ask-list' }, list.map((c) => el('li', null,
      el('a', { href: '#/piece/' + encodeURIComponent(c.id) }, c.title || 'Untitled'),
      ': ' + c.fields.join(', '))));
    items.addEventListener('click', (e) => { if (e.target.closest('a')) e.target.closest('dialog').close(); });
    ask({
      title: list.length === 1 ? 'A piece was changed on two devices' : list.length + ' pieces were changed on two devices',
      message: [
        'These fields were changed differently on another device before they synced. The latest change was kept for each one, and the other change was replaced:',
        items,
        'Everything else from both devices was combined.',
      ],
      confirm: 'OK', cancel: null,
    });
  }

  function syncSummary(st) {
    if (!st) return '';
    const parts = [];
    if (st.pulled) parts.push(st.pulled + (st.pulled === 1 ? ' piece' : ' pieces') + ' updated from Drive');
    if (st.merged) parts.push(st.merged + (st.merged === 1 ? ' piece' : ' pieces') + ' combined with changes from another device');
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
      if (stats.conflicts && stats.conflicts.length) showConflicts(stats.conflicts);
      if (stats.pulled || stats.removed || stats.merged || stats.settings === 'pulled') {
        if (!opts.throws) toast(syncSummary(stats), 2500);
        // Show what came from Drive, unless a form is being edited.
        if (!/^#\/(edit|new|backup)/.test(location.hash)) route();
      } else if (stats.pushed && !opts.quiet && !opts.throws) {
        toast('Synced with Google Drive', 1600);
      }
      if (await seedLists(true)) await refreshPending();
      PhotoCache.check(); // photos just uploaded can now be removed from the device if it's full
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
    const moved = Settings.takeCurrencyNotice();
    if (moved) {
      toast('New ' + moved.name.toLowerCase() + 's will be in ' + moved.to + ' (was ' + moved.from + '), the currency where you are. Existing ones keep theirs. Change it in Settings.', 7000);
      if (onBackupStateChange && location.hash.startsWith('#/backup')) onBackupStateChange();
    }
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

  /** Prices saved as plain numbers (before each price carried its currency) get the currency
   * they were entered in, so a later change of the default doesn't change them. Local only:
   * piece.json picks it up on the next save, and other devices do the same when they read it. */
  async function pinOldPrices() {
    if (!Settings.fields().some((f) => f.type === 'currency')) return;
    for (const p of await DB.allPieces()) {
      const custom = !p.deleted && Settings.pinPrices(p.custom);
      if (custom) await DB.putPiece({ ...p, custom });
    }
  }

  /** Load a synced piece's notes and photos the first time it's opened on this device. */
  const loading = new Map();
  function loadOnDemand(id) {
    if (!connected()) return Promise.reject(Object.assign(new Error('Not connected'), { reconnect: true }));
    if (!loading.has(id)) {
      loading.set(id, Sync.loadPiece(id).finally(() => { loading.delete(id); PhotoCache.check(); }));
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
    const squareReturn = readSquareReturn(); // Square just finished (or cancelled) a sale
    window.addEventListener('hashchange', route);
    route();
    if (squareReturn) saveSquareSale(squareReturn).catch((e) => toast(e.message || 'Could not save the Square sale.', 5000));
    else checkSquareRelay();

    Sync.init({ makeThumb });
    PhotoCache.init({
      canRemove: () => connected() && !!Drive.getFolder(), // only photos already in Drive are ever removed
      root: () => (Drive.getFolder() || {}).id,
      onChange: () => { if (onBackupStateChange && location.hash.startsWith('#/backup')) drawStorage(); },
    });
    PhotoCache.check(3000);
    await pinOldPrices();
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
