# Triboon App Update Contract

Triboon ships one universal APK for Android TV, phones, and tablets - the same
binary adapts at runtime. Stable GitHub release asset names let every device
update from the same URL every time.

## Stable Download Link

These links must always point at the newest published Android APK, Windows
server installer, and Windows desktop client:

```text
https://github.com/d1same/triboon/releases/latest/download/triboon.apk
https://github.com/d1same/triboon/releases/latest/download/Triboon-Windows-Server.exe
https://github.com/d1same/triboon/releases/latest/download/Triboon-Windows-Client.exe
```

Use the APK link in the Android in-app update button and Downloader shortcuts.
The two Windows links intentionally distinguish the self-hosted server from the
desktop viewing client. The client installer is unsigned until the owner adds a
protected Windows code-signing identity; an unsigned build may trigger
SmartScreen and must not be described as signed.

## Release Asset Names

Every GitHub release must include this exact binary asset set plus its checksum
manifest:

```text
triboon-vX.Y.Z.apk
triboon.apk
Triboon-Windows-Server-vX.Y.Z.exe
Triboon-Windows-Server.exe
Triboon-Windows-Client-vX.Y.Z.exe
Triboon-Windows-Client.exe
SHA256SUMS.txt
```

Versioned files preserve history. Stable aliases power fixed download links.
Each stable/versioned pair must be byte-identical. The final publisher rejects
missing, extra, or mismatched binary assets before it creates the checksum and
publishes the release.

(The legacy `triboon-tv.apk` / `triboon-mobile.apk` names were retired in the
v1.7.67 -> v1.7.68 migration once every installed device ran a build whose
in-app updater accepts `triboon.apk`.)

## Immutable Publishing Pipeline

GitHub Actions is the normal publisher. A `vX.Y.Z` tag release proceeds only
when all of these conditions hold:

- the tag exactly matches `package.json` and Android `versionName`;
- the tag commit is the current `origin/main` commit;
- the Node suite and Android `lintDebug testDebugUnitTest assembleDebug` pass;
- the release APK embeds the expected version and matches the pinned release
  signing-certificate SHA-256 digest;
- the Windows server installer uses the content-locked dependency manifest and
  verified Inno Setup compiler;
- the Windows client compiles with the MSVC Rust target against the
  checksum-locked LGPL libmpv bundle, passes its native/static contracts, and
  packages `libmpv-2.dll`, Triboon's license, notices, the verbatim LGPL
  license, source/rebuild instructions, and a generated inventory of the locked
  Rust dependency licenses;
- the semver Docker image waits for all three native release artifacts;
- one final job downloads the immutable artifacts, checks the exact whitelist
  and byte-identical aliases, writes `SHA256SUMS.txt`, creates a draft, and
  publishes it once. Release jobs never use `--clobber` and never expose a
  partial release.

Main-branch pushes publish container `latest` and commit-SHA tags after Node,
Android, and Windows-client compile gates. Pull requests also compile the native
Windows client. Release tags publish the semver container only after APK,
Windows server, and Windows client artifacts pass.

At the instant a release is published, `latest`, the immutable semver image,
the native assets, and the Git tag all resolve to that release commit. Later
tested pushes to `main` intentionally advance `latest` and its SHA tag without
moving the immutable semver image or existing APK/Windows release assets. Pin
`X.Y.Z` when byte-for-byte release immutability matters.

## Container And Unraid Publication Contract

The public package is
`https://github.com/d1same/triboon/pkgs/container/triboon`, and users pull it as
`ghcr.io/d1same/triboon:<tag>`. Main owns `latest` plus `sha-<commit>`; a release
tag owns immutable `X.Y.Z`.

A successful Docker publishing job is necessary but is not proof that Unraid
can install the image. Before calling a release complete:

- verify `latest` and `X.Y.Z` from an anonymous registry session with no stored
  GHCR credentials;
- confirm both manifest indexes contain `linux/amd64` and `linux/arm64` images
  (extra BuildKit provenance/attestation manifests are allowed);
- run the public `X.Y.Z` image in isolation with a fresh empty data volume and a
  loopback-only host port, wait for its health check, and confirm
  `GET /api/server` reports `X.Y.Z`;
- for a release cut, confirm `latest` is anonymously pullable and still
  represents the tagged commit at publication time; after later main pushes,
  confirm it represents the tested current main commit instead.

The published image is an application artifact, never a backup. Its layers and
metadata must not contain `data/`, `.env` files, provider credentials, imported
Music cookies, Android signing material, local logs/databases, or CI secrets.
Those values enter only at runtime through the mounted data folder, the
dashboard, or explicitly configured runtime environment variables. The
isolated public-image smoke must use disposable data and must not copy a real
owner's state into the container.

## Android Update Rules

The APK filename does not decide whether Android accepts an update. Android
updates only when all of these are true:

- The package id is the same.
- The APK is signed with the same signing key.
- The new Android `versionCode` is higher than the installed one.

