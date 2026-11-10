# Pottery Log

A small, mobile-friendly web app for logging pottery pieces: title, photos, clay body, forming method (wheel or hand-built), glazes, firing type and cone, stage (greenware → bisque → glazed → done), dates and notes.

- **Plain HTML, CSS and JavaScript.** No build step, no dependencies, no framework.
- **Data lives on your device** in the browser's IndexedDB, including photos (resized to 1600 px JPEGs).
- **Optional backup to your own Google Drive** with "Sign in with Google". The app asks only for the `drive.file` scope, so it can see and change only the files it created, never the rest of your Drive.
- **Installable** on Android (and desktop Chrome) through the web app manifest, and it opens offline thanks to a small service worker.

## Files

```
index.html               App shell and view templates
privacy.html             Privacy policy (link it on the OAuth consent screen)
css/styles.css           Styles (light and dark)
js/config.js             Your Google OAuth client ID and API key go here
js/db.js                 IndexedDB storage (pieces + photos)
js/drive.js              Google sign-in and Drive API calls
js/app.js                Views, routing, photo handling, backup/restore
sw.js                    Service worker (offline app shell)
manifest.webmanifest     Home-screen install metadata
icons/                   App icons (192, 512, maskable 512)
.nojekyll                Tells GitHub Pages to serve files as-is
```

## Hosting on GitHub Pages

1. Push these files to the `main` branch of the repository.
2. On GitHub, open the repository's **Settings → Pages**.
3. Under **Build and deployment**, set **Source** to *Deploy from a branch*, pick **main** and **/ (root)**, and save.
4. After a minute the site is live at `https://<your-username>.github.io/pottery-log/`.

Everything uses relative paths, so it works from that sub-path without changes.

## Setting up Google sign-in (Google Cloud OAuth)

The app works fully without this; you only need it for Drive backup. You do it once, and it's free.

### 1. Create a Google Cloud project

1. Go to <https://console.cloud.google.com/> and sign in.
2. Use the project picker at the top → **New project**. Name it e.g. `Pottery Log` and create it. Make sure it's selected.

### 2. Enable the Google Drive and Google Picker APIs

1. Go to **APIs & Services → Library**.
2. Search for **Google Drive API**, open it, and click **Enable**.
3. Search for **Google Picker API**, open it, and click **Enable**. The app uses Google's folder picker so you can choose an existing Drive folder for backups.

### 3. Configure the OAuth consent screen

In the current console this is under **Google Auth Platform** (older consoles call it **APIs & Services → OAuth consent screen**).

1. **Branding / App information:** app name `Pottery Log`, your email as the support email and developer contact.
2. **Audience:** choose **External**.
3. **Data access (Scopes):** click **Add or remove scopes** and add
   `https://www.googleapis.com/auth/drive.file` ("See, edit, create, and delete only the specific Google Drive files you use with this app"). It is a *non-sensitive* scope, so no Google verification is needed for it.
4. **Test users:** while the app's publishing status is **Testing**, only listed accounts can sign in. Add your own Google account (and anyone else who'll use it, up to 100).

> **Testing vs. production.** In *Testing* mode Google shows an "unverified app" warning and may expire a user's consent after 7 days, so you'd occasionally sign in again. To remove that, go to **Audience** and click **Publish app**. Because `drive.file` is non-sensitive, publishing doesn't require a security review; Google may ask you to confirm the app's branding: use the app's URL as the home page and `…/pottery-log/privacy.html` as the privacy policy link (see [Privacy](#privacy)). For personal use, staying in Testing is fine.

### 4. Create the OAuth client ID

1. Go to **Clients** (or **APIs & Services → Credentials**) → **Create client** / **Create credentials → OAuth client ID**.
2. **Application type:** *Web application*. Name: `Pottery Log web`.
3. **Authorized JavaScript origins:** add the *origin* only (scheme + host, no path, no trailing slash):
   - `https://<your-username>.github.io`
   - `http://localhost:8000` (optional, for local testing)
4. **Authorized redirect URIs:** leave empty. The app uses the Google Identity Services popup token flow, which doesn't need one.
5. Click **Create** and copy the **Client ID** (it ends in `.apps.googleusercontent.com`). You don't need the client secret; a browser app must never use one.

### 5. Create an API key for the folder picker

The Google Picker needs an API key alongside the OAuth client. You can skip this step if you only ever want the app to create new backup folders; **Choose folder** then won't work.

