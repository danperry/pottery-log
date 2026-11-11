/* Two-way sync between this device and the chosen Google Drive folder.
 *
 * Drive layout (inside the folder the user chose):
 *
 *   pottery-log-index.json        One file listing every piece (summary only), for
 *                                 quick listing by the app or by a person.
 *   Speckled mug/                 One folder per piece, named after its title.
 *     piece.json                  Everything about the piece, pretty-printed JSON.
 *     photo-1.jpg, photo-2.jpg    Its photos, in order.
 *
 * Every save carries a timestamp ("savedAt"). When the same piece was changed on two
 * devices, the latest save wins, as a whole piece. Deleting a piece moves its folder to
 * Drive's trash and leaves a "deleted" entry in the index so other devices delete it too.
 *
 * The app loads only the index on open (fast). A piece's notes and photos are loaded
 * when it is opened ("stub" pieces are summaries that haven't been loaded yet).
 *
 * Local records keep sync bookkeeping in piece.sync:
 *   { root, folderId, fileId, syncedAt, photoFiles: { photoId: driveFileId } }
 * A piece needs uploading when piece.updatedAt !== piece.sync.syncedAt for this root.
 */
(function () {
  'use strict';

  const INDEX_NAME = 'pottery-log-index.json';
  const PIECE_NAME = 'piece.json';
  const FORMAT = 2;
  const STAGES = { greenware: 'Greenware', bisque: 'Bisque', glazed: 'Glazed', done: 'Done' };
  const METHODS = { wheel: 'Wheel', 'hand-built': 'Hand-built' };

  let makeThumb = async () => null;

  /* ---------- conversions between app records and the readable Drive JSON ---------- */

  const iso = (t) => (t ? new Date(t).toISOString() : null);
  const ms = (s) => { const t = Date.parse(s); return Number.isNaN(t) ? 0 : t; };
  const fromLabel = (map, v) => {
    if (!v) return '';
    const s = String(v).toLowerCase();
    return Object.keys(map).find((k) => k === s || map[k].toLowerCase() === s) || '';
  };
  const str = (v) => (v == null ? '' : String(v));

  /** Clay bodies of a piece (older records had one clayBody string). */
  const claysOf = (p) => (Array.isArray(p.clays) ? p.clays : p.clayBody ? [p.clayBody] : []);

  function describe(p) {
    return {
      title: p.title || 'Untitled',
      stage: STAGES[p.stage] || 'Greenware',
      clays: claysOf(p),
      formingMethod: METHODS[p.method] || '',
      glazes: p.glazes || [],
      firing: { type: p.firingType || '', cone: p.cone || '' },
      dates: {
        made: p.dateMade || '',
        bisqueFired: p.dateBisque || '',
        glazeFired: p.dateGlazed || '',
        finished: p.dateDone || '',
      },
      customFields: Settings.namedValues(p.custom),
    };
  }

  function toPieceJson(p, photoNames) {
    return {
      ...describe(p),
      notes: p.notes || '',
      photos: photoNames,
      savedAt: iso(p.updatedAt),
      createdAt: iso(p.createdAt),
      id: p.id,
      app: 'Pottery Log',
      format: FORMAT,
    };
  }

  /** Read the fields shared by piece.json and index entries (tolerates hand edits). */
  function fromDescription(j) {
    const d = j.dates || {};
    const f = j.firing || {};
    return {
      id: str(j.id),
      title: str(j.title).trim() || 'Untitled',
      stage: fromLabel(STAGES, j.stage) || 'greenware',
      clays: Array.isArray(j.clays) ? j.clays.map(str).filter(Boolean) : (str(j.clayBody) ? [str(j.clayBody)] : []),
      method: fromLabel(METHODS, j.formingMethod),
      glazes: Array.isArray(j.glazes) ? j.glazes.map(str).filter(Boolean) : [],
      firingType: str(f.type),
      cone: str(f.cone),
      dateMade: str(d.made),
      dateBisque: str(d.bisqueFired),
      dateGlazed: str(d.glazeFired),
      dateDone: str(d.finished),
      custom: Settings.fromNamed(j.customFields),
      createdAt: ms(j.createdAt) || undefined,
      updatedAt: ms(j.savedAt),
    };
  }

  function indexEntry(p) {
    if (p.deleted) return { id: p.id, title: p.title || '', deleted: true, savedAt: iso(p.updatedAt) };
    const cover = (p.photoIds || [])[0];
    const s = p.sync || {};
    return {
      id: p.id,
      ...describe(p),
      photoCount: p.photoCount != null && p.stub ? p.photoCount : (p.photoIds || []).length,
      coverPhotoId: cover || null,
      coverFileId: (cover && s.photoFiles && s.photoFiles[cover]) || null,
      folderId: s.folderId,
      pieceFileId: s.fileId,
      savedAt: iso(p.updatedAt),
    };
  }

  const folderName = (p) => (p.title || 'Untitled').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 120) || 'Untitled';
  const jsonBlob = (obj) => new Blob([JSON.stringify(obj, null, 2) + '\n'], { type: 'application/json' });
  const isFolder = (f) => f.mimeType === 'application/vnd.google-apps.folder';

  /** Does this local record have changes not yet in this root folder? */
  function isDirty(p, rootId) {
    if (p.deleted) return !!(p.sync && p.sync.root === rootId && p.sync.syncedAt !== p.updatedAt);
    return !p.sync || p.sync.root !== rootId || p.sync.syncedAt !== p.updatedAt;
  }

  async function readJson(fileId) {
    const blob = await Drive.downloadBlob(fileId);
    return JSON.parse(await blob.text());
  }

  async function savePhoto(photoId, fileId) {
    const raw = await Drive.downloadBlob(fileId);
    const blob = raw.type && raw.type.startsWith('image/') ? raw : new Blob([raw], { type: 'image/jpeg' });
    let thumb = null;
    try { thumb = await makeThumb(blob); } catch (e) { /* show the full image instead */ }
    await DB.putPhoto({ id: photoId, blob, thumb, type: blob.type, addedAt: Date.now() });
  }

  /* ---------- pushing one piece ---------- */

  async function ensureItemFolder(p, rootId) {
    const name = folderName(p);
    if (p.sync && p.sync.root === rootId && p.sync.folderId) {
      const meta = await Drive.getMeta(p.sync.folderId, 'id,name,trashed');
      if (meta) {
        const patch = {};
        if (meta.trashed) patch.trashed = false;       // deleted elsewhere but edited here later: bring it back
        if (meta.name !== name) patch.name = name;     // title changed
        if (Object.keys(patch).length) await Drive.patch(meta.id, patch);
        return meta.id;
      }
    }
    const found = await Drive.list(
      "'" + Drive.quote(rootId) + "' in parents and appProperties has { key='potteryPieceId' and value='" + Drive.quote(p.id) + "' } and trashed = false",
      'id,name');
    if (found[0]) {
      if (found[0].name !== name) await Drive.patch(found[0].id, { name });
      return found[0].id;
    }
    return Drive.mkdir(name, rootId, { potteryLog: 'item', potteryPieceId: p.id });
  }

  async function pushPiece(p, rootId) {
    const folderId = await ensureItemFolder(p, rootId);
    const files = await Drive.list("'" + Drive.quote(folderId) + "' in parents and trashed = false", 'id,name,mimeType,appProperties');
    const remotePhotos = new Map();
    let pieceFile = null;
    for (const f of files) {
      const ap = f.appProperties || {};
      if (ap.potteryLog === 'piece') pieceFile = f;
      else if (ap.potteryPhotoId) remotePhotos.set(ap.potteryPhotoId, f);
    }

    const used = new Set(files.map((f) => f.name));
    const nextName = () => { let n = 1; while (used.has('photo-' + n + '.jpg')) n++; const name = 'photo-' + n + '.jpg'; used.add(name); return name; };
    const names = [];
    const photoFiles = {};
    for (const pid of p.photoIds || []) {
      let f = remotePhotos.get(pid);
      if (!f) {
        const photo = await DB.getPhoto(pid);
        if (!photo) continue; // nothing to upload
        const name = nextName();
        const id = await Drive.create({ name, parents: [folderId], appProperties: { potteryPhotoId: pid, potteryPieceId: p.id } }, photo.blob);
        f = { id, name };
      }
      names.push(f.name);
      photoFiles[pid] = f.id;
    }
    for (const [pid, f] of remotePhotos) {
      if (!photoFiles[pid]) await Drive.trash(f.id);
    }

    const meta = { appProperties: { potteryLog: 'piece', potteryPieceId: p.id, potteryRoot: rootId, potterySavedAt: String(p.updatedAt) } };
    const blob = jsonBlob(toPieceJson(p, names));
    let fileId;
    if (pieceFile) { await Drive.update(pieceFile.id, meta, blob); fileId = pieceFile.id; }
    else fileId = await Drive.create({ ...meta, name: PIECE_NAME, parents: [folderId], mimeType: 'application/json' }, blob);

    return { root: rootId, folderId, fileId, syncedAt: p.updatedAt, photoFiles };
  }

  /** Record a successful upload without clobbering edits made while it ran. */
  async function markSynced(id, sync) {
    const cur = await DB.getPiece(id);
    if (!cur) return;
    cur.sync = sync;
    await DB.putPiece(cur);
  }

  /* ---------- loading a piece's details on demand ---------- */

  async function loadPiece(id, opts = {}) {
    const p = await DB.getPiece(id);
    if (!p || p.deleted || !p.sync || !p.sync.folderId) throw Object.assign(new Error('This piece is not in Google Drive.'), { status: 404 });
    const files = await Drive.list("'" + Drive.quote(p.sync.folderId) + "' in parents and trashed = false", 'id,name,mimeType,appProperties');
    const pf = files.find((f) => (f.appProperties || {}).potteryLog === 'piece') || files.find((f) => f.name === PIECE_NAME);
    if (!pf) throw Object.assign(new Error('Could not find this piece in Google Drive.'), { status: 404 });
    const j = await readJson(pf.id);

    const byName = new Map(files.filter((f) => !isFolder(f)).map((f) => [f.name, f]));
    const photoIds = [];
    const photoFiles = {};
    for (const name of Array.isArray(j.photos) ? j.photos : []) {
      const f = byName.get(String(name));
      if (!f) continue;
      const pid = (f.appProperties || {}).potteryPhotoId || 'drive-' + f.id;
      photoIds.push(pid);
      photoFiles[pid] = f.id;
    }

    const fields = fromDescription(j);
    const cur = await DB.getPiece(id);
    if (!fields.updatedAt) fields.updatedAt = cur.updatedAt; // hand-edited file without savedAt
    if (!cur.stub && cur.updatedAt > fields.updatedAt) return cur; // edited here since; keep local
    const upToDate = cur.sync.syncedAt === cur.updatedAt;
    const next = {
      ...cur,
      ...fields,
      id,
      notes: str(j.notes),
      photoIds,
      createdAt: fields.createdAt || cur.createdAt,
      stub: false,
      photoCount: undefined,
      // A piece that was up to date stays up to date after loading.
      sync: { ...cur.sync, fileId: pf.id, syncedAt: upToDate ? fields.updatedAt : cur.sync.syncedAt, photoFiles },
    };
    const stale = (cur.photoIds || []).filter((pid) => !photoFiles[pid]);
    await DB.putPiece(next);
    await DB.deletePhotos(stale);

    if (opts.photos !== false) {
      let i = 0;
      for (const pid of photoIds) {
        i++;
        if (!(await DB.getPhoto(pid))) {
          if (opts.onProgress) opts.onProgress(i, photoIds.length);
          await savePhoto(pid, photoFiles[pid]);
        }
      }
    }
    return next;
  }

  /* ---------- migrating backups made by earlier versions ---------- */

  async function importLegacy(rootId, onProgress) {
    const dataFile = await Drive.findDataFile(rootId);
    if (!dataFile) return null;
    const data = await Drive.readData(dataFile.id).catch(() => null);
    const legacyPhotos = await Drive.listPhotos(rootId);
    if (data && Array.isArray(data.pieces)) {
      let n = 0;
      for (const lp of data.pieces) {
        n++;
        const local = await DB.getPiece(lp.id);
        if (local && (local.updatedAt || 0) >= (lp.updatedAt || 0)) continue;
        onProgress('Moving old backup to the new layout (' + n + ' of ' + data.pieces.length + ')…');
        const photoIds = [];
        for (const pid of lp.photoIds || []) {
          if (await DB.getPhoto(pid)) photoIds.push(pid);
          else if (legacyPhotos.has(pid)) { await savePhoto(pid, legacyPhotos.get(pid)); photoIds.push(pid); }
        }
        await DB.putPiece({ ...lp, photoIds, stub: false, deleted: false, sync: undefined });
      }
    }
    return { dataFileId: dataFile.id, photoFileIds: [...legacyPhotos.values()] };
  }

  /* ---------- the sync ---------- */

  /**
   * Bring this device and the Drive folder up to date with each other.
   * Returns { pulled, pushed, removed } counts.
   */
  async function run(rootId, onProgress = () => {}) {
    onProgress('Checking Google Drive…');
    const indexFiles = await Drive.list(
      "'" + Drive.quote(rootId) + "' in parents and appProperties has { key='potteryLog' and value='index' } and trashed = false", 'id');
    const indexFile = indexFiles[0] || null;
    let index = null;
    if (indexFile) index = await readJson(indexFile.id).catch(() => null);
    const legacy = indexFile ? null : await importLegacy(rootId, onProgress);

    // Custom fields and filter choices: the newest save wins. Apply them first, so pieces
    // read below map their custom values onto the right fields.
    let settingsChange = '';
    const rs = index && index.settings;
    const rsAt = rs ? ms(rs.savedAt) : 0;
    const local = Settings.get();
    if (rs && rsAt > local.updatedAt) { Settings.applyRemote(rs, rootId); settingsChange = 'pulled'; }
    else if (Settings.isDirty(rootId)) settingsChange = 'pushed';
    else if (rs && rsAt === local.updatedAt) Settings.markSynced(rootId, rsAt);

    // What Drive has: index entries, overridden by any newer piece.json (the index can lag behind).
    const remote = new Map();
    for (const e of (index && Array.isArray(index.items)) ? index.items : []) {
      if (!e || !e.id) continue;
      remote.set(String(e.id), { savedAt: ms(e.savedAt), entry: e, deleted: !!e.deleted, folderId: e.folderId, fileId: e.pieceFileId, present: false });
    }
    const pieceFiles = await Drive.list(
      "appProperties has { key='potteryRoot' and value='" + Drive.quote(rootId) + "' } and appProperties has { key='potteryLog' and value='piece' } and trashed = false",
      'id,parents,appProperties');
    for (const f of pieceFiles) {
      const ap = f.appProperties || {};
      const id = ap.potteryPieceId;
      if (!id) continue;
      const t = Number(ap.potterySavedAt) || 0;
      const r = remote.get(id);
      if (!r || t > r.savedAt) {
        remote.set(id, { savedAt: t, entry: null, deleted: false, folderId: (f.parents || [])[0], fileId: f.id, present: true });
      } else {
        r.present = true;
        if (!r.deleted) { r.folderId = (f.parents || [])[0]; r.fileId = f.id; }
      }
    }
    // Listed in the index but its piece.json is gone (folder trashed or deleted in Drive by hand).
    for (const r of remote.values()) if (!r.deleted && !r.present) r.gone = true;

    const locals = new Map((await DB.allPieces()).map((p) => [p.id, p]));
    const ids = new Set([...locals.keys(), ...remote.keys()]);
    const stats = { pulled: 0, pushed: 0, removed: 0 };
    const toPush = [];

    for (const id of ids) {
      const L = locals.get(id);
      const R = remote.get(id);
      if (!R) {
        if (!L || L.deleted) continue;
        if (L.sync && L.sync.root === rootId && !isDirty(L, rootId)) {
          await DB.deletePiece(id); stats.removed++; // removed from Drive entirely
        } else toPush.push(L);
        continue;
      }
      if (!L) {
        if (!R.deleted && !R.gone) { await pullStub(id, R, null, rootId); stats.pulled++; }
        continue;
      }
      if (R.gone) {
        if (L.deleted) continue;
        if (isDirty(L, rootId)) toPush.push(L); // changed here since: put it back
        else { await DB.deletePiece(id); stats.removed++; }
        continue;
      }
      const lt = L.updatedAt || 0;
      if (lt > R.savedAt) {
        toPush.push(L);
      } else if (R.savedAt > lt) {
        if (R.deleted) {
          if (!L.deleted) {
            await DB.deletePiece(id); stats.removed++;
            await DB.putPiece({ id, title: L.title, deleted: true, updatedAt: R.savedAt, sync: { root: rootId, syncedAt: R.savedAt } });
          }
        } else { await pullStub(id, R, L, rootId); stats.pulled++; }
      } else if (isDirty(L, rootId)) {
        // Same save on both sides (e.g. first sync of a restored device): just link them.
        if (L.deleted || R.deleted) { if (L.deleted && !R.deleted) toPush.push(L); continue; }
        const sameRoot = L.sync && L.sync.root === rootId;
        L.sync = { root: rootId, folderId: R.folderId, fileId: R.fileId, syncedAt: lt, photoFiles: sameRoot ? L.sync.photoFiles || {} : {} };
        await DB.putPiece(L);
      }
    }

    let n = 0;
    const failed = [];
    for (const L of toPush) {
      n++;
      onProgress('Saving to Drive (' + n + ' of ' + toPush.length + ')…');
      try {
        await pushOne(L, remote.get(L.id), rootId);
        stats.pushed++;
      } catch (err) {
        if (err.reconnect || err instanceof TypeError || !err.status) throw err; // offline, signed out, etc.
        failed.push(L.title || 'Untitled');
      }
    }


    // Rewrite the index from what this device now knows about this folder.
    const all = (await DB.allPieces()).filter((p) => p.sync && p.sync.root === rootId && (p.deleted || p.sync.folderId));
    all.sort((a, b) => (a.deleted - b.deleted) || (a.title || '').localeCompare(b.title || ''));
    const items = all.map(indexEntry);
    const settings = Settings.forDrive();
    const same = index && JSON.stringify(index.items) === JSON.stringify(items) &&
      JSON.stringify(index.settings || null) === JSON.stringify(settings.savedAt ? settings : null);
    if (!same) {
      onProgress('Updating the index…');
      const doc = {
        app: 'Pottery Log',
        format: FORMAT,
        about: 'Index of all pieces. Each piece has its own folder with piece.json and its photos.',
        updatedAt: iso(Date.now()),
        ...(settings.savedAt ? { settings } : {}),
        items,
      };
      const meta = { appProperties: { potteryLog: 'index' } };
      if (indexFile) await Drive.update(indexFile.id, meta, jsonBlob(doc));
      else await Drive.create({ ...meta, name: INDEX_NAME, parents: [rootId], mimeType: 'application/json' }, jsonBlob(doc));
    }
    if (settings.savedAt) Settings.markSynced(rootId, ms(settings.savedAt)); // edits made during the sync stay pending
    stats.settings = settingsChange;

    if (legacy && !failed.length) { // the old single-file backup now lives in the new layout
      await Drive.trash(legacy.dataFileId).catch(() => {});
      for (const fid of legacy.photoFileIds) await Drive.trash(fid).catch(() => {});
    }

    // Deletes remembered for other folders aren't needed any more.
    for (const p of await DB.allPieces()) {
      if (p.deleted && (!p.sync || p.sync.root !== rootId)) await DB.deletePiece(p.id);
    }

    if (failed.length) {
      throw Object.assign(new Error('Could not save ' + failed.length + (failed.length === 1 ? ' piece' : ' pieces') +
        ' to Drive (' + failed.slice(0, 3).join(', ') + (failed.length > 3 ? '…' : '') + '). Everything else is in sync.'), { partial: true });
    }
    return stats;
  }

  async function pushOne(L, R, rootId) {
    if (L.deleted) {
      const folderId = (R && R.folderId) || (L.sync && L.sync.folderId);
      if (folderId) { const meta = await Drive.getMeta(folderId, 'id,trashed'); if (meta && !meta.trashed) await Drive.trash(folderId); }
      await markSynced(L.id, { root: rootId, syncedAt: L.updatedAt });
      return;
    }
    let p = L;
    if (p.stub) p = await loadPiece(p.id); // copying to a new folder needs the whole piece
    await markSynced(p.id, await pushPiece(p, rootId));
  }

  /** Store a summary of a remote piece; its notes and photos load when it's opened. */
  async function pullStub(id, R, L, rootId) {
    let e = R.entry;
    if (!e && R.fileId) e = await readJson(R.fileId).catch(() => null); // index lagging: read piece.json
    if (!e) e = { id, title: 'Untitled' };
    const fields = fromDescription({ ...e, id, savedAt: iso(R.savedAt) });
    const cover = e.coverPhotoId || null;
    const coverFile = e.coverFileId || null;
    if (L) await DB.deletePhotos((L.photoIds || []).filter((pid) => pid !== cover));
    await DB.putPiece({
      ...fields,
      notes: '', // loads with the rest of the piece when opened
      createdAt: fields.createdAt || (L && L.createdAt) || R.savedAt,
      updatedAt: R.savedAt,
      stub: true,
      deleted: false,
      photoIds: cover && coverFile ? [cover] : [],
      photoCount: Number(e.photoCount) || (cover ? 1 : 0),
      sync: { root: rootId, folderId: R.folderId, fileId: R.fileId, syncedAt: R.savedAt, photoFiles: cover && coverFile ? { [cover]: coverFile } : {} },
    });
  }

  window.Sync = {
    init(opts) { if (opts && opts.makeThumb) makeThumb = opts.makeThumb; },
    run,
    loadPiece,
    isDirty,
    /** Download one photo of a piece that isn't on this device yet. */
    async fetchPhoto(photoId, fileId) { if (!(await DB.getPhoto(photoId))) await savePhoto(photoId, fileId); },
    async pendingCount(rootId) {
      if (!rootId) return 0;
      return (await DB.allPieces()).filter((p) => isDirty(p, rootId)).length + (Settings.isDirty(rootId) ? 1 : 0);
    },
    // exposed for tests
    _toPieceJson: toPieceJson,
    _fromDescription: fromDescription,
  };
})();
