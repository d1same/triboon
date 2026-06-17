# Triboon Release Audit Checklist

This is the A-to-Z checklist for keeping web and Android TV working as separate player surfaces. Web may use the web player. Android TV must route every movie, episode, local-library item, and live channel to native Media3/ExoPlayer, with no web-player fallback.

## Product Surface

- First run: owner setup, encrypted settings, provider/indexer/TMDB setup, and profile creation work from the web UI and Android shell.
- Auth: setup, login, invite, Quick Connect, profile switching, sign out, and expired-session recovery all show understandable next steps.
- Home: Continue Watching, library rows, live rows, calendar/discover/movie/show/music navigation, backdrop focus, watched/remove actions, and cover/backdrop refreshes remain stable.
- Search: exact title and year are used for playback search, including tricky titles and multi-word/spin-off cases.
- Details: Play, Resume, Start over, 1080p/4K preference, Sources, watchlist, watched, trailer, cast, recommendations, seasons, and episode cards all route to the correct target.
- Sources: source rows show clean title, quality, source type, size, score, selected state, and exact release playback. Manual source selection must resume from the latest saved position.
- Local library: local movies and matched TV episodes show playable detail pages, skip online source warmups when owned locally, play the next owned episode without "no sources yet," and open large attached folders without rendering every item at once.
- Music: playback starts in Music and stops when leaving the Music section.
- Music: stays on the web audio path for now; ExoPlayer is reserved for video/live playback unless Android TV later needs native audio-session/background behavior.
- Live TV: playlist cache, EPG cache, category scrolling, channel play, guide, PiP guide, back behavior, and channel retune all stay responsive. Category Up/Down stays in the category lane and Right is the only handoff into channel rows.
- Admin/settings: provider/indexer/library/user/quality-cap edits work in place and invalidate affected caches.

## Web Player

- Web playback uses the web video player only.
- Play opens a loading player immediately instead of freezing on the details page.
- Resume and Start over use the right timestamp behavior.
- 1080p/4K preference is sent to source selection before mounting.
- Manual source change plays the exact selected release and resumes at the latest saved position.
- Failed source advances to the next viable source quickly.
- Audio button is enabled only when alternate audio choices exist.
- CC button is enabled only when subtitle choices or sync controls are meaningful.
- HD button is enabled only when quality choices exist.
- Subtitle selection and subtitle sync update live without restarting the player.
- Player layout: guide left, rewind/play/forward/next centered, CC/audio/HD right, title left above seek, quality right above seek, back button top left, time top right.
- Single click toggles play/pause; double click toggles fullscreen without also pausing.
- Controls use the dark bottom shade and only the focused/hovered button changes visual state.

## Android TV Native Player

- Android TV never reveals or falls back to the web player for movies, episodes, local library, or live TV.
- Details Play/Resume/Start over show native loading immediately, then hand to ExoPlayer.
- Resume works across 1080p/4K and manual source changes for the same title/profile.
- 1080p/4K detail preference chooses the right release class before playback.
- Native source failure advances to the next release instead of closing playback.
- Native direct/remux/transcode ladder stays source-fit -> direct -> remux -> transcode.
- Native controls are D-pad reachable and smaller than web controls where needed.
- Native layout: guide left, playback controls centered, CC/audio/HD right, title left above seek, quality right above seek, time and finish time top right.
- Native CC/audio/HD buttons are disabled when no real choices exist.
- Native audio language changes use ExoPlayer track selection live.
- Native CC selection, online subtitle versions, and subtitle sync update the overlay live without rebuilding the player.
- Native guide/PiP keeps ExoPlayer alive over the guide surface and does not black-screen when switching player -> guide -> player -> guide.
- Native live playback recovers inside ExoPlayer from idle, buffering, ended, and not-playing states without falling back to the web player.
- Native movie/episode startup fails over through the existing native ladder if ExoPlayer sits idle or stuck before first frame.
- Live TV retune from guide preserves guide mode and swaps the native player without a web player flash.
- Back from native playback returns to the prior app surface cleanly.