1. Go to **APIs & Services → Credentials → Create credentials → API key**, and copy the key (it starts with `AIza`).
2. Open the key with **Edit API key** and restrict it:
   - **Application restrictions:** *Websites*, and add `https://<your-username>.github.io/*` (plus `http://localhost:8000/*` for local testing).
   - **API restrictions:** *Restrict key* and select only **Google Picker API**.
3. Save.

### 6. Put the IDs in the app

Edit `js/config.js`:

```js
window.POTTERY_CONFIG = {
  googleClientId: '1234567890-abc123def456.apps.googleusercontent.com',
  googleApiKey: 'AIzaSy...your-key...',
  googleAppId: '', // leave empty; it's the number at the start of the client ID
};
```

Commit and push. The client ID and API key are public by design: they're visible in every page that uses Google sign-in or the Picker. They're fine in a public repo, because they only work from the sites you allowed in steps 4 and 5. `googleAppId` is your Cloud project number. The app reads it from the start of the client ID, so you only need to fill it in if your client ID doesn't start with that number. The Picker uses it so that picking a folder grants the app access to that folder.

Origin changes can take a few minutes to take effect on Google's side. If you see `Error 400: origin_mismatch` or `redirect_uri_mismatch`, double-check the origin in step 4 exactly matches the address bar (https, no path). If the folder picker says "The API developer key is invalid", check that the key's website restriction includes your site and that the Google Picker API is enabled.

## Using backup and restore

Tap the cloud icon in the top bar.

- **Sign in with Google** opens Google's popup. Grant access to "the specific Google Drive files you use with this app".
- **Backup folder** shows where backups go. Set it before your first backup:
  - **Choose folder** opens Google's folder picker. Pick any folder in My Drive or a shared drive. Picking it gives the app access to that one folder, and nothing else in your Drive.
  - **New folder** creates a folder with the name you type (default `Pottery Log`) at the top of My Drive.
- **Back up now** writes `pottery-log.json` (all piece details) and one JPEG per photo into the backup folder. Later backups upload only new photos, rewrite the JSON, and remove photos of deleted pieces. The app only ever touches files it created, so other files you keep in that folder are left alone. A backup is a snapshot of this device: if the folder holds a newer backup from a different device, the app warns you before overwriting it.
- **Back up automatically whenever I save** is offered next to the sign-in button, and you can switch it on or off later. When it's on, every save, stage change or delete backs up in the background. The cloud icon pulses while that runs and shows a yellow dot when there are changes not yet in Drive. If an automatic backup can't run (offline, or no folder chosen), the dot stays until the next save, the next app launch with a connection, or a manual **Back up now**. Automatic backup never overwrites a newer backup from another device. It stops and asks you to decide on the Backup screen.
- **Restore from Drive** replaces the pieces on this device with the backup in the chosen folder, downloading any photos that aren't already here.

If you change the backup folder, the next backup copies everything into the new folder. The old folder is left as it was.

To move to a new phone: back up on the old one. Then install the app on the new one, sign in, use **Choose folder** to pick the same folder, and restore.

The app remembers your Google account, backup folder and auto-backup setting until you tap **Sign out**, including across app restarts. Google gives browser-only apps access tokens that last about an hour, with no long-lived refresh token, so the app keeps the current token on the device and asks Google for a new one when it runs out. Google only allows that at the moment you tap something. After an hour or so, the next save (or **Back up now**) briefly flashes Google's popup, which closes by itself without asking anything. If popups are blocked, allow them for your github.io site.

## Adding to an Android home screen

Open the site in Chrome on Android, then tap **⋮ → Add to Home screen** (or **Install app** if Chrome offers it). It opens full-screen like a regular app and works offline. Adding it to the home screen also makes Chrome much less likely to clear its stored data.

## Running locally

Any static file server works, for example:

```sh
python3 -m http.server 8000
```

then open <http://localhost:8000>. (Opening `index.html` directly from disk works for logging, but Google sign-in and the service worker need `http://localhost` or `https`.)

## Updating the app

When you change any file, bump `VERSION` in `sw.js` so installed copies refresh their offline cache. The service worker fetches from the network first, so online users get changes right away regardless.

## Privacy

There's no server. Pieces and photos stay in your browser's storage on your device, and in your own Google Drive if you back up. The app never sees the rest of your Drive.

The full policy is in [`privacy.html`](privacy.html), served at `https://<your-username>.github.io/pottery-log/privacy.html`. Use that URL as the **Privacy policy link** on the OAuth consent screen (Google Auth Platform → **Branding**). The home page link is `https://<your-username>.github.io/pottery-log/`.
