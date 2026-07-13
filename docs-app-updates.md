# Triboon App Update Contract

Triboon ships one universal APK for Android TV, phones, and tablets - the same
binary adapts at runtime. Stable GitHub release asset names let every device
update from the same URL every time.

## Stable Download Link

These links must always point at the newest published Android APK and Windows
server installer:

```text
https://github.com/d1same/triboon/releases/latest/download/triboon.apk
https://github.com/d1same/triboon/releases/latest/download/Triboon-Windows-Server.exe
```

Use the APK link in the in-app update button and Downloader shortcuts. Use the
Windows server link in public install/support instructions. A stable Windows
client link does not exist: the PX8/Tauri and libmpv clients are manual preview
artifacts until their native playback bridge is complete.

## Release Asset Names

Every GitHub release must include this exact binary asset set plus its checksum
manifest:

```text
triboon-vX.Y.Z.apk
triboon.apk
Triboon-Windows-Server-vX.Y.Z.exe
Triboon-Windows-Server.exe
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
- the semver Docker image waits for both native release artifacts;
- one final job downloads the immutable artifacts, checks the exact whitelist
  and byte-identical aliases, writes `SHA256SUMS.txt`, creates a draft, and
  publishes it once. Release jobs never use `--clobber` and never expose a
  partial release.

Main-branch pushes publish container `latest` and commit-SHA tags after Node and
Android gates. Release tags publish the semver container only after APK and
Windows server artifacts pass.

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
- GitHub Actions has published the Unraid/container image for `latest` and the
  semver tag.
- The GitHub release has both APK names, both Windows server names, and
  `SHA256SUMS.txt`; no Windows client preview is attached.

## In-App Update Behavior

The app update button should open only the stable GitHub latest-download link.
Do not point the app at a versioned APK URL, because then every release would
require a new in-app link or Downloader shortcode.

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
- Build or let GitHub Actions publish the Unraid/container image, then confirm
  the workflow succeeded.
- Build the universal Android APK from the same version and same commit as the
  server/container release.
- Build the Windows server installer from `dependencies.lock.json` with the
  verified Inno compiler from the same tag commit.
- Confirm the APK `versionName` matches `X.Y.Z` and `versionCode` is higher
  than the prior release.
- Confirm the APK signing certificate matches the current stable APK signing
  certificate.
- Confirm stable/versioned APK and Windows server pairs are byte-identical, the
  asset whitelist has no Windows client preview, and `SHA256SUMS.txt` covers all
  four binaries.
- Confirm both stable URLs download the newest APK and Windows server installer;
  verify the APK version/certificate and both files against `SHA256SUMS.txt`.
- Confirm Android accepts the update over the prior installed build when a
  device/emulator is available.
- Confirm the semver container image published successfully before the final
  publisher marks the release latest.
- Keep secrets, local `data/`, logs, databases, and old scratch APKs out of git.

Never tag a public release, mark a release as latest, or tell users to update
Unraid/Android/Windows until the code, semver container image, APK pair, Windows
server pair, checksum, and Git tag all point to the same version and commit.