## Security

- API routes remain deny-by-default and every endpoint is represented in the route coverage test.
- Stream URLs use signed stream-scope tokens bound to the mounted resource.
- Native live stream tokens are bound to the selected channel.
- Settings and credentials remain encrypted at rest.
- User roles enforce admin-only provider/indexer/user/settings changes.
- Rate limits protect auth, invite, Quick Connect, and other sensitive endpoints.
- CSP and static serving headers stay in place.
- No credentials or tokens are committed.
- WebView debugging is enabled only for debug APKs.
- Cleartext HTTP is still allowed because Triboon is self-hosted and many local servers are configured by LAN IP; production hardening should offer an HTTPS/local-cert path before narrowing this.

## Performance Targets

- Pressing Play should show loading immediately and reuse warmed search/mount data when available.
- Availability/source prefetch should run for online titles but skip owned local-library titles.
- Bounded health gate stays fast and background triage advances without blocking playback.
- Keep successful source/mount/watch-state data hot long enough for quick resume and source switches.
- For Android TV, prefer native direct play when the device reports codec support; avoid server remux/transcode unless needed.
- Live TV should serve cached playlist/EPG data immediately and refresh server-side on schedule.
- ExoPlayer should keep the TextureView-backed surface stable during guide/PiP transitions.
- Attached local libraries must not block first menu/home focus or rail rollover; home must not fetch full `/api/libraries/:id/items` payloads, rail previews auto-load only the first bounded local-folder page, and library grids request additional bounded pages through scroll/D-pad.

## Verification Log

