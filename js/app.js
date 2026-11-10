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
  const LAST_BACKUP_KEY = 'potteryLog.lastBackup';
  const DEVICE_KEY = 'potteryLog.deviceId';
  const FILTER_KEY = 'potteryLog.filter';
  const AUTO_KEY = 'potteryLog.autoBackup';
  const CHANGE_KEY = 'potteryLog.changeSeq';   // bumped on every local change
  const BACKED_KEY = 'potteryLog.backedSeq';   // change number covered by the last backup

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

  function deviceId() {
    let id = store(DEVICE_KEY);
    if (!id) { id = DB.uid(); store(DEVICE_KEY, id); }
    return id;
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

  /* ---------- list view ---------- */

  async function renderList() {
    setChrome({ title: 'Pottery Log', back: false, fab: true });
    mount('tpl-list');
    const pieces = await DB.allPieces();
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
          photoUrl(p.photoIds[0]).then((u) => { if (u) thumb.replaceChildren(el('img', { src: u, alt: '', loading: 'lazy' })); });
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
    drawChips();
    drawCards();
  }

  /* ---------- detail view ---------- */

  async function renderDetail(id) {
    const p = await DB.getPiece(id);
    if (!p) { toast('That piece was not found.'); return nav('#/', true); }
    setChrome({ title: p.title || 'Untitled', back: true, fab: false });
    mount('tpl-detail');

    const gallery = $('#gallery');
    const ids = p.photoIds || [];
    if (!ids.length) {
      gallery.replaceChildren(el('div', { class: 'no-photo', html: ICON_POT }));
    } else {
      gallery.classList.toggle('single', ids.length === 1);
      const imgs = await Promise.all(ids.map(async (pid) => {
        const u = await photoUrl(pid, 'full');
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
    if (next) {
      adv.hidden = false;
      adv.textContent = 'Mark as ' + next.label.toLowerCase();
      adv.onclick = async () => {
        prepareAutoBackup();
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

    $('#editBtn').onclick = () => nav('#/edit/' + encodeURIComponent(p.id));
    $('#deleteBtn').onclick = async () => {
      if (!confirm('Delete "' + (p.title || 'Untitled') + '" and its photos? This cannot be undone.')) return;
      prepareAutoBackup();
      await DB.deletePiece(p.id);
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
    if (id && !existing) { toast('That piece was not found.'); return nav('#/', true); }
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
    const all = await DB.allPieces();
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
        const u = await photoUrl(pid);
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
      prepareAutoBackup();
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
    Drive.preload();

    const pieces = await DB.allPieces();
    const photoIds = await DB.allPhotoIds();
    const est = await DB.estimate();
    $('#localStats').textContent = pieces.length + (pieces.length === 1 ? ' piece' : ' pieces') + ', ' +
      photoIds.length + (photoIds.length === 1 ? ' photo' : ' photos') +
      (est && est.usage ? ' · about ' + fmtBytes(est.usage) + ' used' : '');
    const persisted = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted().catch(() => false) : false;
    $('#persistLabel').textContent = persisted
      ? 'Storage is marked persistent, so the browser won\'t clear it on its own.'
      : 'Tip: add the app to your home screen so the browser is less likely to clear its storage.';

    function draw() {
      $('#driveUnconfigured').hidden = Drive.configured;
      $('#driveSignedOut').hidden = !Drive.configured || Drive.isSignedIn();
      $('#driveSignedIn').hidden = !Drive.configured || !Drive.isSignedIn();
      const acct = Drive.getAccount();
      if (acct) $('#accountLabel').textContent = 'Signed in as ' + (acct.email || acct.name || 'Google user');
      const folder = Drive.getFolder();
      $('#folderLabel').textContent = folder ? folder.name : 'Not chosen yet';
      $('#pickFolderBtn').textContent = folder ? 'Change folder' : 'Choose folder';
      $('#autoBackupToggle').checked = store(AUTO_KEY) === true;
      const last = store(LAST_BACKUP_KEY);
      let label = last ? 'Last backup: ' + fmtDateTime(last.at) + '.' : 'Not backed up yet from this device.';
      if (last && isDirty()) label += ' You have changes since then.';
      $('#lastBackupLabel').textContent = label;
      updateBadge();
    }
    draw();

    const progress = $('#driveProgress');
    const bar = $('#driveProgressBar');
    const ptext = $('#driveProgressText');
    const buttons = ['#backupBtn', '#restoreBtn', '#signOutBtn', '#pickFolderBtn', '#newFolderBtn'].map((s) => $(s));
    function busy(on, text, frac) {
      buttons.forEach((b) => { b.disabled = on; });
      progress.hidden = !on;
      if (on) { ptext.textContent = text || ''; bar.style.width = Math.round((frac || 0) * 100) + '%'; }
    }

    // Redraw when a background backup finishes while this page is open.
    onBackupStateChange = draw;

    $('#signInBtn').addEventListener('click', async () => {
      try {
        await Drive.signIn();
        store(AUTO_KEY, $('#autoBackupConnect').checked);
        draw();
        toast(Drive.getFolder() ? 'Connected to Google Drive' : 'Connected. Now choose or create a backup folder.', 3500);
        if (Drive.getFolder()) kickAutoBackup();
      } catch (err) {
        toast(err.message);
      }
    });

    // Check the saved folder still exists (only when we can do it without a sign-in popup).
    if (Drive.configured && Drive.isSignedIn() && Drive.hasToken()) {
      Drive.resolveFolder().then(draw).catch(() => {});
    }

    $('#pickFolderBtn').addEventListener('click', async () => {
      try {
        await Drive.ensureToken();
        const f = await Drive.pickFolder();
        if (f) { folderChanged(); draw(); toast('Backups will go to “' + f.name + '”'); kickAutoBackup(); }
      } catch (err) {
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
        await Drive.ensureToken();
        busy(true, 'Creating folder…', 0.5);
        const f = await Drive.createFolder(name);
        busy(false);
        newForm.hidden = true;
        folderChanged();
        draw();
        toast('Created “' + f.name + '” in My Drive');
        kickAutoBackup();
      } catch (err) {
        busy(false);
        toast(err.message, 4000);
      }
    });

    $('#autoBackupToggle').addEventListener('change', (e) => {
      store(AUTO_KEY, e.target.checked);
      updateBadge();
      if (e.target.checked) {
        toast(Drive.getFolder() ? 'Will back up after every save' : 'Choose a backup folder to start backing up');
        prepareAutoBackup();
        kickAutoBackup();
      }
    });

    $('#signOutBtn').addEventListener('click', async () => {
      await Drive.signOut();
      draw();
      toast('Signed out');
    });

    $('#backupBtn').addEventListener('click', async () => {
      try {
        await Drive.ensureToken(); // first, so a popup (if needed) belongs to this tap
        await queueTask(() => backup((t, f) => busy(true, t, f)));
        busy(false);
        draw();
        toast('Backed up to Google Drive');
      } catch (err) {
        busy(false);
        draw();
        if (err.message !== 'cancelled') toast(err.message, 4000);
      }
    });

    $('#restoreBtn').addEventListener('click', async () => {
      try {
        await Drive.ensureToken();
        const n = await queueTask(() => restore((t, f) => busy(true, t, f)));
        busy(false);
        toast('Restored ' + n + (n === 1 ? ' piece' : ' pieces'));
        renderBackup();
      } catch (err) {
        busy(false);
        draw();
        if (err.message !== 'cancelled') toast(err.message, 4000);
      }
    });
  }

  const NO_FOLDER = 'Choose or create a backup folder first.';

  /* ---------- automatic backup ---------- */

  let onBackupStateChange = null;
  let tokenRequest = null;
  let autoQueued = false;
  let syncing = false;
  let taskChain = Promise.resolve();

  /** Run Drive tasks one at a time so manual and automatic backups never overlap. */
  function queueTask(fn) {
    const p = taskChain.then(fn, fn);
    taskChain = p.catch(() => {});
    return p;
  }

  const autoOn = () => Drive.configured && Drive.isSignedIn() && store(AUTO_KEY) === true;
  const isDirty = () => (store(CHANGE_KEY) || 0) > (store(BACKED_KEY) || 0);

  function updateBadge() {
    const pending = Drive.configured && Drive.isSignedIn() && isDirty();
    backupNavBtn.classList.toggle('dirty', pending && !syncing);
    backupNavBtn.classList.toggle('syncing', syncing);
    backupNavBtn.setAttribute('aria-label', syncing ? 'Backing up…'
      : pending ? 'Backup and settings (changes not backed up)' : 'Backup and settings');
  }

  /** A new backup folder starts empty, so everything needs backing up again. */
  function folderChanged() {
    store(BACKED_KEY, 0);
    if (!(store(CHANGE_KEY) > 0)) store(CHANGE_KEY, 1);
    updateBadge();
  }

  function markChanged() {
    store(CHANGE_KEY, (store(CHANGE_KEY) || 0) + 1);
    updateBadge();
    kickAutoBackup();
  }

  /**
   * Call at the very start of a tap that changes data. Google access tokens last an hour;
   * if ours has expired, getting a new one opens Google's popup (it closes by itself),
   * and browsers only allow that popup during a tap.
   */
  function prepareAutoBackup() {
    if (autoOn() && !Drive.hasToken() && !tokenRequest) {
      tokenRequest = Drive.ensureToken().catch(() => null).finally(() => { tokenRequest = null; });
    }
  }

  async function kickAutoBackup() {
    if (!autoOn() || !isDirty() || autoQueued) return;
    autoQueued = true;
    if (tokenRequest) await tokenRequest;
    return queueTask(async () => {
      autoQueued = false;
      if (!autoOn() || !isDirty() || !Drive.getFolder()) return;
      if (!Drive.hasToken()) { updateBadge(); return; } // waits for the next tap or manual backup
      syncing = true; updateBadge();
      let ok = false;
      try {
        await backup(() => {}, { auto: true });
        ok = true;
        toast('Backed up to Google Drive', 1600);
      } catch (err) {
        toast('Automatic backup failed: ' + err.message, 5000);
      } finally {
        syncing = false; updateBadge();
        if (onBackupStateChange && location.hash.startsWith('#/backup')) onBackupStateChange();
      }
      // Pick up changes made while uploading. After a failure, wait for the next save,
      // launch or reconnect instead of retrying in a loop.
      if (ok && isDirty()) kickAutoBackup();
    });
  }

  async function backup(onProgress, opts = {}) {
    const seq = store(CHANGE_KEY) || 0;
    onProgress('Checking backup folder…', 0.02);
    const chosen = await Drive.resolveFolder();
    if (!chosen) throw new Error(NO_FOLDER);
    const folder = chosen.id;
    const dataFile = await Drive.findDataFile(folder);
    const last = store(LAST_BACKUP_KEY);

    if (dataFile) {
      onProgress('Checking existing backup…', 0.05);
      const remote = await Drive.readData(dataFile.id).catch(() => null);
      if (remote && remote.deviceId && remote.deviceId !== deviceId() && (!last || remote.exportedAt > last.at)) {
        if (opts.auto) throw new Error('Drive has a newer backup from another device. Open Backup to choose what to keep.');
        const ok = confirm('Google Drive has a newer backup made on another device (' +
          fmtDateTime(remote.exportedAt) + ', ' + (remote.pieces || []).length + ' pieces).\n\n' +
          'Backing up now will replace it with this device\'s pieces. Continue?\n\n' +
          'Tip: choose Cancel, then "Restore from Drive" to get that backup instead.');
        if (!ok) throw new Error('cancelled');
      }
    }

    const pieces = await DB.allPieces();
    const needed = new Set(pieces.flatMap((p) => p.photoIds || []));
    onProgress('Checking photos…', 0.08);
    const remotePhotos = await Drive.listPhotos(folder);
    const toUpload = [...needed].filter((id) => !remotePhotos.has(id));

    let done = 0;
    for (const pid of toUpload) {
      onProgress('Uploading photo ' + (done + 1) + ' of ' + toUpload.length + '…', 0.1 + 0.8 * (done / toUpload.length));
      const photo = await DB.getPhoto(pid);
      if (photo) remotePhotos.set(pid, await Drive.uploadPhoto(folder, pid, photo.blob));
      done++;
    }

    onProgress('Saving log…', 0.92);
    const at = Date.now();
    await Drive.writeData(folder, dataFile && dataFile.id, {
      app: 'pottery-log', version: 1, exportedAt: at, deviceId: deviceId(), pieces,
    });

    // Remove photos that no longer belong to any piece.
    const orphans = [...remotePhotos.entries()].filter(([pid]) => !needed.has(pid));
    for (const [, fileId] of orphans) await Drive.deleteFile(fileId).catch(() => {});

    store(LAST_BACKUP_KEY, { at, pieces: pieces.length });
    store(BACKED_KEY, Math.max(seq, store(BACKED_KEY) || 0));
    updateBadge();
    onProgress('Done', 1);
  }

  async function restore(onProgress) {
    onProgress('Looking for a backup…', 0.02);
    const chosen = await Drive.resolveFolder();
    if (!chosen) throw new Error(NO_FOLDER);
    const folder = chosen.id;
    const dataFile = await Drive.findDataFile(folder);
    if (!dataFile) throw new Error('No Pottery Log backup was found in “' + chosen.name + '”.');
    const data = await Drive.readData(dataFile.id);
    if (!data || data.app !== 'pottery-log' || !Array.isArray(data.pieces)) throw new Error('The backup file looks damaged.');

    const localCount = (await DB.allPieces()).length;
    const ok = confirm('Restore ' + data.pieces.length + ' pieces from the backup of ' + fmtDateTime(data.exportedAt) + '?' +
      (localCount ? '\n\nThis replaces the ' + localCount + ' pieces currently on this device.' : ''));
    if (!ok) throw new Error('cancelled');

    const needed = new Set(data.pieces.flatMap((p) => p.photoIds || []));
    const have = new Set(await DB.allPhotoIds());
    const remotePhotos = await Drive.listPhotos(folder);
    const toDownload = [...needed].filter((id) => !have.has(id) && remotePhotos.has(id));

    let done = 0;
    for (const pid of toDownload) {
      onProgress('Downloading photo ' + (done + 1) + ' of ' + toDownload.length + '…', 0.05 + 0.9 * (done / toDownload.length));
      const blob = await Drive.downloadBlob(remotePhotos.get(pid));
      const typed = blob.type ? blob : new Blob([blob], { type: 'image/jpeg' });
      let thumb = null;
      try { thumb = await makeThumb(typed); } catch (e) { /* use full image */ }
      await DB.putPhoto({ id: pid, blob: typed, thumb, type: typed.type, addedAt: Date.now() });
      done++;
    }

    // Drop references to photos that could not be found in Drive.
    const available = new Set([...have, ...toDownload].filter((id) => needed.has(id)));
    const pieces = data.pieces.map((p) => ({ ...p, photoIds: (p.photoIds || []).filter((id) => available.has(id)) }));
    onProgress('Saving…', 0.97);
    await DB.replaceAllPieces(pieces, available);
    store(LAST_BACKUP_KEY, { at: data.exportedAt, pieces: pieces.length });
    store(BACKED_KEY, store(CHANGE_KEY) || 0); // device now matches the backup
    updateBadge();
    onProgress('Done', 1);
    return pieces.length;
  }

  /* ---------- boot ---------- */

  window.addEventListener('hashchange', route);
  route();

  // Stay connected: load Google's sign-in script up front so a token refresh can happen
  // inside a tap, and finish any backup that was pending when the app was last closed.
  if (store(CHANGE_KEY) == null && !store(LAST_BACKUP_KEY)) store(CHANGE_KEY, 1); // data from before change tracking
  updateBadge();
  if (Drive.configured && Drive.isSignedIn()) {
    Drive.preload();
    kickAutoBackup();
    window.addEventListener('online', kickAutoBackup);
  }

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  }
})();
