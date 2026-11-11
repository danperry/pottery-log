/* Google sign-in (through the Pottery Log auth Worker) and Google Drive REST helpers.
 * Uses only the https://www.googleapis.com/auth/drive.file scope, so the app can
 * see and change only the files it created itself, or folders the user picked.
 *
 * Sign-in: the app sends the browser to the Worker's /auth/start, Google asks for
 * consent, and the Worker redirects back with an encrypted refresh token ("blob") in
 * the URL fragment. The blob is kept in IndexedDB and is useless without the Worker's
 * key. Access tokens are fetched from the Worker's /auth/token when needed and kept
 * in memory only, so the user signs in once and stays connected.
 *
 * The user picks the backup folder: either an existing folder chosen with the
 * Google Picker (which grants this app access to just that folder) or a new
 * folder the app creates. Inside it:
 *     pottery-log.json           data     appProperties.potteryLog = "data"
 *     <photoId>.jpg              photos   appProperties.potteryPhotoId = <photoId>
 */
(function () {
  'use strict';

  const GAPI_SRC = 'https://apis.google.com/js/api.js';
  const FOLDER_MIME = 'application/vnd.google-apps.folder';
  const API = 'https://www.googleapis.com/drive/v3';
  const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
  const ACCOUNT_KEY = 'potteryLog.driveAccount';
  const FOLDER_KEY = 'potteryLog.driveFolder';
  const RECONNECT_KEY = 'potteryLog.driveReconnect';
  const REFRESH_MARGIN = 5 * 60 * 1000; // renew access tokens 5 minutes before they expire

  const cfg = window.POTTERY_CONFIG || {};
  const workerUrl = (cfg.authWorkerUrl || '').trim().replace(/\/+$/, '');
  const clientId = (cfg.googleClientId || '').trim();
  const apiKey = (cfg.googleApiKey || '').trim();
  // The Picker's app ID is the Cloud project number, which is the client ID's numeric prefix.
  const appId = (String(cfg.googleAppId || '').trim() || (clientId.match(/^(\d+)-/) || [])[1] || '');

  let pickerPromise = null;
  let blob = null;          // encrypted refresh token, mirrored from IndexedDB by init()
  let access = null;        // { token, expiresAt } in memory only
  let refreshing = null;    // in-flight /auth/token request

  function loadPicker() {
    if (pickerPromise) return pickerPromise;
    pickerPromise = new Promise((resolve, reject) => {
      const fail = () => { pickerPromise = null; reject(new Error('Could not load the Google folder picker. Check your connection.')); };
      const ready = () => window.gapi.load('picker', { callback: resolve, onerror: fail, timeout: 15000, ontimeout: fail });
      if (window.gapi && window.gapi.load) return ready();
      const s = document.createElement('script');
      s.src = GAPI_SRC;
      s.async = true;
      s.onload = ready;
      s.onerror = fail;
      document.head.appendChild(s);
    });
    return pickerPromise;
  }

  function flag(key, val) {
    try {
      if (val === undefined) return localStorage.getItem(key) === '1';
      if (val) localStorage.setItem(key, '1'); else localStorage.removeItem(key);
    } catch (e) { return false; }
  }

  function getAccount() {
    try { return JSON.parse(localStorage.getItem(ACCOUNT_KEY) || 'null'); } catch (e) { return null; }
  }

  function setAccount(a) {
    try {
      if (a) localStorage.setItem(ACCOUNT_KEY, JSON.stringify(a));
      else localStorage.removeItem(ACCOUNT_KEY);
    } catch (e) { /* ignore */ }
  }

  /** Thrown when Google no longer accepts the saved sign-in; the user must reconnect. */
  class ReconnectError extends Error {
    constructor() {
      super('Google Drive needs to be reconnected.');
      this.name = 'ReconnectError';
      this.reconnect = true;
    }
  }

  async function forgetSignIn() {
    blob = null;
    access = null;
    await DB.setAuthBlob(null);
  }

  async function workerPost(path, body) {
    let res;
    try {
      res = await fetch(workerUrl + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        credentials: 'omit',
        cache: 'no-store',
      });
    } catch (e) {
      throw new Error('Could not reach the sign-in service. Check your connection.');
    }
    const j = await res.json().catch(() => ({}));
    return { res, j };
  }

  async function fetchAccessToken() {
    if (!blob) throw new ReconnectError();
    const { res, j } = await workerPost('/auth/token', { blob });
    if (res.status === 401 && j.error === 'invalid_grant') {
      // Revoked, unused for 6 months, or the key changed: drop it, keep all local data.
      await forgetSignIn();
      flag(RECONNECT_KEY, true);
      throw new ReconnectError();
    }
    if (!res.ok || !j.access_token) throw new Error('Google sign-in service error (' + res.status + '). Try again later.');
    access = { token: j.access_token, expiresAt: Number(j.expires_at) || Date.now() + (Number(j.expires_in) || 3600) * 1000 };
    return access.token;
  }

  /** A valid access token, renewed through the Worker when missing or close to expiry. */
  function getToken() {
    if (access && access.expiresAt - Date.now() > REFRESH_MARGIN) return Promise.resolve(access.token);
    if (!refreshing) refreshing = fetchAccessToken().finally(() => { refreshing = null; });
    return refreshing;
  }

  async function api(path, opts = {}, retry = true) {
    const token = await getToken();
    const res = await fetch(path.startsWith('http') ? path : API + path, {
      ...opts,
      headers: { Authorization: 'Bearer ' + token, ...(opts.headers || {}) },
    });
    if (res.status === 401 && retry) {
      access = null;
      return api(path, opts, false);
    }
    if (!res.ok) {
      let detail = '';
      try { const j = await res.json(); detail = j.error && j.error.message; } catch (e) { /* ignore */ }
      const err = new Error('Google Drive error ' + res.status + (detail ? ': ' + detail : ''));
      err.status = res.status;
      throw err;
    }
    return res;
  }

  function getFolderChoice() {
    try { return JSON.parse(localStorage.getItem(FOLDER_KEY) || 'null'); } catch (e) { return null; }
  }

  function setFolderChoice(f) {
    try {
      if (f) localStorage.setItem(FOLDER_KEY, JSON.stringify({ id: f.id, name: f.name }));
      else localStorage.removeItem(FOLDER_KEY);
    } catch (e) { /* ignore */ }
  }

  // Shared drive folders work too, so every call opts in to them.
  const ALL_DRIVES = 'supportsAllDrives=true';

  function q(str) { return str.replace(/\\/g, '\\\\').replace(/'/g, "\\'"); }

  async function listFiles(query, fields) {
    const out = [];
    let pageToken = '';
    do {
      const params = new URLSearchParams({
        q: query,
        spaces: 'drive',
        pageSize: '1000',
        fields: 'nextPageToken, files(' + fields + ')',
        supportsAllDrives: 'true',
        includeItemsFromAllDrives: 'true',
        corpora: 'allDrives',
      });
      if (pageToken) params.set('pageToken', pageToken);
      const res = await api('/files?' + params.toString());
      const j = await res.json();
      out.push(...(j.files || []));
      pageToken = j.nextPageToken || '';
    } while (pageToken);
    return out;
  }

  function multipartBody(metadata, blob) {
    const boundary = 'pottery' + Math.random().toString(36).slice(2);
    const body = new Blob([
      '--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n',
      JSON.stringify(metadata),
      '\r\n--' + boundary + '\r\nContent-Type: ' + (blob.type || 'application/octet-stream') + '\r\n\r\n',
      blob,
      '\r\n--' + boundary + '--',
    ]);
    return { body, contentType: 'multipart/related; boundary=' + boundary };
  }

  async function createFile(metadata, blob) {
    const { body, contentType } = multipartBody(metadata, blob);
    const res = await api(UPLOAD + '/files?uploadType=multipart&fields=id&' + ALL_DRIVES, {
      method: 'POST', headers: { 'Content-Type': contentType }, body,
    });
    return (await res.json()).id;
  }

  /** Replace a file's content and (optionally) its metadata in one request. */
  async function updateFile(fileId, metadata, blob) {
    const { body, contentType } = multipartBody(metadata || {}, blob);
    await api(UPLOAD + '/files/' + encodeURIComponent(fileId) + '?uploadType=multipart&fields=id&' + ALL_DRIVES, {
      method: 'PATCH', headers: { 'Content-Type': contentType }, body,
    });
  }

  async function patchMeta(fileId, metadata) {
    const res = await api('/files/' + encodeURIComponent(fileId) + '?fields=id,name,trashed&' + ALL_DRIVES, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(metadata),
    });
    return res.json();
  }

  const Drive = {
    configured: !!workerUrl,
    getAccount,
    isSignedIn: () => !!blob,
    needsReconnect: () => !blob && flag(RECONNECT_KEY),
    ReconnectError,

    /**
     * Load the saved sign-in, and finish a sign-in that just returned from the Worker.
     * Returns { connected: true } or { error } when the page was opened by a sign-in redirect.
     */
    async init() {
      let result = null;
      const m = location.hash.match(/^#(auth|auth_error)=([^&]*)/);
      if (m) {
        // Take the blob out of the address bar (and history) right away.
        history.replaceState(null, '', location.pathname + location.search + '#/backup');
        if (m[1] === 'auth' && m[2].startsWith('v1.')) {
          await DB.setAuthBlob(m[2]);
          flag(RECONNECT_KEY, false);
          result = { connected: true };
        } else {
          result = { error: decodeURIComponent(m[2] || 'unknown') };
        }
      }
      try { blob = await DB.getAuthBlob(); } catch (e) { blob = null; }
      // Earlier versions kept short-lived tokens in localStorage; never keep tokens there.
      try { localStorage.removeItem('potteryLog.driveToken'); } catch (e) { /* ignore */ }
      // Signed in with an earlier version (no saved blob): ask to reconnect once.
      if (!blob && getAccount() && !result) flag(RECONNECT_KEY, true);
      if (result && result.connected && blob) {
        try {
          const res = await api('/about?fields=user(displayName,emailAddress)');
          const j = await res.json();
          setAccount({ name: j.user && j.user.displayName, email: j.user && j.user.emailAddress });
        } catch (e) {
          if (!(e && e.reconnect)) setAccount({ name: 'Google account' });
        }
      }
      return result;
    },

    /** Leave the app for Google's consent screen (via the Worker). */
    signIn() {
      location.assign(workerUrl + '/auth/start');
    },

    /** Revoke access with Google and forget the saved sign-in on this device. */
    async disconnect() {
      const b = blob;
      await forgetSignIn();
      setAccount(null);
      setFolderChoice(null);
      flag(RECONNECT_KEY, false);
      if (b) {
        const { res } = await workerPost('/auth/revoke', { blob: b }).catch(() => ({ res: { ok: false } }));
        if (!res.ok) return { revoked: false };
      }
      return { revoked: true };
    },

    /** Get a usable access token (renewing it if needed). */
    ensureToken: () => getToken(),

    /** The folder backups go to, as { id, name }, or null if none is chosen yet. */
    getFolder: getFolderChoice,
    setFolder: setFolderChoice,

    /**
     * Check the chosen folder still exists and refresh its name. Returns null (and
     * forgets it) if it was deleted, trashed or access was lost.
     */
    async resolveFolder() {
      const chosen = getFolderChoice();
      if (!chosen) return null;
      try {
        const res = await api('/files/' + encodeURIComponent(chosen.id) + '?fields=id,name,trashed&' + ALL_DRIVES);
        const f = await res.json();
        if (f.trashed) throw Object.assign(new Error('trashed'), { status: 404 });
        if (f.name !== chosen.name) setFolderChoice(f);
        return { id: f.id, name: f.name };
      } catch (err) {
        if (err.status === 404 || err.status === 403) { setFolderChoice(null); return null; }
        throw err;
      }
    },

    /** Create a new folder (in My Drive, or inside parentId) and make it the backup folder. */
    async createFolder(name, parentId) {
      const meta = { name: name || 'Pottery Log', mimeType: FOLDER_MIME };
      if (parentId) meta.parents = [parentId];
      const res = await api('/files?fields=id,name&' + ALL_DRIVES, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(meta),
      });
      const f = await res.json();
      setFolderChoice(f);
      return f;
    },

    /**
     * Show the Google Picker so the user can choose an existing folder. Picking it grants
     * this app (drive.file scope) access to that folder. Resolves to { id, name } or null
     * if cancelled.
     */
    async pickFolder() {
      if (!apiKey) throw new Error('To choose an existing folder, add a Google API key to js/config.js (see the README). You can still create a new folder.');
      const token = await getToken();
      await loadPicker();
      const gp = window.google.picker;
      return new Promise((resolve) => {
        const myDrive = new gp.DocsView(gp.ViewId.FOLDERS)
          .setIncludeFolders(true)
          .setSelectFolderEnabled(true)
          .setMimeTypes(FOLDER_MIME)
          .setParent('root');
        const shared = new gp.DocsView(gp.ViewId.FOLDERS)
          .setIncludeFolders(true)
          .setSelectFolderEnabled(true)
          .setMimeTypes(FOLDER_MIME)
          .setEnableDrives(true);
        const builder = new gp.PickerBuilder()
          .setTitle('Choose a backup folder')
          .addView(myDrive)
          .addView(shared)
          .setOAuthToken(token)
          .setCallback((data) => {
            const action = data[gp.Response.ACTION];
            if (action === gp.Action.PICKED) {
              const doc = data[gp.Response.DOCUMENTS][0];
              const f = { id: doc[gp.Document.ID], name: doc[gp.Document.NAME] };
              setFolderChoice(f);
              resolve(f);
            } else if (action === gp.Action.CANCEL || action === 'error') {
              resolve(null);
            }
          });
        if (apiKey) builder.setDeveloperKey(apiKey);
        if (appId) builder.setAppId(appId);
        // Tell the picker which site opened it, so the key's website restriction can be checked
        // even in browsers that send a shortened Referer.
        builder.setOrigin(location.protocol + '//' + location.host);
        if (window.innerWidth < 640) builder.setSize(window.innerWidth, window.innerHeight);
        builder.build().setVisible(true);
      });
    },

    /** Folders this app can already see that hold a Pottery Log (they have its index file). */
    async findLibraries() {
      const idx = await listFiles("appProperties has { key='potteryLog' and value='index' } and trashed = false", 'id, parents');
      const out = [];
      for (const pid of new Set(idx.map((f) => (f.parents || [])[0]).filter(Boolean))) {
        try {
          const res = await api('/files/' + encodeURIComponent(pid) + '?fields=id,name,trashed&' + ALL_DRIVES);
          const f = await res.json();
          if (!f.trashed) out.push({ id: f.id, name: f.name });
        } catch (err) { if (err.reconnect) throw err; }
      }
      return out;
    },

    /** Use a folder found by findLibraries() as the sync folder. */
    useFolder(f) { setFolderChoice(f); },

    async findDataFile(folderId) {
      const files = await listFiles(
        "'" + q(folderId) + "' in parents and appProperties has { key='potteryLog' and value='data' } and trashed = false",
        'id, modifiedTime');
      return files[0] || null;
    },

    /** Map of photoId -> Drive fileId for photos in the folder. */
    async listPhotos(folderId) {
      const files = await listFiles(
        "'" + q(folderId) + "' in parents and trashed = false and mimeType != '" + FOLDER_MIME + "'",
        'id, appProperties');
      const map = new Map();
      files.forEach((f) => {
        const pid = f.appProperties && f.appProperties.potteryPhotoId;
        if (pid) map.set(pid, f.id);
      });
      return map;
    },

    uploadPhoto(folderId, photoId, blob) {
      const ext = (blob.type && blob.type.split('/')[1]) || 'jpg';
      return createFile({
        name: photoId + '.' + ext.replace('jpeg', 'jpg'),
        parents: [folderId],
        appProperties: { potteryPhotoId: photoId },
      }, blob);
    },

    async downloadBlob(fileId) {
      const res = await api('/files/' + encodeURIComponent(fileId) + '?alt=media&' + ALL_DRIVES);
      return res.blob();
    },

    async readData(fileId) {
      const res = await api('/files/' + encodeURIComponent(fileId) + '?alt=media&' + ALL_DRIVES);
      return res.json();
    },

    /* ---- general helpers used by sync.js ---- */

    /** files.list with paging; query uses Drive's search syntax. */
    list: listFiles,
    quote: q,
    create: createFile,
    update: updateFile,
    patch: patchMeta,

    /** Metadata for one file, or null if it doesn't exist or we lost access. */
    async getMeta(fileId, fields) {
      try {
        const res = await api('/files/' + encodeURIComponent(fileId) + '?fields=' + encodeURIComponent(fields) + '&' + ALL_DRIVES);
        return await res.json();
      } catch (err) {
        if (err.status === 404 || err.status === 403) return null;
        throw err;
      }
    },

    async mkdir(name, parentId, appProperties) {
      const res = await api('/files?fields=id,name&' + ALL_DRIVES, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId], appProperties }),
      });
      return (await res.json()).id;
    },

    /** Move to Drive's trash (recoverable for 30 days), not a permanent delete. */
    trash: (fileId) => patchMeta(fileId, { trashed: true }),

    async deleteFile(fileId) {
      await api('/files/' + encodeURIComponent(fileId) + '?' + ALL_DRIVES, { method: 'DELETE' });
    },
  };

  window.Drive = Drive;
})();
