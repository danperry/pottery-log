/* Google sign-in (Google Identity Services token model) and Google Drive REST helpers.
 * Uses only the https://www.googleapis.com/auth/drive.file scope, so the app can
 * see and change only the files it created itself.
 *
 * The user picks the backup folder: either an existing folder chosen with the
 * Google Picker (which grants this app access to just that folder) or a new
 * folder the app creates. Inside it:
 *     pottery-log.json           data     appProperties.potteryLog = "data"
 *     <photoId>.jpg              photos   appProperties.potteryPhotoId = <photoId>
 */
(function () {
  'use strict';

  const SCOPE = 'https://www.googleapis.com/auth/drive.file';
  const GIS_SRC = 'https://accounts.google.com/gsi/client';
  const GAPI_SRC = 'https://apis.google.com/js/api.js';
  const FOLDER_MIME = 'application/vnd.google-apps.folder';
  const API = 'https://www.googleapis.com/drive/v3';
  const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
  const TOKEN_KEY = 'potteryLog.driveToken';
  const ACCOUNT_KEY = 'potteryLog.driveAccount';
  const FOLDER_KEY = 'potteryLog.driveFolder';

  const cfg = window.POTTERY_CONFIG || {};
  const clientId = (cfg.googleClientId || '').trim();
  const apiKey = (cfg.googleApiKey || '').trim();
  // The Picker's app ID is the Cloud project number, which is the client ID's numeric prefix.
  const appId = (String(cfg.googleAppId || '').trim() || (clientId.match(/^(\d+)-/) || [])[1] || '');

  let gisPromise = null;
  let pickerPromise = null;
  let tokenClient = null;
  let pending = null; // { resolve, reject } for the in-flight token request

  function loadGis() {
    if (gisPromise) return gisPromise;
    gisPromise = new Promise((resolve, reject) => {
      if (window.google && google.accounts && google.accounts.oauth2) return resolve();
      const s = document.createElement('script');
      s.src = GIS_SRC;
      s.async = true;
      s.defer = true;
      s.onload = () => resolve();
      s.onerror = () => { gisPromise = null; reject(new Error('Could not load Google sign-in. Check your connection.')); };
      document.head.appendChild(s);
    });
    return gisPromise;
  }

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

  function initClient() {
    if (tokenClient) return tokenClient;
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPE,
      callback: (resp) => {
        const p = pending; pending = null;
        if (!p) return;
        if (resp.error) return p.reject(new Error(resp.error_description || resp.error));
        if (!google.accounts.oauth2.hasGrantedAllScopes(resp, SCOPE)) {
          return p.reject(new Error('Google Drive access was not granted.'));
        }
        const token = { value: resp.access_token, expires: Date.now() + (Number(resp.expires_in) - 60) * 1000 };
        try { localStorage.setItem(TOKEN_KEY, JSON.stringify(token)); } catch (e) { /* ignore */ }
        p.resolve(token.value);
      },
      error_callback: (err) => {
        const p = pending; pending = null;
        if (!p) return;
        const msg = err && err.type === 'popup_closed' ? 'Sign-in was cancelled.'
          : err && err.type === 'popup_failed_to_open' ? 'The sign-in popup was blocked. Allow popups for this site and try again.'
          : 'Sign-in failed.';
        p.reject(new Error(msg));
      },
    });
    return tokenClient;
  }

  function storedToken() {
    try {
      const t = JSON.parse(localStorage.getItem(TOKEN_KEY) || 'null');
      if (t && t.value && t.expires > Date.now()) return t.value;
    } catch (e) { /* ignore */ }
    return null;
  }

  function clearToken() {
    try { localStorage.removeItem(TOKEN_KEY); } catch (e) { /* ignore */ }
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

  /**
   * Get an access token. Must be called directly from a user gesture (click) when
   * no valid token is cached, because it may open Google's popup.
   */
  function getToken(interactive) {
    const t = storedToken();
    if (t) return Promise.resolve(t);
    if (!clientId) return Promise.reject(new Error('Google sign-in is not configured.'));
    if (!(window.google && google.accounts && google.accounts.oauth2)) {
      return loadGis().then(() => getToken(interactive));
    }
    initClient();
    return new Promise((resolve, reject) => {
      if (pending) pending.reject(new Error('Superseded'));
      pending = { resolve, reject };
      const acct = getAccount();
      const opts = {};
      if (acct && acct.email) opts.login_hint = acct.email;
      // First sign-in shows the consent screen; later ones usually just flash the popup.
      opts.prompt = interactive === 'consent' || !acct ? 'consent' : '';
      tokenClient.requestAccessToken(opts);
    });
  }

  async function api(path, opts = {}, retry = true) {
    const token = await getToken();
    const res = await fetch(path.startsWith('http') ? path : API + path, {
      ...opts,
      headers: { Authorization: 'Bearer ' + token, ...(opts.headers || {}) },
    });
    if (res.status === 401 && retry) {
      clearToken();
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

  async function updateFileContent(fileId, blob) {
    await api(UPLOAD + '/files/' + encodeURIComponent(fileId) + '?uploadType=media&fields=id&' + ALL_DRIVES, {
      method: 'PATCH', headers: { 'Content-Type': blob.type || 'application/octet-stream' }, body: blob,
    });
  }

  const Drive = {
    configured: !!clientId,
    getAccount,
    isSignedIn: () => !!getAccount(),
    hasToken: () => !!storedToken(),
    preload: () => (clientId ? loadGis().catch(() => {}) : Promise.resolve()),

    /** Interactive sign-in. Call from a click handler. */
    async signIn() {
      await getToken('consent');
      const res = await api('/about?fields=user(displayName,emailAddress)');
      const j = await res.json();
      const acct = { name: j.user && j.user.displayName, email: j.user && j.user.emailAddress };
      setAccount(acct);
      return acct;
    },

    async signOut() {
      const t = storedToken();
      clearToken();
      setAccount(null);
      setFolderChoice(null);
      if (t && window.google && google.accounts && google.accounts.oauth2) {
        try { google.accounts.oauth2.revoke(t, () => {}); } catch (e) { /* ignore */ }
      }
    },

    /** Make sure we have a token; call first thing in a click handler so any popup is allowed. */
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
     * if cancelled. Call ensureToken() first, from the click handler.
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
            } else if (action === gp.Action.CANCEL) {
              resolve(null);
            }
          });
        if (apiKey) builder.setDeveloperKey(apiKey);
        if (appId) builder.setAppId(appId);
        if (window.innerWidth < 640) builder.setSize(window.innerWidth, window.innerHeight);
        builder.build().setVisible(true);
      });
    },

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

    async writeData(folderId, existingFileId, data) {
      const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
      if (existingFileId) {
        await updateFileContent(existingFileId, blob);
        return existingFileId;
      }
      return createFile({
        name: 'pottery-log.json',
        parents: [folderId],
        mimeType: 'application/json',
        appProperties: { potteryLog: 'data' },
      }, blob);
    },

    async deleteFile(fileId) {
      await api('/files/' + encodeURIComponent(fileId) + '?' + ALL_DRIVES, { method: 'DELETE' });
    },
  };

  window.Drive = Drive;
})();
