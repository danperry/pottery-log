# Pottery Log

A small, mobile-friendly web app for logging pottery pieces: title, photos, clay body, forming method (wheel or hand-built), glazes, firing type and cone, stage (greenware → bisque → glazed → done), dates and notes.

- **Plain HTML, CSS and JavaScript.** No build step, no dependencies, no framework.
- **Data lives on your device** in the browser's IndexedDB, including photos (resized to 1600 px JPEGs).
- **Optional backup to your own Google Drive** with "Sign in with Google". The app asks only for the `drive.file` scope, so it can see and change only the files it created, never the rest of your Drive. You sign in once and stay connected, thanks to a tiny sign-in Worker on Cloudflare's free tier (`worker/`).
- **Installable** on Android (and desktop Chrome) through the web app manifest, and it opens offline thanks to a small service worker.

## Files

```
index.html               App shell and view templates
privacy.html             Privacy policy (link it on the OAuth consent screen)
css/styles.css           Styles (light and dark)
js/config.js             Worker URL, Google client ID and API key go here
js/db.js                 IndexedDB storage (pieces, photos, encrypted sign-in)
js/drive.js              Google sign-in (via the Worker) and Drive API calls
js/app.js                Views, routing, photo handling, backup/restore
sw.js                    Service worker (offline app shell)
worker/src/index.js      Cloudflare Worker that keeps you signed in (see "Sign-in Worker")
worker/wrangler.toml     Worker settings: name and APP_URL (secrets are set separately)
worker/package.json      Marks the Worker code as an ES module; no dependencies
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

> **Set the publishing status to "In production".** While the app is in *Testing*, Google expires refresh tokens after **7 days**, so everyone would have to reconnect every week. That defeats the point of the sign-in Worker. Go to **Audience** and click **Publish app**. Because `drive.file` is non-sensitive, publishing doesn't require a security review. Google may ask you to confirm the app's branding: use the app's URL as the home page and `…/pottery-log/privacy.html` as the privacy policy link (see [Privacy](#privacy)). Until Google verifies the app, people see an "unverified app" notice on the consent screen, which they can click past. The 100-user cap applies until then.

### 4. Create the OAuth client ID

1. Go to **Clients** (or **APIs & Services → Credentials**) → **Create client** / **Create credentials → OAuth client ID**.
2. **Application type:** *Web application*. Name: `Pottery Log web`.
3. **Authorized JavaScript origins:** add the *origin* only (scheme + host, no path, no trailing slash):
   - `https://<your-username>.github.io`
   - `http://localhost:8000` (optional, for local testing)
