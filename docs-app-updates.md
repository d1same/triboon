# Triboon App Update Contract

Triboon ships one universal APK for Android TV, phones, and tablets - the same
binary adapts at runtime. Stable GitHub release asset names let every device
update from the same URL every time.

## Stable Download Link

This link must always point at the newest published APK:

```text
https://github.com/d1same/triboon/releases/latest/download/triboon.apk
```

Use this exact link in the in-app update button, Downloader shortcuts, public
README copy, and support instructions.

## Release Asset Names

Every GitHub release must include the versioned APK and the stable alias:

```text
triboon-vX.Y.Z.apk
triboon.apk
```

The versioned file preserves history. The stable alias file powers the in-app
update button and the fixed Downloader URL. The stable alias must be attached to
the latest release so `/releases/latest/download/triboon.apk` always resolves to
the newest build.

(The legacy `triboon-tv.apk` / `triboon-mobile.apk` names were retired in the
v1.7.67 -> v1.7.68 migration once every installed device ran a build whose
in-app updater accepts `triboon.apk`.)

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
- The GitHub release has the versioned APK and the stable APK alias.

## In-App Update Behavior

The app update button should open only the stable GitHub latest-download link.
Do not point the app at a versioned APK URL, because then every release would
require a new in-app link or Downloader shortcode.

Android will still show the normal install/update confirmation screen. Triboon
must not attempt silent installs.

## Release Checklist

Before calling a release done:

- Run the full test suite and the focused smoke checks needed for the changed
  area.
- Build or let GitHub Actions publish the Unraid/container image, then confirm
  the workflow succeeded.
- Build the universal Android APK from the same version and same commit as the
  server/container release.
- Confirm the APK `versionName` matches `X.Y.Z` and `versionCode` is higher
  than the prior release.
- Confirm the APK signing certificate matches the current stable APK signing
  certificate.
- Attach the versioned APK and the stable alias to the GitHub release.
- Confirm the stable URL downloads the newest APK, and verify the downloaded
  file still has the expected version and certificate.
- Confirm Android accepts the update over the prior installed build when a
  device/emulator is available.
- Keep secrets, local `data/`, logs, databases, and old scratch APKs out of git.

Never tag a public release, mark a release as latest, or tell users to update
Unraid/Android until the code, container image, versioned APK, and stable APK
alias all point to the same version.
