# Triboon App Update Contract

Triboon uses stable GitHub release asset names so Android TV and Android mobile
users can update from the same URL every time.

## Stable Download Links

These links must always point at the newest published APKs:

```text
https://github.com/d1same/triboon/releases/latest/download/triboon-tv.apk
https://github.com/d1same/triboon/releases/latest/download/triboon-mobile.apk
```

Use these exact links in the in-app update buttons, Downloader shortcuts, public
README copy, and support instructions.

## Release Asset Names

Every GitHub release must include both versioned APKs and stable aliases:

```text
triboon-tv-vX.Y.Z.apk
triboon-mobile-vX.Y.Z.apk
triboon-tv.apk
triboon-mobile.apk
```

The versioned files preserve history. The stable alias files power the in-app
update buttons and fixed Downloader URLs.

## Android Update Rules

The APK filename does not decide whether Android accepts an update. Android
updates only when all of these are true:

- The package id is the same.
- The APK is signed with the same signing key.
- The new Android `versionCode` is higher than the installed one.

The signing certificate is part of the update chain. Before publishing APKs,
compare the new APK certificate against the current stable APK certificate from
`/releases/latest/download/triboon-tv.apk` or
`/releases/latest/download/triboon-mobile.apk`. If the certificate changes,
Android will treat the APK as a different signing lineage and the normal update
will fail. Do not publish replacement stable APK aliases until the certificate
match and higher `versionCode` are confirmed.

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
- The GitHub release has the two versioned APKs and the two stable APK aliases.

## In-App Update Behavior

The app update buttons should open only these stable GitHub latest-download
links. Do not point the app at versioned APK URLs, because then every release
would require a new in-app link or Downloader shortcode.

Android will still show the normal install/update confirmation screen. Triboon
must not attempt silent installs.

## Release Checklist

Before calling a release done:

- Run the full test suite and the focused smoke checks needed for the changed
  area.
- Build or let GitHub Actions publish the Unraid/container image, then confirm
  the workflow succeeded.
- Build Android TV and mobile APK assets from the same version and same commit
  as the server/container release.
- Confirm the APK `versionName` matches `X.Y.Z` and `versionCode` is higher
  than the prior release.
- Confirm the APK signing certificate matches the current stable APK signing
  certificate.
- Attach all four APK assets listed above to the GitHub release.
- Confirm both stable URLs download the newest APKs, and verify the downloaded
  files still have the expected version and certificate.
- Confirm Android accepts the update over the prior installed build when a
  device/emulator is available.
- Keep secrets, local `data/`, logs, databases, and old scratch APKs out of git.

Never tag a public release, mark a release as latest, or tell users to update
Unraid/Android until the code, container image, versioned APKs, and stable APK
aliases all point to the same version.
