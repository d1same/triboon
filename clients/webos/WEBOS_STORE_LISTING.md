# LG webOS Submission Guide — Triboon (LG Content Store & Homebrew Channel)

Triboon for LG Smart TVs (`app.triboon.webos`) is an ultra-lightweight (~50 KB, zero-framework) native **webOS** app package (`.ipk`). It boots directly into a Quiet Graphite Connect screen, verifies your server with `/api/server`, and opens your Triboon server in TV couch mode (`body.tv`) with full **LG Magic Remote + IR D-pad + Back (`461`) + Media transport key** integration.

## Performance & LG Content Store Compliance Built In
- **Zero framework overhead:** Pure HTML/CSS/JS shell (~50 KB), `1920x1080` UI plane, hardware 4K video decoding via LG's native `<video>` pipeline + Triboon's adaptive remux/HLS.
- **Honest webOS audio capabilities:** Disables `dts` in `clientCaps()` on webOS so movies with DTS tracks automatically remux cleanly to supported audio instead of playing silently on newer LG TVs.
- **Hardware Back compliance:** Sets `"disableBackHistoryAPI": true` in `appinfo.json` and routes LG Back (`keyCode === 461`) through `window.__tvBack()`, calling `webOS.platformBack()` cleanly at root.
- **Offline/unreachable recovery:** Probes `/api/server` with a 5-second timeout before redirecting so the TV never hangs on a black screen if the home server is offline.
- **Store update policy:** Suppresses off-store APK/EXE download prompts in Settings (`distribution: webos`) and directs updates through the LG Content Store.

---

## LG Seller Lounge Listing Copy (Free Developer Account)

- **App ID**: `app.triboon.webos`
- **App Name**: `Triboon`
- **Category**: `Entertainment`
- **Short Description**:
  `Connect to your self-hosted Triboon media server on LG Smart TVs.`
- **Full Description**:
  ```text
  Triboon is the official client for connecting to your own self-hosted Triboon media server on LG webOS Smart TVs.

  IMPORTANT: Triboon is a player/client for your own personal media server. It does not provide, host, or include any media, movies, shows, or live channels. You must run your own Triboon server and connect using your server address.

  Key Features:
  • Built for the LG Magic Remote and directional pad with instant 6-digit Quick Connect sign-in
  • Fast, lightweight TV interface with Continue Watching, Movies, TV Shows, Local Libraries, and Live TV
  • Adaptive direct play and server-side remuxing/transcoding tailored to LG webOS playback
  • Multi-profile family support with watch progress sync across all your devices
  • Zero ads and zero tracking — connects directly to your own server
  ```
- **Privacy Policy URL**: `https://github.com/d1same/triboon/blob/main/PRIVACY.md`
- **Included Graphic Assets** (`clients/webos/`):
  - App Icon (80×80 PNG): `clients/webos/icon-80.png`
  - Large App Icon (130×130 PNG): `clients/webos/icon-130.png`
  - Splash / Background (1920×1080 PNG): `clients/webos/splash-1920x1080.png`
  - Store Icon (400×400 PNG): `clients/webos/store-icon-400.png`

---

## Two Easy Ways to Push & Install

### Option A — Official LG Content Store (Free)
1. Register a free developer account at **https://seller.lgappstv.com** (LG Seller Lounge).
2. Download `app.triboon.webos_<version>_all.ipk` from the `LG webOS IPK` GitHub Actions workflow.
3. Create a new webOS TV App in Seller Lounge, upload the `.ipk`, select webOS 5.0+ (or 4.0+), attach `store-icon-400.png` + 2–4 clean 1920×1080 screenshots (using open-source media like *Big Buck Bunny* / *Sintel*), and provide a temporary read-only HTTPS demo Triboon server + login for LG QA reviewers.

### Option B — Instant Install via webOS Dev Manager / Homebrew Channel
1. Enable Developer Mode on your LG TV (or install **webOS Homebrew Channel**).
2. Install the `.ipk` in one click via **webOS Dev Manager** (`ares-install app.triboon.webos_<version>_all.ipk`).
3. The CI workflow also generates `triboon-webos-manifest.json` compatible with Homebrew Channel custom repositories.
