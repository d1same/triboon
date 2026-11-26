# Triboon TestFlight & App Store Setup (iPhone, iPad & Apple TV — Zero Mac Needed)

Everything in `clients/apple/` compiles, signs (via Apple Cloud Signing), and uploads directly to **TestFlight** from GitHub Actions `macos-15`. You do **not** need a local Mac.

## Step 1 — Enroll in the Apple Developer Program ($99/year)
1. **Fastest approval method**: Download the official **Apple Developer** app on your iPhone, sign in with your Apple ID (with 2FA enabled), and enroll there — Apple often approves iPhone-app enrollments in minutes to 24 hours.
2. Or enroll on the web at https://developer.apple.com/programs/.
3. Note your 10-character **Team ID** from https://developer.apple.com/account → **Membership details**.

## Step 2 — Register Bundle IDs & Create App Records in App Store Connect
1. In **Apple Developer → Certificates, Identifiers & Profiles → Identifiers**, register:
   - `app.triboon.ios` (App ID for iPhone & iPad)
   - `app.triboon.appletv` (App ID for Apple TV)
2. In **App Store Connect** (https://appstoreconnect.apple.com) → **Apps → + New App**:
   - Create **Triboon** (iOS) with Bundle ID `app.triboon.ios`
   - Create **Triboon TV** (tvOS) with Bundle ID `app.triboon.appletv`
   *(Tip: If you ever want iPhone, iPad, and Apple TV under a single TestFlight link, point both targets to `app.triboon.ios` and click **+ Add tvOS** inside the single `Triboon` app record.)*

## Step 3 — Create One App Store Connect API Key (No `.p12` Cert Needed!)
1. In **App Store Connect → Users and Access → Integrations → App Store Connect API → Team Keys**, click **Generate API Key**.
2. Name: `Triboon GitHub CI`, Access: **App Manager** (or **Admin** so Xcode cloud-signing can auto-create distribution certificates the very first time).
3. Copy the **Issuer ID** (UUID at top of page) and the **Key ID** (10 chars), and download the one-time `AuthKey_XXXXXXXXXX.p8` file.
4. Base64-encode the `.p8` file in PowerShell (never commit it!):
   ```powershell
   [Convert]::ToBase64String([IO.File]::ReadAllBytes("C:\path\to\AuthKey_XXXXXXXXXX.p8")) | Set-Clipboard
   ```

## Step 4 — Add 4 Secrets to GitHub (`Settings → Environments → release`)
Add these 4 secrets to the existing **`release`** GitHub environment:
- `APPLE_TEAM_ID` — your 10-character Apple Team ID
- `ASC_KEY_ID` — the 10-character API Key ID
- `ASC_ISSUER_ID` — the Issuer ID UUID
- `ASC_API_KEY_P8_B64` — the base64-encoded `.p8` key from Step 3

## Step 5 — 1-Click Upload to TestFlight
1. Open **GitHub → Actions → `apple client` → Run workflow**.
2. Set **`upload_testflight`** = **`true`** and **`platform`** = **`both`** (or `ios` / `tvos`).
3. GitHub Actions `macos-15` runs `swift test`, compiles both apps, cloud-signs via Xcode 16 + your API key, and uploads directly to **App Store Connect → TestFlight**.
4. Both `Info.plist` files already include `ITSAppUsesNonExemptEncryption = false`, so builds clear Export Compliance automatically.
5. In **App Store Connect → TestFlight**:
   - **Internal Testing** (up to 100 team members): **Instant** (no review).
   - **External Testing** (up to 10,000 friends/family via a single public link): add a group, share the link, and pass one ~24-hour Beta App Review.

## App Store / Beta Review Tips (Same Clean Rules as Google Play)
- Position Triboon strictly as a **self-hosted personal media client** — no mention of Usenet/NZBs/indexers and no off-store download links.
- Privacy Policy URL: `https://github.com/d1same/triboon/blob/main/PRIVACY.md`
- For External TestFlight / App Store review, provide a clean temporary HTTPS demo server + read-only login containing 2–3 open-source sample videos (*Big Buck Bunny*, *Sintel*).
