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

For every public release, bump these together:

- `package.json` version.
- Android `versionName`.
- Android `versionCode`.
- Git tag `vX.Y.Z`.

## In-App Update Behavior

The app update buttons should open only these stable GitHub latest-download
links. Do not point the app at versioned APK URLs, because then every release
would require a new in-app link or Downloader shortcode.

Android will still show the normal install/update confirmation screen. Triboon
must not attempt silent installs.

## Release Checklist

Before calling a release done:

- Build Android TV and mobile APKs from the same version.
- Attach all four APK assets listed above to the GitHub release.
- Confirm both stable URLs download the newest APKs.
- Confirm Android accepts the update over the prior installed build.
- Keep secrets, local `data/`, logs, databases, and old scratch APKs out of git.
