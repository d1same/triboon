# Microsoft Store Submission Guide — Triboon Windows Client

Triboon Windows Client packages as a native x64 **MSIX** signed by Microsoft upon Partner Center submission — giving Windows 10 & Windows 11 users **zero SmartScreen warnings** and **automatic Store updates** for **\$0**.

## Reserved Product Identity (Partner Center)
- **Store ID**: `9N12LTV21B88`
- **Package/Identity/Name**: `Disame.Triboon`
- **Package/Identity/Publisher**: `CN=CC350014-1964-4C3C-BCF7-6D4262F0EC93`
- **PublisherDisplayName**: `Disame`
- **Package Family Name**: `Disame.Triboon_p0pp5m3mtarer`

## Microsoft Store Compliance Built In
- Runtime MSIX detection (`GetCurrentPackageFullName` in `clients/windows-px8/src-tauri/src/main.rs`) tags Store installs with `"distribution": "msstore"` while leaving GitHub `.exe` builds untouched.
- Suppresses off-Store `.exe` update popups/buttons in `web/index.html` and routes updates to `ms-windows-store://pdp/?ProductId=9N12LTV21B88` (Microsoft Store Policy 10.2.5).
- Packages `triboon-px8.exe`, checksum-verified LGPL `libmpv-2.dll`, `LICENSE`, `LIBMPV-LICENSE.LGPL`, `LIBMPV-SOURCE.md`, `THIRD-PARTY-NOTICES.md`, and `RUST-DEPENDENCIES.md`.

## Partner Center Submission Checklist
1. **Pricing and availability**:
   - Price: **Free**
   - Visibility: Choose **Private audience / Direct link only** (hidden from public search — ideal for friends & family) OR **Public**.
2. **Properties**:
   - Category: **Entertainment** (or **Multimedia design / Video**)
   - **Privacy Policy URL**: `https://github.com/d1same/triboon/blob/main/PRIVACY.md`
   - **System requirements**: Windows 10 version 2004 (19041) or higher, x64
   - **Restricted capability justification** (`runFullTrust`): *"Triboon is a desktop media client built with Tauri/WebView2 and native LGPL libmpv hardware video playback, packaged via Desktop Bridge (MSIX)."*
3. **Age ratings**:
   - Complete the 2-minute IARC questionnaire (Utility / Personal Media Player, no violence/gambling/ads/user-generated content → Everyone).
4. **Packages**:
   - Upload `Triboon-Windows-Store-vX.Y.Z.msix` (Microsoft signs it automatically — no local certificate needed!).
5. **Store listings (`English (United States)`)**:
   - **Description**: Same clean self-hosted media client copy as Google Play (explicitly noting it connects only to your own self-hosted Triboon server and hosts/provides no media).
   - **Screenshots**: Upload 1–4 clean 16:9 desktop screenshots (1920×1080) using open-source/personal media.
6. **Submission options → Notes for certification**:
   - Provide a temporary read-only HTTPS demo Triboon server URL + test login with 2–3 open-source videos (*Big Buck Bunny*, *Sintel*) so Microsoft certification reviewers can verify sign-in and video playback.
