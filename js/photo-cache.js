/* Keeps the photos on this device under a size limit.
 *
 * Every photo is kept on the device until it is safely in the Google Drive folder. Once the
 * photos take more room than the limit (set in Settings, per device), the full-size photos of
 * the pieces opened longest ago are removed from the device, oldest first, until they fit
 * again. They stay in Drive and download again when the piece is opened.
 *
 * Each piece also has a small list thumbnail. Those are tiny and are only removed in an
 * emergency: when removing every full-size photo that can be removed still isn't enough.
 *
 * When each piece was last opened is remembered in localStorage, on this device only.
 */
(function () {
  'use strict';

  const LIMIT_KEY = 'potteryLog.photoLimitMB';
  const OPENED_KEY = 'potteryLog.openedAt';
  const DROPPED_KEY = 'potteryLog.thumbsDropped'; // pieces whose list thumbnail was removed
  const MB = 1024 * 1024;
  const DEFAULT_MB = 500;
  const CHOICES_MB = [100, 250, 500, 1024, 2048, 5120];
  const TARGET = 0.9; // when trimming, go a little under the limit so it doesn't run on every photo

  function read(key, fallback) {
    try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch (e) { return fallback; }
  }
  function write(key, val) {
    try { if (val == null) localStorage.removeItem(key); else localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* storage full or blocked */ }
  }

  let current = null; // the piece on screen right now is never trimmed
  let opened = read(OPENED_KEY, {});
  let dropped = new Set(read(DROPPED_KEY, []));
  let timer = null;
  let running = null;
  const waiters = [];
  let ctx = { canRemove: () => false, root: () => null, onChange: () => {} };

  function limitMB() {
    const v = Number(read(LIMIT_KEY, DEFAULT_MB));
    return v > 0 ? v : DEFAULT_MB;
  }

  /** The photo shown as the piece's thumbnail: the one picked in Edit, or else the newest. */
  function coverOf(p) {
    const ids = (p && p.photoIds) || [];
    return p && p.coverPhotoId && ids.includes(p.coverPhotoId) ? p.coverPhotoId : ids[ids.length - 1] || null;
  }

  /** Photos that are already in the current Drive folder, so they can be downloaded again. */
  function inDrive(p, pid, root) {
    return !!(root && p.sync && p.sync.root === root && p.sync.photoFiles && p.sync.photoFiles[pid]);
  }

  async function trim() {
    const sizes = await DB.photoSizes();
    let total = sizes.reduce((n, s) => n + s.bytes, 0);
    const limit = limitMB() * MB;
    if (total <= limit || !ctx.canRemove()) return { total, removed: 0, thumbs: 0 };
    const root = ctx.root();
    const target = limit * TARGET;
    const bytes = new Map(sizes.map((s) => [s.id, s.bytes]));
    const pieces = (await DB.allPieces()).filter((p) => !p.deleted && p.id !== current);
    const lastUsed = (p) => opened[p.id] || p.updatedAt || p.createdAt || 0;
    pieces.sort((a, b) => lastUsed(a) - lastUsed(b));

    // Full-size photos of the pieces opened longest ago.
    let removed = 0;
    for (const p of pieces) {
      if (total <= target) break;
      const ids = (p.photoIds || []).filter((pid) => bytes.has(pid) && inDrive(p, pid, root));
      if (!ids.length) continue;
      await DB.deletePhotos(ids);
      ids.forEach((pid) => { total -= bytes.get(pid); bytes.delete(pid); });
      removed += ids.length;
    }

    // Emergency: still too much, so drop list thumbnails too, oldest first.
    let thumbs = 0;
    if (total > limit) {
      for (const p of pieces) {
        if (total <= target) break;
        const tid = DB.THUMB_PREFIX + p.id;
        if (!bytes.has(tid)) continue;
        if (!inDrive(p, coverOf(p), root)) continue; // couldn't be made again from Drive
        await DB.deletePieceThumbs([p.id]);
        total -= bytes.get(tid); bytes.delete(tid);
        dropped.add(p.id);
        thumbs++;
      }
      if (thumbs) write(DROPPED_KEY, [...dropped]);
    }

    // Forget pieces that no longer exist.
    const live = new Set(pieces.map((p) => p.id));
    if (current) live.add(current);
    const before = Object.keys(opened).length;
    opened = Object.fromEntries(Object.entries(opened).filter(([id]) => live.has(id)));
    if (Object.keys(opened).length !== before) write(OPENED_KEY, opened);
    if (removed || thumbs) ctx.onChange({ removed, thumbs });
    return { total, removed, thumbs };
  }

  window.PhotoCache = {
    DEFAULT_MB,
    CHOICES_MB,
    /** opts: canRemove() (true when Drive is connected), root() (the Drive folder id), onChange() */
    init(opts) { ctx = { ...ctx, ...opts }; },
    limitMB,
    coverOf,
    canRemoveNow() { return !!ctx.canRemove(); },
    setLimitMB(mb) { write(LIMIT_KEY, Number(mb) || DEFAULT_MB); return this.check(0); },

    /** A piece was opened: it becomes the most recently used and isn't trimmed while open. */
    touch(id) {
      current = id;
      opened[id] = Date.now();
      write(OPENED_KEY, opened);
    },
    leave() { current = null; },

    /** Its list thumbnail was removed in an emergency, so the list shouldn't download it again. */
    thumbDropped(id) { return dropped.has(id); },
    thumbRestored(id) { if (dropped.delete(id)) write(DROPPED_KEY, [...dropped]); },

    /** How much room photos take: { bytes, limit } */
    async usage() {
      const sizes = await DB.photoSizes();
      return { bytes: sizes.reduce((n, s) => n + s.bytes, 0), limit: limitMB() * MB };
    },

    /** Trim soon (photos often arrive in bursts). Resolves with what was removed. */
    check(delay = 1500) {
      clearTimeout(timer);
      return new Promise((resolve) => {
        waiters.push(resolve);
        timer = setTimeout(() => {
          const ws = waiters.splice(0);
          running = (running || Promise.resolve()).then(trim).catch(() => null);
          running.then((r) => ws.forEach((w) => w(r)));
        }, delay);
      });
    },
  };
})();
