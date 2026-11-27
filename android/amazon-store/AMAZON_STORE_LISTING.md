# Amazon Appstore Submission Guide — Triboon (Fire TV & Fire OS)

Triboon builds a dedicated, lightweight **Amazon Appstore APK** (`app.triboon.tv`) using the `amazonRelease` build type. It runs natively on **Fire TV Stick, Fire TV Cube, Fire TV Smart TVs, and Fire Tablets** with full hardware-accelerated **Media3 / ExoPlayer** playback, zero Google Play Services dependencies, and zero sideload self-update permissions.

## What `amazonRelease` Changes Automatically for Amazon Appstore Compliance
- Strips `android.permission.REQUEST_INSTALL_PACKAGES` and `FileProvider` (`.updateprovider`) from the merged manifest (`android/app/src/amazonRelease/AndroidManifest.xml`).
- Strips Google Cast manifest metadata (`com.google.android.gms.cast.framework.OPTIONS_PROVIDER_CLASS_NAME`) and disables Google Cast at runtime so Fire OS devices without Google Play Services never initialize GMS.
- Sets `BuildConfig.AMAZON_DISTRIBUTION = true`, exposing `"distribution": "amazon"` to `web/index.html`.
- Suppresses GitHub `.apk` download buttons and routes updates through the Amazon Appstore (`amzn://apps/android?p=app.triboon.tv`).
- Keeps `android.software.leanback` (`required="false"`), `android.hardware.touchscreen` (`required="false"`), `LEANBACK_LAUNCHER`, `LAUNCHER`, and full Fire TV remote D-pad / Back / Media button navigation.

---

## Amazon Developer Console Listing Copy (Ready to Paste)

- **App title**: `Triboon`
- **Category**: `Movies & TV` (or `Utilities`)
- **Short description**:
  `Connect to your self-hosted Triboon media server on Fire TV and Fire OS.`
- **Long description**:
  ```text
  Triboon is the official client app for connecting to your own self-hosted Triboon media server on Amazon Fire TV and Fire OS devices.

  IMPORTANT: Triboon is a player/client for your own personal media server. It does not provide, host, or include any media, movies, shows, or live channels. You must run your own Triboon server and connect using your server address.

  Key Features:
  • Designed for the Fire TV remote with instant D-pad spatial navigation and Quick Connect 6-digit QR/code sign-in
  • Hardware-accelerated native Media3 / ExoPlayer playback for your personal movies, shows, and live TV libraries
  • Adaptive direct play, remux, and transcoding matched to your Fire TV hardware
  • Multi-profile support with watch history and resume sync across all your screens
  • Subtitles, audio track selection, and Picture-in-Picture support
  • Zero ads, zero tracking, and zero third-party analytics — connects directly to your server
  ```
- **Product feature bullets**:
  - Fast hardware-accelerated Media3 / ExoPlayer playback on Fire TV
  - Native Fire TV remote navigation and 6-digit Quick Connect sign-in
  - Personal movie, TV show, and live media server support with resume sync
  - Subtitles, audio tracks, and multi-profile family support
  - Zero ads or tracking — connects directly to your own Triboon server
- **Privacy Policy URL**: `https://github.com/d1same/triboon/blob/main/PRIVACY.md`
- **Included Graphic Assets** (`android/amazon-store/`):
  - Large app icon (512×512 PNG): `android/amazon-store/icon-512.png`
  - Small app icon (114×114 PNG): `android/amazon-store/icon-114.png`
  - Fire TV background image (1920×1080 PNG): `android/amazon-store/firetv-background-1920x1080.png`
  - Promotional banner (1024×500 PNG): `android/amazon-store/promo-1024x500.png`

---

## Submitting & Pushing to Amazon Appstore (\$0 Free Developer Account)

1. Sign in at **https://developer.amazon.com/apps-and-games/console** (registration is free).
2. Click **Add a New App → Android**, fill in the copy & assets above, and select **Fire TV** (plus Fire Tablets if desired) under **Device Support**.
3. Upload `triboon-amazon-vX.Y.Z.apk` from the `Amazon Fire TV APK` GitHub Actions workflow.
4. In **Testing Instructions**, provide Amazon reviewers a temporary read-only HTTPS demo Triboon server URL + test login with 2–3 open-source videos (*Big Buck Bunny*, *Sintel*) so they can verify Fire TV remote navigation and playback.
5. **Automated CI Push (Optional):** Once your app ID exists in Amazon Developer Console, add an **App Submission API** Security Profile (`AMAZON_CLIENT_ID`, `AMAZON_CLIENT_SECRET`, `AMAZON_APP_ID` secrets in the `release` environment) to automate draft uploads from `.github/workflows/amazon.yml`.

> Note: Amazon Appstore reviews typically take 1–3 business days. For instant family testing before approval, **Live App Testing (LAT)** delivers updates to invited Amazon accounts directly through the Fire TV Appstore in minutes.

---

## Building Locally

```powershell
$env:TRIBOON_RELEASE_STORE_FILE="C:\path\to\triboon-release.jks"
$env:TRIBOON_RELEASE_STORE_PASSWORD="..."
$env:TRIBOON_RELEASE_KEY_ALIAS="..."
$env:TRIBOON_RELEASE_KEY_PASSWORD="..."
.\android\gradlew.bat -p android assembleAmazonRelease --console=plain
# Output: android\app\build\outputs\apk\amazonRelease\app-amazonRelease.apk
```
