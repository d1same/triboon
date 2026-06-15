# Triboon Release Audit Checklist

This is the A-to-Z checklist for keeping web and Android TV working as separate player surfaces. Web may use the web player. Android TV must route every movie, episode, local-library item, and live channel to native Media3/ExoPlayer, with no web-player fallback.

## Product Surface

- First run: owner setup, encrypted settings, provider/indexer/TMDB setup, and profile creation work from the web UI and Android shell.
- Auth: setup, login, invite, Quick Connect, profile switching, sign out, and expired-session recovery all show understandable next steps.
- Home: Continue Watching, library rows, live rows, calendar/discover/movie/show/music navigation, backdrop focus, watched/remove actions, and cover/backdrop refreshes remain stable.
- Search: exact title and year are used for playback search, including tricky titles and multi-word/spin-off cases.
- Details: Play, Resume, Start over, 1080p/4K preference, Sources, watchlist, watched, trailer, cast, recommendations, seasons, and episode cards all route to the correct target.
- Sources: source rows show clean title, quality, source type, size, score, selected state, and exact release playback. Manual source selection must resume from the latest saved position.
- Local library: local movies and matched TV episodes show playable detail pages, skip online source warmups when owned locally, and play the next owned episode without "no sources yet."
- Music: playback starts in Music and stops when leaving the Music section.
- Music: stays on the web audio path for now; ExoPlayer is reserved for video/live playback unless Android TV later needs native audio-session/background behavior.
- Live TV: playlist cache, EPG cache, category scrolling, channel play, guide, PiP guide, back behavior, and channel retune all stay responsive.
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

## Verification Log

- `npm test`: passed 134/134 on June 15, 2026.
- Android build: `android/gradlew.bat --no-build-cache assembleDebug` passed with Gradle 9.5.1 wrapper fallback.
- Android install: debug APK installed on Shield at `10.1.20.11:5555`.
- Android native smoke: started playback on Shield; app state reported native playback active, web video source empty, and ExoPlayer position advancing.
- Android visual smoke: native video frame rendered; Back returned to the Triboon UI.
- Fresh APK smoke: after clean rebuild and reinstall, the Shield opened Triboon, exposed the native `TriboonTV` bridge, and kept the web video source empty when playback was requested.
- Web smoke: opened `http://localhost:7777/#/home`, verified home/navigation/cards/live rows, opened a movie detail, and started web playback through `/api/remux/...` with title and 1080p label visible.
- Security quick scan: no tracked-source secret hits found; `npm audit --omit=dev` is not applicable because this stdlib server has no lockfile/runtime npm dependency tree.

## Remaining Improvements

- Add repeatable Android UI automation for native playback, guide/PiP retune, subtitles, audio, and quality switching. Current Android verification is ADB/CDP smoke plus unit/static tests.
- Add an HTTPS/local-cert setup path so production APKs can eventually narrow cleartext traffic without breaking LAN installs.
- Clean Gradle deprecation warnings before the next Android Gradle/Gradle major jump.
- Add timing telemetry around detail click -> loading, loading -> first frame, source failure -> next source, and live retune -> first frame, especially on Shield.
- Investigate titles that still sit on "preparing stream" before Android receives a native URL; once ExoPlayer starts, the native startup watchdog now fails over instead of waiting forever.
- Consider a native-side warm ExoPlayer/surface strategy if measured first-frame time remains slow after source/mount caching.