- `npm.cmd test`: passed 138/138 on June 16, 2026 after the home startup focus/render coalescing fix.
- `node --test test/phase4.test.js`: passed 15/15 on June 16, 2026 after the home startup focus/render coalescing fix.
- Android build: `android/gradlew.bat assembleDebug` passed with Gradle 9.5.1 wrapper fallback on June 16, 2026.
- Android Java compile: `android/gradlew.bat :app:compileDebugJavaWithJavac --rerun-tasks` passed on June 16, 2026, proving the native player edits compile fresh.
- Android Gradle hygiene: `android/gradlew.bat :app:compileDebugJavaWithJavac --warning-mode all` passed without Gradle deprecation warnings after modernizing Groovy DSL assignment syntax; AndroidX annotation metadata warnings were removed with a compile-only annotation dependency.
- Startup smoke: isolated temp server + browser reload reached usable home/menu focus in 174 ms; boot made one `/api/server`, one `/api/me`, one `/api/watch?profile=...`, one `/api/libraries`, and one `/api/watchlist` request.
- IPTV status: the real local server on `localhost:7777` reported TMDB, ffmpeg, Wyzie subtitles, IPTV, and music enabled. The server was restarted with stdout/stderr captured in `triboon-local.out.log` and `triboon-local.err.log`; startup warmed 9875 channels plus XMLTV and 96 Xtream guide channels.
- IPTV native logging: `test/security.test.js` covers upstream native playback failures and proves logs include channel/status while omitting credential-bearing provider URLs.
- IPTV playback probe: Shield WebView session fetched `/api/iptv/channels` with 9875 channels; first native URL returned `video/mp2t` with bytes in about 5.6s, and browser/remux fallback returned `video/mp4` with bytes in about 1.4s.
- IPTV provider rejection audit: `USA: CNN [1080p]` failed on Shield because the upstream provider returned HTTP 403 for both TS and HLS with `[Bot-Protection]: You are banned for repeated abuse`. This is now sanitized as `provider bot-protection`, short-cached by the native proxy to avoid Exo retry storms, and surfaced by Android as an HTTP provider failure instead of a generic Exo source error.
- Android install: debug APK installed on Shield at `10.1.20.11:5555`.
- Android native VOD smoke: started `The Super Mario Galaxy Movie` on Shield; timeline showed `1:38:14`, finish time showed `Ends at`, native rewind moved `0:17 -> 0:00`, native forward jumped to `0:32`, and the web video source stayed empty.
- Android native resume follow-up: a later Shield restore requested resume at 171s but visually restarted near the beginning; native resume now keeps `nativePendingStartMs` and reapplies the seek once ExoPlayer is READY instead of relying only on the immediate post-`prepare()` seek.
- Android native Live TV smoke: started channel 0 through the logged-in app path, caught stale web player state blocking D-pad zapping, fixed `setNativeLivePlaybackState`, reloaded the patched WebView, then confirmed Up moved `liveCur 0 -> 1` and Down moved `liveCur 1 -> 0`.
- Android subtitle smoke: native CC sheet opened with Off, English auto-match, version, and +/-0.5s sync rows; closing the sheet left playback clean.
- Android visual smoke: native video frame rendered; Back returned to the Triboon UI; after Live TV smoke the movie was restored from saved state.
- Android repeatable smoke helper: `bench/android-tv-smoke.ps1` launches/inspects the Shield, writes JSON state, pulls a screenshot to `bench/shots`, and can run the disruptive `-LiveZap` check when a real TV zap proof is needed.
- Android startup D-pad smoke: cold-started the Shield with early D-pad input; web focus was ready at ~198 ms, `/api/watch` returned at ~303 ms, the boot loader was hidden, and focus landed on a card instead of a dead body/WebView focus. This points the old "first 10 seconds frozen" symptom at the frontend first-focus gap, not backend loading.
- Android startup flicker follow-up: after the IPTV native-error changes, cold-started the Shield with early D-pad input again. Web focus was ready at 329 ms, `/api/watch` returned at 372 ms, the boot loader was hidden, early D-pad input landed on a Continue Watching card, and catalog/enrichment rows stayed deferred while the user was already navigating. The fix coalesces unchanged home rows, preserves focus across background row swaps, and waits for the TV focus/D-pad settle window before applying visible background refreshes.
- Continue Watching next-up stability: next-episode suggestions are prepared during the watch-state publish path with a short deadline instead of being added by the generic home enrichment pass several seconds later. Shield cold-start smoke showed the first focused Continue Watching card already carried `NEXT EPISODE` while TV focus stayed under one second.
- Live TV/PiP guide category navigation: category columns now keep their own D-pad lane. Up/Down clamps and applies categories, including at the bottom, and only Right enters the channel rows. `node --test test/phase4.test.js` and `npm.cmd test` passed 138/138 on June 16, 2026 after this fix.
- Android post-install focus follow-up: immediately after `adb install -r`, Android/Play Protect/launcher package-cache work still creates a short OS-level "no focused window" interval before Triboon is displayed. The native shell now reclaims focus on resume, window focus, page finish, and app-ready, then flushes queued D-pad keys. Post-install Shield smoke reached web focus at 111 ms after the app surface was active and early D-pad landed in the home rows.
- Local-library performance pass: attached library item payloads no longer warm from home; home only reuses already-cached explicit library data, rail rollover auto-loads a 15-item page for the highlighted local folder instead of the full scanned list, and library grids request additional 15-item pages with D-pad/scroll-triggered append.
- Local-library Shield probe: cold start reached TV focus at 306 ms. `IR - TV Shows` rail preview originally proved bounded paging by requesting `/api/libraries/dbcd999592/items?offset=0&limit=72&sort=added.desc`, rendering 72 cards from 720 top-level shows, then appending the next bounded page. The UI batch size was later lowered to 15 to make rail previews lighter.
- Browse backdrop sizing pass: Movies, TV Shows, and attached-library pages now toggle `shortBrowseBd`; TV-class 1080p caps the backdrop at 360px high and non-TV 1080p caps it at 420px so poster grids become visually dominant sooner.
- Android repeatable smoke helper now supports `-ColdStart -StartupDpad` for first-open focus readiness and `-VodSmoke` for disruptive native VOD resume/forward/rewind checks, in addition to `-LiveZap`.
- Android native VOD D-pad fix: Shield smoke confirmed subtitles no longer auto-open on playback start, VOD remux D-pad forward remounted from `startOffset 120 -> 173`, rewind remounted back to `171`, and the final screenshot stayed in native playback with no web video source.
- VOD seek loader polish: repeated movie/episode skips are now quiet seeks. Web and Android remux/transcode seek restarts keep the current playback surface instead of flashing the full preparing loader; startup and true failover can still show the branded loader.
- VOD skip flash fix: quiet web remux/transcode seeks now hold the last rendered frame over the source swap, and Android native remux/transcode seeks reuse the active ExoPlayer surface instead of releasing/recreating it, so repeated skip/rewind presses keep the player visually in place.
- ExoPlayer D-pad map fix: visible VOD chrome now gives Left/Right to the button row first, so Play/Pause can move to rewind/forward instead of accidentally skipping. The seek bar can still be selected with Up and scrubbed with Left/Right, hidden VOD surface Left/Right still skips, and Live TV Up/Down remains channel zapping.
- ExoPlayer auto-hide focus fix: when native VOD chrome fades out, logical focus parks on the seek bar; the next hidden Down press reveals the controls with Play/Pause focused instead of opening episode thumbnails or reusing stale button focus.
- ExoPlayer Back behavior fix: with native controls visible, Back hides the controls first. A later Back closes playback through the normal native close callback, which returns movies to movie details and TV episodes to the show detail path.
- Subtitle episode-sync fix: Wyzie/online subtitle ranking now gives exact TV episode matches priority and pushes wrong-episode files below generic fallback rows. Android native subtitles now use the same display timeline as the player after remux/transcode resume or seek, and subtitle-version rows keep their own saved sync offset instead of resetting to zero when selected.
- Subtitle auto-match cleanup: CC menus now collapse the generic language auto-match into the ranked concrete subtitle version after versions load, label the chosen file as Best match, and expose +/-5s sync jumps alongside the fine +/-0.5s controls on web and native ExoPlayer.
- Android native Live TV guard: after the VOD D-pad changes, Shield Live TV smoke still moved Up from `liveCur 0 -> 1` and Down back `1 -> 0`, proving VOD seeking did not steal live channel zapping.
- Android smoke helper update: `bench/android-tv-smoke.ps1` now prefers the non-blank WebView DevTools target after APK reinstall, can run `-VodNoSeek` to prove startup overlays stay quiet, and uses exact Android D-pad keycodes for VOD seek checks.
- Fresh APK smoke: after clean rebuild and reinstall, the Shield opened Triboon, exposed the native `TriboonTV` bridge, and kept the web video source empty when playback was requested.
- Episode player follow-up: TV episode playback now shows the show title plus a season/episode subline on web and Android native players. Native ExoPlayer progress now opens the Up Next countdown before the episode ends, and remux/transcode next-episode playback keeps the native seek bar focusable through server-side seeking.
- Up Next countdown check: the next-episode popup now uses one shared 10-second countdown for both the early pre-end popup and the ended fallback path, so users always get the same choice window before autoplay starts.
- Episode strip follow-up: D-pad episode playback now has a current-season thumbnail row below the controls. Web and native ExoPlayer use the same episode-choice data, default focus lands on the current episode, and selection returns through the regular episode play path instead of a native-only shortcut. The strip now opens with a slide/fade animation and uses larger borderless, rounded 16:9 stills with the episode name below the thumbnail, matching the Continue Watching card language more closely.
- TV detail follow-up: holding OK on a season card now toggles that entire season watched/unwatched through the bulk watch endpoint, then refreshes season badges and the Play/Resume target while restoring focus to the same season.
- TV detail season-year polish: season cards now surface each season's year as a small poster badge and keep the footer focused on the episode count, so show pages are easier to scan from the couch.
- Continue Watching removal polish: removing or marking an item from the home Continue Watching row now captures the action card, preserves the row's horizontal scroll, and restores focus to the same item or the next nearby card instead of jumping back to the row start.
- Continue Watching details fix: the long-press menu now defaults to Details, and the Details action maps episode cards to their parent show detail page before calling `openDetail`, instead of letting episode items fall through to playback.
- Local TV library detail fix: unmatched local shows now open a real local detail page with season cards built from scanned episode metadata, then drill into episode cards inside the selected season. This keeps shows like Bist o Yek from looking like every episode is its own season/grid item.
- Main app clock polish: the top-right web clock is now a slightly larger text-only glass badge with cleaner spacing and pointer-safe chrome, so it feels intentional without crowding browse filters.
- Idle screensaver: after 60 seconds of no app-shell input, Triboon now fades into a fullscreen clock/art screensaver. It uses the full Triboon wordmark logo (`web/triboon.png`, mirrored from `logo/triboon.png`), prewarms a profile-keyed TMDB "Trending Today" artwork cache once a day, falls back to already-visible/cached catalog rows when offline or unconfigured, shows only the active title without year/type metadata, never opens over video playback/login/setup/modals, and the first remote/mouse/touch input only wakes the app instead of also activating a focused card.
- Trakt profile sync fix: Trakt-imported watched history and playback progress are account-level fallback rows. Active profiles now merge only `fromTrakt` default rows into `/api/watch?profile=...`, while local default-profile playback remains isolated. Manual Trakt sync/import also invalidates watch caches and repaints Home, Watchlist, Calendar, or Details from the refreshed state so watched marks, Continue Watching, and Calendar watchlist data appear immediately.
- Watchlist/calendar episode metadata fix: A-Z browser smoke caught restricted-filter/calendar paths trying to call invalid `/api/tmdb/episode/:id` routes for episode records. Episode metas now normalize to the parent TV show before certification/upcoming-date checks, matching Continue Watching Details and preventing silent 502s in Watchlist/Calendar.
- A-Z browser release smoke: isolated server on `http://127.0.0.1:7788` with copied app data reached usable Home/menu focus in 101 ms. Smoke visited Home, Movies, TV, Watchlist, Calendar, Search, attached Library, Live TV, Music, Preferences, and Settings; remote Back returned each page to Home; detail Back restored Movies, TV, Library, and Watchlist to the same grid index; browser Back returned `#/tv` to `#/movies`; follow-up HTTP probe for Watchlist/Calendar returned no 4xx/5xx requests after the episode-metadata fix.
- Release v1.1.2 verification: `git diff --check` passed; `npm.cmd test` passed 138/138; `android/gradlew.bat clean assembleDebug` passed; `aapt dump badging dist/triboon-tv-v1.1.2.apk` reported `versionCode='33'` and `versionName='1.1.2'`; release APK SHA-256 is `282D22B689DA0718500835AFE843136077E11582CC0A28C5B108CA6B4477F9C3`.
- Web smoke: opened `http://localhost:7777/#/home`, verified home/navigation/cards/live rows, opened a movie detail, and started web playback through `/api/remux/...` with title and 1080p label visible.
- Security quick scan: no tracked-source secret hits found; `npm audit --omit=dev` is not applicable because this stdlib server has no lockfile/runtime npm dependency tree.

## Remaining Improvements

- Keep expanding `bench/android-tv-smoke.ps1` into full Android UI automation for guide/PiP retune, subtitles, audio, and quality switching. Startup D-pad, native VOD resume/seek, and Live TV zap now have repeatable ADB/CDP modes.
- Add an HTTPS/local-cert setup path so production APKs can eventually narrow cleartext traffic without breaking LAN installs.
- Replace deprecated Android platform calls reported by Java lint when we next touch display/WebView setup; Gradle 10 configuration deprecations are already cleaned.
- Add timing telemetry around detail click -> loading, loading -> first frame, source failure -> next source, and live retune -> first frame, especially on Shield.
- Investigate titles that still sit on "preparing stream" before Android receives a native URL; once ExoPlayer starts, the native startup watchdog now fails over instead of waiting forever.
- Consider a native-side warm ExoPlayer/surface strategy if measured first-frame time remains slow after source/mount caching.
- Investigate repeated Shield WebView `tile_manager.cc` tile-memory warnings seen around detail/player transitions; no crash or ExoPlayer fatal error was observed, but it may still contribute to perceived UI jank.
