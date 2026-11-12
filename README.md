# Pottery Log

A small, mobile-friendly web app for logging pottery pieces: title, photos, clay bodies (one or several), forming method (wheel or hand-built), bisque and glaze firing (type and cone for each), stage (greenware → bisque → glazed → done), dates and notes.

- **Plain HTML, CSS and JavaScript.** No build step, no dependencies, no framework. 
- **Data lives on your device** in the browser's IndexedDB, including photos (resized to 1600 px JPEGs).
- **Photos** swipe on a phone, or use the arrows on a computer. **Add photos** under the photos adds more without opening Edit.
- **Thumbnails.** Each piece has a small list thumbnail, made from its newest photo. Tap a photo on the Edit screen to use that one instead.
- **Storage limit.** Settings → *On this device* sets how much room photos may take on this device (500 MB by default). See [Device storage](#device-storage).
- **Optional sync with your own Google Drive** with "Sign in with Google". The app asks only for the `drive.file` scope, so it can see and change only the files it created, never the rest of your Drive. You sign in once and stay connected, thanks to a tiny sign-in Worker on Cloudflare's free tier (`worker/`).
- **Installable** on Android (and desktop Chrome) through the web app manifest, and it opens offline thanks to a small service worker.

## Files

```
index.html               App shell and view templates
privacy.html             Privacy policy (link it on the OAuth consent screen)
css/styles.css           Styles (light and dark)
js/config.js             Worker URL, Google client ID and API key go here
js/db.js                 IndexedDB storage (pieces, photos, thumbnails, encrypted sign-in)
js/photo-cache.js        Keeps photos under the storage limit (removes old ones that are safe in Drive)
js/drive.js              Google sign-in (via the Worker) and Drive API calls
js/settings.js           Custom fields, filter choices and the glaze and clay lists (synced in the index)
js/sync.js               Two-way sync with the Drive folder (one folder per piece)
js/app.js                Views, routing, photo handling, sync triggers
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

## Syncing with Google Drive

Tap the gear icon in the top bar to open Settings. Until you connect, the home screen also shows a **Connect Google Drive** tip.

- **Sign in with Google** takes you to Google's consent screen and back. Grant access to "the specific Google Drive files you use with this app". You stay signed in from then on.
- **Drive folder** is where your pieces go. Set it once on each device:
  - **Choose folder** opens Google's folder picker. Pick any folder in My Drive or a shared drive. Picking it gives the app access to that one folder, and nothing else in your Drive.
  - **New folder** creates a folder with the name you type (default `Pottery Log`) at the top of My Drive.
  - **Pottery Log folders already in your Drive** are listed as buttons once you're signed in, so on a new device or browser you can tap the existing folder without opening the picker.

  Some browsers (for example Comet) block Google's folder picker, which then says "The API developer key is invalid". Use **New folder** there, or pick the folder once in Chrome; after that it's listed on every browser.
- **Sync now** brings this device and the folder up to date with each other. The app also syncs by itself whenever it opens, when you come back to it after a minute or more, and when the connection returns.
- **Syncing is automatic** once you're connected: when the app opens and after every save, stage change or delete. The gear icon spins while it runs and shows a dot when there are changes not yet in Drive.
- **Lost connection:** if Google ends the sign-in, a **Reconnect** bar appears at the top of every screen. Your pieces stay on the device meanwhile and sync after you reconnect.

### What's in the folder

Everything is meant to be readable in Drive without the app:

```
Pottery Log/
  pottery-log-index.json     every piece in one list (title, stage, clay, glazes, dates, savedAt…)
  Speckled mug/              one folder per piece, named after its title
    piece.json               all its details, including notes, pretty-printed
    photo-1.jpg              its photos, in order
    photo-2.jpg
  Celadon bowl/
    …
```

`piece.json` looks like this:

```json
{
  "title": "Speckled mug",
  "stage": "Glazed",
  "clays": ["B-Mix", "Porcelain"],
  "formingMethod": "Wheel",
  "glazes": ["Celadon"],
  "bisqueFiring": { "type": "Electric (oxidation)", "cone": "04" },
  "glazeFiring": { "type": "Electric (oxidation)", "cone": "6" },
  "dates": { "made": "2026-11-02", "bisqueFired": "2026-11-08", "glazeFired": "2026-11-11", "finished": "" },
  "notes": "Thin rim, two coats.",
  "photos": ["photo-1.jpg", "photo-2.jpg"],
  "thumbnail": "photo-1.jpg",
  "savedAt": "2026-11-11T15:04:05.000Z",
  "createdAt": "2026-11-02T18:00:00.000Z",
  "id": "…"
}
```

`thumbnail` is only there when a photo was picked as the thumbnail on the Edit screen. Without it the newest photo is used.

Renaming a piece renames its folder. Deleting a piece moves its folder to Drive's trash (recoverable for 30 days), and the index keeps a short `"deleted": true` entry so your other devices delete it too. Trashing a piece's folder yourself in Drive also removes it from your devices at their next sync, unless a device has unsynced changes to it, in which case that device puts it back. The app only ever touches files it created, so anything else you keep in the folder is left alone.

### Glazes and clays

Glazes and clay bodies are picked from drop-downs on the edit form. Choose **+ New glaze…** or **+ New clay body…** to type one that isn't in the list yet; it's remembered when you save the piece. A piece can have several glazes and several clay bodies.

Cones are recorded per piece, in the Bisque and Glaze sections, rather than on the clay. Edit both lists under **Settings → Glazes and clays**: add or remove names. Removing a name only takes it out of the drop-down; pieces that use it keep it, and it stays out of the list when you edit those pieces.

The first time the app opens after this update, it fills the lists from the glazes and clays your pieces already use. The lists are stored in `pottery-log-index.json` under `"settings"` and sync like custom fields (latest save wins):

```json
"settings": { "glazes": ["Celadon", "Shino"], "clays": [{ "name": "B-Mix" }], … }
```

The edit form has a **Bisque** section and a **Glaze** section, each with its own Firing type and Cone. They're saved separately as `"bisqueFiring"` and `"glazeFiring"`. A piece saved before this change had one `"firing"`; it's read as the glaze firing.

Pieces saved by older versions have a single `"clayBody"`; the app reads it as a one-item `"clays"` list and writes `"clays"` the next time the piece is saved.

### Custom fields and filters

Every log starts with four custom fields: **Purpose** (text, starting with Keep, Give and Sell), **Type** (text, starting with Bowl, Vase and Mug), **Price** (currency) and **Sold** (yes / no, No unless ticked). With **Integrate with Square** on (the default), there's also **Transaction** (a link); see [Selling with Square](#selling-with-square). They're added once, so if you remove one it stays removed on all your devices. (Logs started before Type existed had it as **Line**; it's renamed to Type with Bowl, Vase and Mug added, unless you'd already renamed it.) Drag a field by its dots in Settings (or focus the dots and use the arrow keys) to change the order; the edit form and details follow it, and the order syncs.

Add your own fields (Text, Number, Currency, Date, Yes / no, a Choice list, or a Link) under **Settings → Custom fields** (the gear icon). They appear on every piece's edit form and details, and in `piece.json` by name:

```json
"customFields": { "Type": "Mug", "Price": 45, "Purpose": "Give" }
```

Each text field has its own **Remember entered values for a drop-down** setting (on by default for new fields): the edit form shows a drop-down of the values entered so far, with **+ New…** to type another. Tap the pencil next to a field to rename it, change its type, turn remembering on or off, or edit its list one value per line. Switching a remembered text field to a choice list turns its remembered values into the choices, and switching back does the reverse. Values already saved on pieces are never changed. A renamed field still reads older `piece.json` files that use its previous name.

On the home screen, the filter button next to search opens a pop-up where you choose which fields to filter by: clay body, forming method, glaze, bisque or glaze firing type and cone, or any of your own fields. Each chosen field becomes a drop-down listing the values your pieces have. The field definitions (with remembered values) and the filter choice are stored in `pottery-log-index.json` under `"settings"` and sync like pieces (latest save wins). The values you pick in the drop-downs stay on each device.

Removing a field hides it everywhere and leaves it out of `piece.json` the next time each piece is saved.

A **Currency** field has its own currency, which starts as the one for your device's region (for example GBP for en-GB) and can be changed in the field's settings. Amounts are shown in that currency and saved in `piece.json` as plain numbers. A **Link** field holds a web address (https:// is added if you leave it off) and shows as a tappable link.

### Selling with Square

**Settings → Square → Integrate with Square** is on by default. While it's on, every piece has **Price** (currency), **Sold** (yes / no) and **Transaction** (link). Those three can be renamed but not removed or changed to another type; turn the integration off to do that.

A piece with a price that isn't sold gets a **Charge with Square** button. On an Android phone or an iPhone/iPad it opens the Square Point of Sale app with the price filled in and a note holding the piece's title and link. When the sale finishes, Square opens Pottery Log again; the piece is marked **Sold** and **Transaction** links to the sale in your Square Dashboard. A cancelled sale changes nothing.

One-time setup (free):

1. Sign in at [developer.squareup.com/apps](https://developer.squareup.com/apps) with your Square account and create an application.
2. Copy its **Production Application ID** (starts with `sq0idp-`) into **Settings → Square** (or set `squareAppId` in `js/config.js`). It isn't a secret.
3. In the application, open **Point of Sale API** and under **Web** add the callback URL shown in Settings, e.g. `https://danperry.github.io/pottery-log/`. Save.
4. Install the Square Point of Sale app on the phone and sign in.

The price's currency must match your Square account's currency. On iPhone, Square returns to the callback URL in Safari, which keeps its pieces apart from a home-screen copy of the app; if the piece isn't found there, a note offers the transaction link to copy and paste into **Transaction**. On Android, an installed app usually opens directly. If Square was offline (cash, offline mode), there's no transaction ID yet, so the link opens your Square sales list.

### Conflicts: the latest save wins

Every save records when it happened (`savedAt`). If the same piece was changed on two devices before they synced, the version saved most recently is kept, as a whole piece, and the other device picks it up at its next sync. This relies on the devices' clocks being roughly right, which phones keep automatically.

### Fast opening: pieces load on demand

On open, the app reads only the index, so even a long log appears quickly. Pieces that came from another device show their summary (title, stage, clay, glazes, dates and cover photo) straight away. Their notes and other photos download the first time you open the piece, and are kept on the device after that. Offline, an unopened piece shows its summary and says the rest will load when you're back online.

### Device storage

Photos are the only thing that takes real room, so the app keeps them under a limit you choose in Settings → *On this device* (100 MB to 5 GB, 500 MB by default; it applies to this device only). When photos go over the limit, the full-size photos of the pieces you opened longest ago are removed from the device until they fit again, with a little to spare. They stay in Google Drive and download again when you open the piece. The piece on screen is never trimmed.

Only photos that are already in the connected Drive folder are ever removed. Without Google Drive connected, or for photos that haven't synced yet, nothing is removed. If you switch to another Drive folder, photos that were removed from the device are downloaded from the old folder and copied over.

Each piece's list thumbnail is small (320 px) and is kept separately, so the list still looks right after full-size photos are removed. Thumbnails are removed only in an emergency: when removing every full-size photo that can be removed still isn't enough. A piece whose thumbnail was removed shows the pot icon in the list until it's opened again.

While the device is offline, a small note under the title bar says everything is saved on the device and will sync when you're back online; saving a piece says the same. The app syncs on its own as soon as the connection returns.

### Moving devices and changing folders

To set up a new phone: install the app, sign in and use **Choose folder** to pick the same folder. Your pieces appear and fill in as you open them.

If you change to a different folder, the next sync copies every piece into it. The old folder is left as it was.

Backups made by earlier versions of the app (a single `pottery-log.json` plus loose photos) are converted automatically the first time you sync with that folder. The pieces are moved into the new layout and the old files go to Drive's trash.

The app stays connected until you tap **Disconnect**, across restarts and without asking again. Before each Drive call it gets a fresh access token from the Worker if it has none, or if the one it has expires within 5 minutes.

- **Reconnect Google Drive:** Google ends a sign-in when you remove the app's access in your Google account, or when it goes unused for 6 months. It also ends after 7 days while the consent screen is still in Testing. When that happens, the app forgets the saved sign-in and shows a single **Reconnect Google Drive** button. Everything on the device stays, and you can keep logging pieces. Changes made meanwhile sync after you reconnect.
- **Disconnect** revokes the app's access with Google and deletes the saved sign-in from this device. Your files in Drive and your pieces on the device are kept. Pieces that came from Drive but were never opened on this device keep only their summary until you reconnect. If Google can't be reached at that moment, the app says so; you can also remove access at <https://myaccount.google.com/connections>.

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

Pieces and photos stay in your browser's storage on your device, and in your own Google Drive if you connect it. The app never sees the rest of your Drive. The only server is the sign-in Worker. It handles your Google refresh token just long enough to get access tokens, never sees your pieces or files, and stores nothing.

The full policy is in [`privacy.html`](privacy.html), served at `https://<your-username>.github.io/pottery-log/privacy.html`. Use that URL as the **Privacy policy link** on the OAuth consent screen (Google Auth Platform → **Branding**). The home page link is `https://<your-username>.github.io/pottery-log/`.