The signing certificate is part of the update chain. Before publishing the APK,
compare the new APK certificate against the current stable APK certificate from
`/releases/latest/download/triboon.apk`. If the certificate changes, Android
will treat the APK as a different signing lineage and the normal update will
fail. Do not publish a replacement stable APK alias until the certificate match
and higher `versionCode` are confirmed.

For every public release, bump these together:

- `package.json` version.
- Android `versionName`.
- Android `versionCode`.
- Git tag `vX.Y.Z`.

The public release is not complete until all update surfaces are current:

- GitHub `main` has the version bump and release fixes.
- Git tag `vX.Y.Z` points at the same commit.
- At publication time, GitHub Actions has published the Unraid/container image
  for `latest` and the semver tag, and both pass the anonymous multi-platform
  checks above. Later tested main pushes may advance only `latest` as described
  in the channel contract.
- The GitHub release has both APK names, both Windows server names, both Windows
  client names, and `SHA256SUMS.txt`; no preview/native-test artifact is
  attached.

## In-App Update Behavior

The app update button should open only the stable GitHub latest-download link.
Do not point the app at a versioned APK URL, because then every release would
require a new in-app link or Downloader shortcode.

The Android shell pins that link to the official `d1same/triboon` repository.
Before it opens Package Installer, it parses the downloaded APK and requires
package `app.triboon.tv`, the pinned production signing-certificate SHA-256,
and a `versionCode` higher than the installed app. A failed download or any
identity/signature/version mismatch is deleted and never handed to the system
installer.

Android will still show the normal install/update confirmation screen. Triboon
must not attempt silent installs.

## Local Release Fallback

`npm run release:apk` always requires the dedicated release keystore and stages
the two APK names by default. It never creates a debug-signed release, and it
uses the installed Android SDK `apksigner` and `aapt` to reject an APK whose
embedded `versionName` differs from `package.json` or whose certificate differs
from the production SHA-256 fingerprint pinned in CI. These checks run before
anything is copied into `dist`. Optional `-Publish` may create a new draft for
an already-pushed, verified tag, but that APK-only draft is not a complete
Triboon release: it must remain a draft until the locked Windows server
artifacts, checksum, and container publication have also passed. The fallback
refuses dirty worktrees, non-main tag commits, a missing successful `main` push
workflow for the exact commit, existing releases, and asset overwrites.

## Release Checklist

Before calling a release done:

- Run the full test suite and the focused smoke checks needed for the changed
  area.
- Run `node --test test/release-contract.test.js` and confirm `npm.cmd test`'s
  explicit suite list exactly matches every checked-in `test/*.test.js` file
  while excluding fixture generators.
- Pass Android lint, native JVM unit tests, debug build, and the required
  emulator/device stress smoke before the release build.
- Build or let GitHub Actions publish the Unraid/container image. Its
  credential-free verification job must confirm the applicable tag is
  anonymously pullable, exposes both `linux/amd64` and `linux/arm64`, carries
  the expected source revision label, reaches healthy, and reports the expected
  version from `/api/server`.
- Build the universal Android APK from the same version and same commit as the
  server/container release.
- Build the Windows server installer from `dependencies.lock.json` with the
  verified Inno compiler from the same tag commit.
- Build the Windows client with the normal MSVC/libmpv CI job from the same tag
  commit. Run the shared `clients/windows-px8/scripts/build-package.ps1` recipe
  and confirm its extracted-payload check finds `libmpv-2.dll`, `LICENSE`, the
  third-party notice, `LIBMPV-LICENSE.LGPL`, `LIBMPV-SOURCE.md`, and
  `RUST-DEPENDENCIES.md`; run the local hardware/live matrix in `VERIFY.md`.
- Confirm the APK `versionName` matches `X.Y.Z` and `versionCode` is higher
  than the prior release.
- Confirm the APK signing certificate matches the current stable APK signing
  certificate.
- Confirm stable/versioned APK, Windows server, and Windows client pairs are
  byte-identical, the asset whitelist has no preview artifact, and
  `SHA256SUMS.txt` covers all six binaries.
- Confirm all three stable URLs download the newest APK, Windows server, and
  Windows client installers; verify the APK version/certificate and every file
  against `SHA256SUMS.txt`.
- Confirm Android accepts the update over the prior installed build when a
  device/emulator is available.
- Require the public semver verification job to start that anonymously pulled
  image against fresh disposable data on a loopback-only port, wait for
  healthy, and confirm `/api/server` reports the release version before the
  final publisher marks the release latest.
- Confirm the public image contains no runtime data, credentials, signing
  material, or CI secrets.
- Keep secrets, local `data/`, logs, databases, and old scratch APKs out of git.

Never tag a public release, mark a release as latest, or tell users to update
Unraid/Android/Windows until, at the publication moment, the code, anonymously
pullable multi-platform container tags, isolated public-image smoke, APK pair,
Windows server pair, Windows client pair, checksum, and Git tag all point to the
same version and commit. Subsequent tested main pushes may advance the mutable
`latest` channel; they must never move the release's immutable semver tag or
native assets.
