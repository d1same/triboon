# Samsung Smart TV (Tizen) Submission Guide — Triboon

Triboon for Samsung Smart TVs (`appTriboon.Triboon`, Tizen 5.0+ / 2019–2026 Samsung TVs) is an ultra-lightweight (~60 KB, zero-framework) native **Tizen Web App** (`.wgt`). It boots into a Quiet Graphite Connect screen, verifies your server with `/api/server`, and launches Triboon's full TV couch UI (`body.tv`) with full **Samsung Smart Remote + Return (`10009`) + Media & Channel key** integration.

## Samsung TV Seller Office Compliance Built In
- **Full modern Triboon UI**: Runs natively in Samsung TV's Chromium engine — full Persian & international fonts, smooth 4K hardware `<video>`, and adaptive remux/HLS.
- **Honest Samsung TV audio caps**: Reports `dts: false` in `clientCaps()` on Tizen (Samsung dropped native DTS decoding starting with 2018 TVs) so DTS movies automatically remux cleanly to supported audio.
- **Hardware Return compliance**: Routes Samsung Return (`keyCode === 10009`) through `window.__tvBack()` and calls `tizen.application.getCurrentApplication().exit()` cleanly at root.
- **Remote transport keys**: Registers `MediaPlay`, `MediaPause`, `MediaPlayPause`, `MediaStop`, `MediaFastForward`, `MediaRewind`, `ChannelUp`, and `ChannelDown` via `tizen.tvinputdevice`.
- **Store update policy**: Suppresses off-store APK/EXE update prompts (`tizenTv` managed store).

---

## Samsung Apps TV Seller Office Copy (`https://seller.samsungapps.com/tv`)

- **App Name**: `Triboon`
- **Package ID**: `appTriboon.Triboon`
- **Category**: `Video` / `Entertainment`
- **Short Description**:
  `Connect to your self-hosted Triboon media server on Samsung Smart TVs.`
- **Full Description**:
  ```text
  Triboon is the official client for connecting to your own self-hosted Triboon media server on Samsung Smart TVs (Tizen).

  IMPORTANT: Triboon is a player/client for your own personal media server. It does not provide, host, or include any media, movies, shows, or live channels. You must run your own Triboon server and connect using your server address.

  Key Features:
  • Built for the Samsung Smart Remote with instant 6-digit Quick Connect sign-in
  • Fast, modern 1080p/4K TV interface with Continue Watching, Movies, TV Shows, Local Libraries, and Live TV
  • Adaptive direct play and server-side remuxing/transcoding tailored to Samsung Smart TVs
  • Multi-profile family support with watch progress sync across all your devices
  • Zero ads and zero tracking — connects directly to your own server
  ```
- **Privacy Policy URL**: `https://github.com/d1same/triboon/blob/main/PRIVACY.md`
- **Terms of Use URL**: `https://github.com/d1same/triboon/blob/main/TERMS.md`
- **Demo Reviewer Server** (open-source Blender Open Movies):
  - URL: `https://triboon-demo-production.up.railway.app`
  - Account: `reviewer@triboon.tv` / `TriboonDemo2026!`
- **Included Assets** (`clients/tizen/`):
  - App Icon (`512×512` PNG): `clients/tizen/icon-512.png`
  - Splash (`1920×1080` PNG): `clients/tizen/splash-1920x1080.png`

---

## Publishing or Sideloading
1. **Official Samsung Apps TV Store (Free)**: Sign in to **https://seller.samsungapps.com/tv** (Samsung Apps TV Seller Office), create a new TV App, sign the `.wgt` with your Samsung distributor/author certificate in Tizen Studio (or `tizen package -t wgt`), upload `.wgt` + `icon-512.png` + 1920×1080 copyright-free screenshots, and provide the demo reviewer server above.
2. **Instant Sideload on your own Samsung TV**: Enable Developer Mode in Samsung Apps (`12345` on the remote), enter your PC's IP, and install `Triboon-Samsung-Tizen-v<ver>.wgt` via Tizen Studio or `tizen install`.
