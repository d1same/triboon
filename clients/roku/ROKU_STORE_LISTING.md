# Roku Channel Store Submission Guide — Triboon

Triboon for Roku (`clients/roku/`) is a **100% native BrightScript + SceneGraph** channel (zero WebViews) designed for instant 60 fps responsiveness even on entry-level Roku Express devices.

## Performance & Roku Certification Built In
- **Non-blocking network architecture:** All HTTP/JSON calls run inside background `TriboonApiTask` threads (`roUrlTransfer` + `common:/certs/ca-bundle.crt`), keeping the SceneGraph render thread smooth at 60 fps.
- **Virtualized `RowList` browsing:** Continue Watching, Trending, Movies, TV Shows, Local Libraries, Live TV, and Search reuse native `PosterItem` nodes with low memory footprint.
- **Roku-native playback (`Video` node):** Sends accurate Roku `caps` (`mkv: false, mp4: true, h264: true, hevc: true, aac: true, ac3: true, eac3: true, dts: false, hls: true`) so Triboon serves direct MP4 or hardware-friendly HLS automatically, with 15-second watch-progress sync and Live TV fallback switching.
- **Certification beacon:** Emits `AppLaunchComplete` immediately when the first view renders.
- **Persistent auth:** Saves server URL, Bearer token, and active profile in `roRegistrySection("TriboonAuth")`.

---

## Roku Developer Dashboard Listing Copy (Free Developer Account)

- **Channel Name**: `Triboon`
- **Category**: `Movies & TV` (or `Personal Media`)
- **Short Description**:
  `Connect to your self-hosted Triboon media server on Roku TV and streaming players.`
- **Full Description**:
  ```text
  Triboon is the official Roku channel for connecting to your own self-hosted Triboon media server.

  IMPORTANT: Triboon is a player/client for your own personal media server. It does not provide, host, or include any media, movies, shows, or live channels. You must run your own Triboon server and connect using your server address.

  Key Features:
  • 100% native Roku interface with fast 6-digit Quick Connect sign-in
  • Continue Watching, Movies, TV Shows, Local Libraries, Live TV, and Search
  • Adaptive direct MP4 and HLS playback matched to your Roku hardware
  • Multi-profile support with automatic watch history and resume sync
  • Zero ads and zero tracking — connects directly to your own server
  ```
- **Privacy Policy URL**: `https://github.com/d1same/triboon/blob/main/PRIVACY.md`
- **Included Channel Artwork** (`clients/roku/images/`):
  - Store Poster HD (540×405 PNG): `clients/roku/images/icon-store-540x405.png`
  - Channel Focus Icon HD (290×218 PNG): `clients/roku/images/icon-focus-hd.png`
  - Channel Focus Icon SD (214×144 PNG): `clients/roku/images/icon-focus-sd.png`
  - Splash Screen FHD (1920×1080 PNG): `clients/roku/images/splash-fhd.png`
  - Splash Screen HD (1280×720 PNG): `clients/roku/images/splash-hd.png`
  - Splash Screen SD (720×480 PNG): `clients/roku/images/splash-sd.png`

---

## Pushing & Installing (Free Roku Developer Account)

### Option A — Instant Sideload on Your Own Roku (10 seconds)
1. Enable Developer Mode on your Roku (Home ×3, Up ×2, Right, Left, Right, Left, Right).
2. Download `Triboon-Roku-vX.Y.Z.zip` from the `Roku Channel Package` GitHub Actions workflow.
3. Open `http://<roku-ip>` in your browser, log in with `rokudev`, and upload the `.zip`.

### Option B — Roku Channel Store & Beta Channel Link (Free)
1. Register a free developer account at **https://developer.roku.com**.
2. Sign the `.zip` into a `.pkg` using your Roku device's Packager utility (or `roku-deploy` with your signing password).
3. Upload the `.pkg` to **Developer Dashboard → Manage My Channels → Add Channel**:
   - **Beta Channel (Instant, up to 20 testers, no store review):** Share the install link immediately with friends & family.
   - **Public Channel (Roku Channel Store):** Provide Roku certification reviewers a temporary read-only HTTPS demo Triboon server URL + test login with 2–3 open-source videos (*Big Buck Bunny*, *Sintel*).
   - **Automated CI Push:** Roku's official **Developer API** supports automated uploads of signed `.pkg` builds straight from GitHub Actions once your Channel ID and API key are configured.
