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
  const PHOTO_MAX = 1600;
  const THUMB_MAX = 480;
  const LAST_SYNC_KEY = 'potteryLog.lastSync';
  const FILTER_KEY = 'potteryLog.filter';
  const AUTO_KEY = 'potteryLog.autoBackup';
  const INSTALL_TIP_KEY = 'potteryLog.installTipDismissed';
  const PENDING_AUTO_KEY = 'potteryLog.pendingAutoBackup'; // choice made just before leaving for Google sign-in

  const $ = (sel, root = document) => root.querySelector(sel);
  const app = $('#app');
  const titleEl = $('#pageTitle');
  const backBtn = $('#backBtn');
  const addBtn = $('#addBtn');
  const backupNavBtn = $('#backupNavBtn');

  const ICON_X = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
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

  function drawInstallTip() {
    const tip = $('#installTip');
    if (!tip) return;
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

  /* ---------- list view ---------- */

  async function renderList() {
    setChrome({ title: 'Pottery Log', back: false, fab: true });
    mount('tpl-list');
    const pieces = (await DB.allPieces()).filter((p) => !p.deleted);
    pieces.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

    let filter = store(FILTER_KEY) || 'all';
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
      if (!query) return true;
      const hay = [p.title, p.clayBody, METHOD_LABEL[p.method], (p.glazes || []).join(' '), p.firingType,
        coneLabel(p.cone), p.notes].join(' ').toLowerCase();
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
        const sub = [p.clayBody, (p.glazes || []).join(', ')].filter(Boolean).join(' · ') || METHOD_LABEL[p.method] || '';
        return el('li', null, el('button', { class: 'card', onclick: () => nav('#/piece/' + encodeURIComponent(p.id)) },
          thumb,
          el('div', { class: 'meta' },
            el('div', { class: 'title' }, p.title || 'Untitled'),
            sub ? el('div', { class: 'sub' }, sub) : null,
            stagePill(p.stage))));
      }));
    }

    searchEl.addEventListener('input', () => { query = searchEl.value.trim().toLowerCase(); drawCards(); });
    drawInstallTip();
    drawChips();
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
        note.textContent = err.reconnect ? 'Reconnect Google Drive (cloud icon) to see this piece\'s notes and photos.'
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
    add('Clay body', p.clayBody);
    add('Forming', METHOD_LABEL[p.method]);
    if (p.glazes && p.glazes.length) add('Glazes', el('div', { class: 'glaze-list' }, p.glazes.map((g) => el('span', null, g))));
    add('Firing', [p.firingType, coneLabel(p.cone)].filter(Boolean).join(', '));
    add('Made', fmtDate(p.dateMade));
    add('Bisque fired', fmtDate(p.dateBisque));
    add('Glaze fired', fmtDate(p.dateGlazed));
    add('Finished', fmtDate(p.dateDone));
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
      id: DB.uid(), title: '', photoIds: [], clayBody: '', method: 'wheel', glazes: [],
      firingType: '', cone: '', stage: 'greenware', dateMade: today(), dateBisque: '', dateGlazed: '',
      dateDone: '', notes: '', createdAt: Date.now(),
    };
    const originalPhotos = new Set(existing ? existing.photoIds || [] : []);
    const addedPhotos = new Set();
    let saved = false;

    setChrome({ title: isNew ? 'New piece' : 'Edit piece', back: true, fab: false });
    mount('tpl-edit');
    const form = $('#editForm');
    const f = form.elements;

    // Autocomplete from previous pieces.
    const all = (await DB.allPieces()).filter((p) => !p.deleted);
    const uniq = (arr) => [...new Set(arr.filter(Boolean).map((s) => s.trim()))].sort((a, b) => a.localeCompare(b));
    $('#clayList').replaceChildren(...uniq(all.map((p) => p.clayBody)).map((v) => el('option', { value: v })));
    $('#glazeList').replaceChildren(...uniq(all.flatMap((p) => p.glazes || [])).map((v) => el('option', { value: v })));

    // Cones.
    f.cone.append(...CONES.map((c) => el('option', { value: c }, 'Cone ' + c)));

    // Stage segmented control.
    $('#stageSeg').replaceChildren(...STAGES.map((s) =>
      el('label', null, el('input', { type: 'radio', name: 'stage', value: s.id }), el('span', null, s.label))));

    // Fill values.
    f.title.value = piece.title;
    f.clayBody.value = piece.clayBody;
    form.querySelectorAll('input[name=method]').forEach((r) => { r.checked = r.value === piece.method; });
    f.firingType.value = piece.firingType;
    if (piece.firingType && f.firingType.value !== piece.firingType) {
      f.firingType.append(el('option', null, piece.firingType));
      f.firingType.value = piece.firingType;
    }
    f.cone.value = piece.cone;
    form.querySelectorAll('input[name=stage]').forEach((r) => { r.checked = r.value === piece.stage; });
    ['dateMade', 'dateBisque', 'dateGlazed', 'dateDone'].forEach((k) => { f[k].value = piece[k] || ''; });
    f.notes.value = piece.notes;

    // Stage change fills in that stage's date if empty.
    form.querySelectorAll('input[name=stage]').forEach((r) => r.addEventListener('change', () => {
      const s = STAGE_BY_ID[r.value];
      if (s && !f[s.date].value) f[s.date].value = today();
    }));

    // Glazes.
    const glazeInput = $('#glazeInput');
    function drawGlazes() {
      $('#glazeTags').replaceChildren(...piece.glazes.map((g, i) => el('span', { class: 'tag' }, g,
        el('button', { type: 'button', 'aria-label': 'Remove ' + g, html: ICON_X, onclick: () => { piece.glazes.splice(i, 1); drawGlazes(); } }))));
    }
    function addGlaze() {
      const v = glazeInput.value.trim();
      if (v && !piece.glazes.some((g) => g.toLowerCase() === v.toLowerCase())) piece.glazes.push(v);
      glazeInput.value = '';
      drawGlazes();
    }
    glazeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addGlaze(); } });
    $('#glazeAddBtn').addEventListener('click', () => { addGlaze(); glazeInput.focus(); });
    drawGlazes();

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
      if (glazeInput.value.trim()) addGlaze();
      const title = f.title.value.trim();
      if (!title) { toast('Give the piece a title'); f.title.focus(); return; }
      piece.title = title;
      piece.clayBody = f.clayBody.value.trim();
      piece.method = (form.querySelector('input[name=method]:checked') || {}).value || '';
      piece.firingType = f.firingType.value;
      piece.cone = f.cone.value;
      piece.stage = (form.querySelector('input[name=stage]:checked') || {}).value || 'greenware';
      ['dateMade', 'dateBisque', 'dateGlazed', 'dateDone'].forEach((k) => { piece[k] = f[k].value; });
      piece.notes = f.notes.value.trim();
      piece.updatedAt = Date.now();
      await DB.putPiece(piece);
      saved = true;
      const kept = new Set(piece.photoIds);
      const removed = [...originalPhotos, ...addedPhotos].filter((pid) => !kept.has(pid));
      await DB.deletePhotos(removed);
      markChanged();
      toast(isNew ? 'Piece added' : 'Saved');
      DB.requestPersistence();
      if (isNew) nav('#/piece/' + encodeURIComponent(piece.id), true);
      else backBtn.click();
    });

    if (isNew) f.title.focus();
  }

  /* ---------- backup view ---------- */

  async function renderBackup() {
    setChrome({ title: 'Backup', back: true, fab: false });
    mount('tpl-backup');

    const pieces = (await DB.allPieces()).filter((p) => !p.deleted);
    const photoIds = await DB.allPhotoIds();
    const est = await DB.estimate();
    const stubs = pieces.filter((p) => p.stub).length;
    $('#localStats').textContent = pieces.length + (pieces.length === 1 ? ' piece' : ' pieces') + ', ' +
      photoIds.length + (photoIds.length === 1 ? ' photo' : ' photos') +
      (est && est.usage ? ' · about ' + fmtBytes(est.usage) + ' used' : '') +
      (stubs ? '. ' + stubs + ' synced ' + (stubs === 1 ? 'piece loads its' : 'pieces load their') + ' notes and photos when opened.' : '');
    const persisted = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted().catch(() => false) : false;
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
      $('#autoBackupConnectRow').hidden = reconnect;
      $('#signInLabel').textContent = reconnect ? 'Reconnect Google Drive' : 'Sign in with Google';
      $('#driveSignedIn').hidden = !Drive.configured || !Drive.isSignedIn();
      const acct = Drive.getAccount();
      if (acct) $('#accountLabel').textContent = 'Signed in as ' + (acct.email || acct.name || 'Google user');
      const folder = Drive.getFolder();
      $('#folderLabel').textContent = folder ? folder.name : 'Not chosen yet';
      $('#pickFolderBtn').textContent = folder ? 'Change folder' : 'Choose folder';
      $('#autoBackupToggle').checked = store(AUTO_KEY) === true;
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

    $('#signInBtn').addEventListener('click', () => {
      // Remember the auto-sync choice across the trip to Google and back.
      if (!Drive.needsReconnect()) {
        try { sessionStorage.setItem(PENDING_AUTO_KEY, $('#autoBackupConnect').checked ? '1' : '0'); } catch (e) { /* ignore */ }
      }
      Drive.signIn();
    });

    // Check the saved folder still exists.
    if (Drive.configured && Drive.isSignedIn()) {
      Drive.resolveFolder().then(draw).catch((err) => { if (err.reconnect) draw(); });
    }

    async function afterFolderChange(name, verb) {
      await refreshPending();
      draw();
      toast(verb + ' “' + name + '”. Syncing…');
      runSync({ quiet: false });
    }

    $('#pickFolderBtn').addEventListener('click', async () => {
      try {
        const f = await Drive.pickFolder();
        if (f) afterFolderChange(f.name, 'Syncing with');
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

    $('#autoBackupToggle').addEventListener('change', (e) => {
      store(AUTO_KEY, e.target.checked);
      updateBadge();
      if (e.target.checked) {
        toast(Drive.getFolder() ? 'Will sync after every save' : 'Choose a Drive folder to start syncing');
        if (pendingCount) runSync();
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
  const autoOn = () => connected() && store(AUTO_KEY) === true;

  async function refreshPending() {
    const f = Drive.getFolder();
    pendingCount = connected() && f ? await Sync.pendingCount(f.id) : 0;
    updateBadge();
  }

  function updateBadge() {
    const pending = Drive.configured && ((Drive.isSignedIn() && pendingCount > 0) || Drive.needsReconnect());
    backupNavBtn.classList.toggle('dirty', pending && !syncing);
    backupNavBtn.classList.toggle('syncing', syncing);
    backupNavBtn.setAttribute('aria-label', syncing ? 'Syncing…'
      : Drive.needsReconnect() ? 'Backup and settings (Google Drive needs reconnecting)'
      : pending ? 'Backup and settings (changes not synced yet)' : 'Backup and settings');
  }

  /** Call after any local change to a piece. */
  function markChanged() {
    refreshPending().then(() => { if (autoOn() && pendingCount) runSync(); });
  }

  function syncSummary(st) {
    if (!st) return '';
    const parts = [];
    if (st.pulled) parts.push(st.pulled + (st.pulled === 1 ? ' piece' : ' pieces') + ' updated from Drive');
    if (st.removed) parts.push(st.removed + ' removed');
    if (st.pushed) parts.push(st.pushed + ' saved to Drive');
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
          toast(failed.reconnect ? 'Google Drive needs reconnecting. Tap the cloud icon.' : 'Sync failed: ' + failed.message, 5000);
        }
        return null; // wait for the next save, launch or reconnect instead of retrying in a loop
      }
      if (stats.pulled || stats.removed) {
        if (!opts.throws) toast(syncSummary(stats), 2500);
        // Show what came from Drive, unless a form is being edited.
        if (!/^#\/(edit|new|backup)/.test(location.hash)) route();
      } else if (stats.pushed && !opts.quiet && !opts.throws) {
        toast('Synced with Google Drive', 1600);
      }
      if (pendingCount && autoOn()) runSync({ quiet: true }); // changes made while syncing
      return stats;
    });
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
    try { localStorage.removeItem('potteryLog.changeSeq'); localStorage.removeItem('potteryLog.backedSeq'); localStorage.removeItem('potteryLog.lastBackup'); localStorage.removeItem('potteryLog.deviceId'); } catch (e) { /* ignore */ }
    refreshPending().catch(() => {});

    if (auth && auth.connected) {
      let pendingAuto = null;
      try { pendingAuto = sessionStorage.getItem(PENDING_AUTO_KEY); sessionStorage.removeItem(PENDING_AUTO_KEY); } catch (e) { /* ignore */ }
      if (pendingAuto !== null) store(AUTO_KEY, pendingAuto === '1');
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