4. **Authorized redirect URIs:** add your Worker's callback URL. You'll know it after deploying the Worker (see [Sign-in Worker](#sign-in-worker)): `https://pottery-log-auth.<your-workers-subdomain>.workers.dev/auth/callback`. For local Worker testing, also add `http://localhost:8787/auth/callback`.
5. Click **Create**, then copy the **Client ID** (ends in `.apps.googleusercontent.com`) and the **Client secret**. The secret goes only into the Worker as a secret. Never put it in the app or the repo.

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
  authWorkerUrl: 'https://pottery-log-auth.your-subdomain.workers.dev', // no trailing slash
  googleClientId: '1234567890-abc123def456.apps.googleusercontent.com',
  googleApiKey: 'AIzaSy...your-key...',
  googleAppId: '', // leave empty; it's the number at the start of the client ID
};
```

Commit and push. None of these are secrets. The client ID and API key are public by design: they're visible in every page that uses Google sign-in or the Picker. They're fine in a public repo, because they only work from the sites you allowed in steps 4 and 5. `googleAppId` is your Cloud project number. The app reads it from the start of the client ID, so you only need to fill it in if your client ID doesn't start with that number. The Picker uses it so that picking a folder grants the app access to that folder.

Changes in Google Cloud can take a few minutes to take effect. If you see `Error 400: redirect_uri_mismatch`, the callback URL in step 4 must match the Worker's address exactly (https, ending in `/auth/callback`). If the folder picker says "The API developer key is invalid", check that the key's website restriction includes your site and that the Google Picker API is enabled.

## Sign-in Worker

Browser-only Google sign-in can't keep you signed in: it only hands out access tokens that last an hour, and getting a long-lived *refresh token* needs the OAuth client secret, which can't live in a public web page. `worker/` is a small [Cloudflare Worker](https://developers.cloudflare.com/workers/) that holds the secret and does just that part. It stores nothing.

| Endpoint | What it does |
| --- | --- |
| `GET /auth/start` | Sends the browser to Google's consent screen using the authorization-code flow with PKCE, `access_type=offline`, `prompt=consent` and the `drive.file` scope only. A short-lived, HttpOnly cookie ties the callback to this browser. |
| `GET /auth/callback` | Exchanges Google's code for tokens using the client secret, encrypts the refresh token with AES-GCM (key `TOKEN_ENC_KEY`), and redirects back to the app with the encrypted blob in the URL fragment. The fragment isn't sent to GitHub's servers, and the app removes it from the address bar and history straight away. |
| `POST /auth/token` | Takes `{ blob }`, decrypts it, asks Google for a fresh access token, and returns only `{ access_token, expires_in, expires_at }`. Returns `401 {"error":"invalid_grant"}` when the sign-in is no longer valid. |
| `POST /auth/revoke` | Takes `{ blob }` and revokes the refresh token with Google. Used by **Disconnect**. |

`/auth/token` and `/auth/revoke` only answer requests from the app's origin (`APP_URL`), and send CORS headers for that origin only. The app keeps the encrypted blob in IndexedDB, and the access token in memory only. Neither is ever put in `localStorage`. The blob is useless without `TOKEN_ENC_KEY`.

### Deploying it (free tier)

You need a free Cloudflare account and Node.js 18 or later.

```sh
cd worker
npx wrangler login                      # opens the browser once
# Check APP_URL in wrangler.toml matches your app, e.g. https://<you>.github.io/pottery-log/
npx wrangler deploy                     # prints https://pottery-log-auth.<subdomain>.workers.dev
```

Then set the three secrets. Each command prompts for the value, which is stored encrypted by Cloudflare and never in the repo:

```sh
npx wrangler secret put GOOGLE_CLIENT_ID       # the OAuth client ID
npx wrangler secret put GOOGLE_CLIENT_SECRET   # the OAuth client secret
openssl rand -base64 32                        # make a key, then paste it into:
npx wrangler secret put TOKEN_ENC_KEY
```

Finally:

1. In Google Cloud, add `https://pottery-log-auth.<subdomain>.workers.dev/auth/callback` as an **Authorized redirect URI** on the OAuth client (step 4 above).
2. Put `https://pottery-log-auth.<subdomain>.workers.dev` in `authWorkerUrl` in `js/config.js`, then commit and push.
3. Make sure the consent screen is **In production** (step 3 above), or sign-ins will expire after 7 days.

Keep `TOKEN_ENC_KEY` the same from then on. Changing it makes every saved sign-in unreadable, and everyone will see **Reconnect Google Drive** once. That's a quick way to sign everyone out if you ever need to.

To try the Worker locally, put the three secrets in `worker/.dev.vars` (one `NAME=value` per line, git-ignored). Set `APP_URL = "http://localhost:8000/"`, run `npx wrangler dev` (it serves on port 8787), and point `authWorkerUrl` at `http://localhost:8787`.

## Using backup and restore

Tap the cloud icon in the top bar.

- **Sign in with Google** takes you to Google's consent screen and back. Grant access to "the specific Google Drive files you use with this app". You stay signed in from then on.
- **Backup folder** shows where backups go. Set it before your first backup:
  - **Choose folder** opens Google's folder picker. Pick any folder in My Drive or a shared drive. Picking it gives the app access to that one folder, and nothing else in your Drive.
  - **New folder** creates a folder with the name you type (default `Pottery Log`) at the top of My Drive.
- **Back up now** writes `pottery-log.json` (all piece details) and one JPEG per photo into the backup folder. Later backups upload only new photos, rewrite the JSON, and remove photos of deleted pieces. The app only ever touches files it created, so other files you keep in that folder are left alone. A backup is a snapshot of this device: if the folder holds a newer backup from a different device, the app warns you before overwriting it.
- **Back up automatically whenever I save** is offered next to the sign-in button, and you can switch it on or off later. When it's on, every save, stage change or delete backs up in the background. The cloud icon pulses while that runs and shows a yellow dot when there are changes not yet in Drive. If an automatic backup can't run (offline, or no folder chosen), the dot stays until the next save, the next app launch with a connection, or a manual **Back up now**. Automatic backup never overwrites a newer backup from another device. It stops and asks you to decide on the Backup screen.
- **Restore from Drive** replaces the pieces on this device with the backup in the chosen folder, downloading any photos that aren't already here.

If you change the backup folder, the next backup copies everything into the new folder. The old folder is left as it was.

To move to a new phone: back up on the old one. Then install the app on the new one, sign in, use **Choose folder** to pick the same folder, and restore.

The app stays connected until you tap **Disconnect**, across restarts and without asking again. Before each Drive call it gets a fresh access token from the Worker if it has none, or if the one it has expires within 5 minutes.

- **Reconnect Google Drive:** Google ends a sign-in when you remove the app's access in your Google account, or when it goes unused for 6 months. It also ends after 7 days while the consent screen is still in Testing. When that happens, the app forgets the saved sign-in and shows a single **Reconnect Google Drive** button. Everything on the device stays, and you can keep logging pieces. Changes made meanwhile are backed up after you reconnect.
- **Disconnect** revokes the app's access with Google and deletes the saved sign-in from this device. Your backups in Drive and your pieces on the device are kept. If Google can't be reached at that moment, the app says so; you can also remove access at <https://myaccount.google.com/connections>.

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

Pieces and photos stay in your browser's storage on your device, and in your own Google Drive if you back up. The app never sees the rest of your Drive. The only server is the sign-in Worker. It handles your Google refresh token just long enough to get access tokens, never sees your pieces or files, and stores nothing.

The full policy is in [`privacy.html`](privacy.html), served at `https://<your-username>.github.io/pottery-log/privacy.html`. Use that URL as the **Privacy policy link** on the OAuth consent screen (Google Auth Platform → **Branding**). The home page link is `https://<your-username>.github.io/pottery-log/`.
