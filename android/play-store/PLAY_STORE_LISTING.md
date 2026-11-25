# Google Play Store Submission Guide — Triboon (Phone, Tablet & Android TV)

Triboon builds a **single universal Android App Bundle (`.aab`)** (`app.triboon.tv`) using the `playRelease` build type. It adapts automatically at runtime across **Phones, Tablets, and Android TV / Google TV**, while keeping the GitHub Releases sideload APK (`release` build type) completely untouched.

## What `playRelease` Changes Automatically for Google Play Compliance
- Strips `android.permission.REQUEST_INSTALL_PACKAGES` and `FileProvider` (`.updateprovider`) from the merged manifest (`android/app/src/playRelease/AndroidManifest.xml`).
- Sets `BuildConfig.PLAY_DISTRIBUTION = true`, exposing `"distribution": "play"` to the web UI.
- Suppresses the GitHub `.apk` in-app update modal and hides direct `.apk` download buttons in Settings, directing updates through Google Play.
- Declares `android.software.leanback` (`required="false"`), `android.hardware.touchscreen` (`required="false"`), `LAUNCHER`, `LEANBACK_LAUNCHER`, `resizeableActivity="true"`, `supportsPictureInPicture="true"`, and `targetSdk = 36`.

---

## Play Store Listing Copy (Ready to Paste)

- **App name**: `Triboon`
- **Short description** (max 80 chars — 74 chars):
  `Connect to your self-hosted Triboon media server on Phone, Tablet, and TV.`
- **Full description**:
  ```text
  Triboon is the official client app for connecting to your own self-hosted Triboon media server across Android Phones, Tablets, and Android TV / Google TV.

  IMPORTANT: Triboon is a player/client for your own personal media server. It does not provide, host, or include any media, movies, shows, or live channels. You must run your own Triboon server and connect using your server address.

  Key Features:
  • Universal experience across Android Phone, Tablet, and Android TV with native D-pad remote support and touch navigation
  • Hardware-accelerated native Media3 / ExoPlayer playback for your personal movie, show, and live media libraries
  • Adaptive direct play, remux, and transcoding tailored to your device capabilities
  • Multi-profile support with watch history and resume sync across devices
  • Google Cast sender support for casting from phone or tablet to TVs
  • Subtitles, audio track selection, Picture-in-Picture, and background audio playback
  • Zero ads, zero tracking, and zero third-party analytics — connects directly to your server
  ```
- **Category**: `Video Players & Editors` (or `Entertainment`)
- **Privacy Policy URL**: `https://github.com/d1same/triboon/blob/main/PRIVACY.md`
- **Included Graphic Assets** (`android/play-store/`):
  - App icon (512×512 PNG): `android/play-store/icon-512.png`
  - Feature graphic (1024×500 PNG): `android/play-store/feature-graphic-1024x500.png`
  - Android TV banner (1280×720 PNG): `android/play-store/tv-banner-1280x720.png`

---

## Play Console Form-Factor & Policy Checklist

1. **Opt in to ALL 3 Form Factors** (Play Console → **Release → Setup → Advanced settings → Form factors**):
   - Default (Phones & Tablets — enabled automatically)
   - Click **+ Add form factor → Android TV** (upload `tv-banner-1280x720.png` + at least 2 Android TV 16:9 screenshots!)
   - Upload Phone screenshots (16:9 or 9:16), 7-inch & 10-inch Tablet screenshots, and Android TV 16:9 screenshots.
   - **Important for screenshots**: Use clean personal/open-source media (e.g. Blender Open Movies like *Big Buck Bunny*, *Sintel*, *Tears of Steel*) — avoid copyrighted commercial movie posters or live TV logos in store screenshots.
2. **App Access (Reviewer Login)**:
   - Play Console → **App content → App access** → select **"All or some functionality is restricted"**.
   - Provide Google reviewers with a temporary read-only demo server URL (HTTPS) + test username/password containing 2–3 public-domain/Creative Commons sample videos so both Mobile and Android TV reviewers can sign in, browse with D-pad/touch, and verify playback.
3. **Data Safety**:
   - Does your app collect or share any of the required user data types? → **No** (connects solely to the user's own self-hosted server; zero developer telemetry/ads).
4. **Permissions Declaration**:
   - `REQUEST_INSTALL_PACKAGES` is **NOT** in the `playRelease` `.aab` (verified automatically in CI).
   - `RECORD_AUDIO` is optional runtime-only for voice search.
   - `FOREGROUND_SERVICE_MEDIA_PLAYBACK` is declared for background Music playback with MediaSession notification controls.
5. **Release Rollout Order**:
   - **Step 1 — Internal Testing (Instant, up to 100 testers)**:
     Upload `triboon-play-vX.Y.Z.aab` under **Testing → Internal testing**, add your testers' Gmail addresses, and share the opt-in link. Available in minutes on Phone, Tablet, and Android TV!
   - **Step 2 — Closed Testing (Personal accounts only)**:
     If your Play Console account is a Personal account created after Nov 2023, opt in at least **12 testers for 14 continuous days** in Closed Testing before applying for Production. (Organization accounts skip this wait.)
   - **Step 3 — Production**:
     Promote the verified `.aab` to Production (Google reviews Phone/Tablet + Android TV separately; TV review typically takes 2–5 days).

---

## Building the Signed Play `.aab`

### Via GitHub Actions (Recommended)
Run **Actions → `Play Store AAB` → Run workflow** (uses the existing `release` environment signing secrets, verifies zero `REQUEST_INSTALL_PACKAGES` in the merged `.aab`, and uploads `triboon-play-vX.Y.Z.aab`).

### Locally
```powershell
$env:TRIBOON_RELEASE_STORE_FILE="C:\path\to\triboon-release.jks"
$env:TRIBOON_RELEASE_STORE_PASSWORD="..."
$env:TRIBOON_RELEASE_KEY_ALIAS="..."
$env:TRIBOON_RELEASE_KEY_PASSWORD="..."
.\android\gradlew.bat -p android bundlePlayRelease --console=plain
# Output: android\app\build\outputs\bundle\playRelease\app-playRelease.aab
```
