/* Local storage for Pottery Log, backed by IndexedDB.
 * Object stores:
 *   pieces  – one record per piece (plain JSON)
 *   photos  – { id, blob, thumb, type } image blobs, referenced by piece.photoIds.
 *             Each piece's small list thumbnail is kept here too, under the id
 *             'thumb:' + pieceId, as { id, pieceId, photoId, thumb, type }.
 *   auth    – { id: 'google', blob } the encrypted Google refresh token from the auth Worker
 */
(function () {
  'use strict';

  const DB_NAME = 'pottery-log';
  const DB_VERSION = 2;
  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('pieces')) {
          const s = db.createObjectStore('pieces', { keyPath: 'id' });
          s.createIndex('updatedAt', 'updatedAt');
        }
        if (!db.objectStoreNames.contains('photos')) {
          db.createObjectStore('photos', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('auth')) {
          db.createObjectStore('auth', { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('Database is open in another tab. Close it and try again.'));
    });
    return dbPromise;
  }

  function reqToPromise(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function txDone(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
    });
  }

  async function store(name, mode) {
    const db = await open();
    return db.transaction(name, mode).objectStore(name);
  }

  function uid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  const THUMB_PREFIX = 'thumb:';

  const DB = {
    uid,
    THUMB_PREFIX,

    async allPieces() {
      const s = await store('pieces', 'readonly');
      return reqToPromise(s.getAll());
    },

    async getPiece(id) {
      const s = await store('pieces', 'readonly');
      return reqToPromise(s.get(id));
    },

    async putPiece(piece) {
      const s = await store('pieces', 'readwrite');
      await reqToPromise(s.put(piece));
      return piece;
    },

    /** Delete a piece and all of its photos. */
    async deletePiece(id) {
      const db = await open();
      const tx = db.transaction(['pieces', 'photos'], 'readwrite');
      const pieces = tx.objectStore('pieces');
      const piece = await reqToPromise(pieces.get(id));
      if (piece) {
        (piece.photoIds || []).forEach((pid) => tx.objectStore('photos').delete(pid));
        tx.objectStore('photos').delete(THUMB_PREFIX + id);
        pieces.delete(id);
      }
      return txDone(tx);
    },

    async getPhoto(id) {
      const s = await store('photos', 'readonly');
      return reqToPromise(s.get(id));
    },

    async putPhoto(photo) {
      const s = await store('photos', 'readwrite');
      await reqToPromise(s.put(photo));
      return photo;
    },

    async deletePhotos(ids) {
      if (!ids.length) return;
      const db = await open();
      const tx = db.transaction('photos', 'readwrite');
      ids.forEach((id) => tx.objectStore('photos').delete(id));
      return txDone(tx);
    },

    async allPhotoIds() {
      const s = await store('photos', 'readonly');
      return (await reqToPromise(s.getAllKeys())).filter((k) => !String(k).startsWith(THUMB_PREFIX));
    },

    /** A piece's small list thumbnail: { pieceId, photoId, thumb } or undefined. */
    async getPieceThumb(pieceId) {
      const s = await store('photos', 'readonly');
      return reqToPromise(s.get(THUMB_PREFIX + pieceId));
    },

    async putPieceThumb(pieceId, photoId, thumb) {
      const s = await store('photos', 'readwrite');
      await reqToPromise(s.put({ id: THUMB_PREFIX + pieceId, pieceId, photoId, thumb, type: thumb.type }));
    },

    async deletePieceThumbs(pieceIds) {
      return this.deletePhotos(pieceIds.map((id) => THUMB_PREFIX + id));
    },

    /** Size in bytes of everything in the photo store: [{ id, bytes }] (thumbnails included). */
    async photoSizes() {
      const s = await store('photos', 'readonly');
      return new Promise((resolve, reject) => {
        const out = [];
        const req = s.openCursor();
        req.onsuccess = () => {
          const c = req.result;
          if (!c) return resolve(out);
          const v = c.value || {};
          out.push({ id: c.key, bytes: ((v.blob && v.blob.size) || 0) + ((v.thumb && v.thumb.size) || 0) });
          c.continue();
        };
        req.onerror = () => reject(req.error);
      });
    },

    /** Replace everything with the given pieces; photos not in keepPhotoIds are removed. */
    async replaceAllPieces(pieces, keepPhotoIds) {
      const db = await open();
      const tx = db.transaction(['pieces', 'photos'], 'readwrite');
      const ps = tx.objectStore('pieces');
      ps.clear();
      pieces.forEach((p) => ps.put(p));
      const photoStore = tx.objectStore('photos');
      const keys = await reqToPromise(photoStore.getAllKeys());
      keys.forEach((k) => { if (!keepPhotoIds.has(k) && !String(k).startsWith(THUMB_PREFIX)) photoStore.delete(k); });
      return txDone(tx);
    },

    /** Encrypted Google sign-in blob (only the auth Worker can read it). */
    async getAuthBlob() {
      const s = await store('auth', 'readonly');
      const r = await reqToPromise(s.get('google'));
      return r ? r.blob : null;
    },

    async setAuthBlob(blob) {
      const s = await store('auth', 'readwrite');
      if (blob) await reqToPromise(s.put({ id: 'google', blob, savedAt: Date.now() }));
      else await reqToPromise(s.delete('google'));
    },

    async requestPersistence() {
      try {
        if (navigator.storage && navigator.storage.persist) {
          if (await navigator.storage.persisted()) return true;
          return await navigator.storage.persist();
        }
      } catch (e) { /* ignore */ }
      return false;
    },

    async estimate() {
      try {
        if (navigator.storage && navigator.storage.estimate) return await navigator.storage.estimate();
      } catch (e) { /* ignore */ }
      return null;
    },
  };

  window.DB = DB;
})();
