CLAUDE.md — Triboon

Triboon is a self-hosted, Plex-polished, Stremio-style streaming app. Pressing play on any
movie/show instantly mounts the best healthy NZB from the admin's usenet provider and streams
it while unpacking, with continuous health protection. Speed is the #1 product value.
See docs-architecture.md for the full architecture, data model, and verify criteria.

Working process (ALWAYS follow — this is the owner's method)


Brainstorm + Devil's Advocate — before building any feature, expand the idea AND challenge
it: what could fail, what are we assuming, what would users hate, what's overcomplicated.
Interview + Capture — when requirements are ambiguous, ask the owner short rounds of
questions, keep a running brief, and play it back ("Is this right?") before building.
Verify Before Trusting — never declare work done without running it. Run npm test
after every engine change. Add tests for new behavior BEFORE marking complete. For UI work,
start the server (node server/index.js), open http://localhost:7777, and visually check.
Audit your own output for contradictions with this file and docs-architecture.md.


Locked decisions (do not re-litigate without asking the owner)


Native rebuild of nzbdav + UsenetStreamer concepts (MIT; reference designs, clean-room code).
Stack: Node 20, zero runtime npm dependencies in server/ (stdlib only). Keep it that way
unless the owner approves a dependency. Go port is a Phase-1+ option only if profiling demands it.
Playback policy: source-fit → direct play → remux → transcode, strictly in that order.
Per-user quality caps are enforced at SOURCE SELECTION first (pick a 1080p release for a
1080p-capped user), transcoder second.
Clients: one web UI (TV spatial nav, D-pad) → browser + Tauri desktop; thin Android shell
with native ExoPlayer later. UI lives in web/index.html (single file for now).
Product model: admin configures everything (usenet, indexers, TMDB); users join via invite
link / QR / Quick Connect code and never see credentials. Multi-user, profiles, watch state.
Health: bounded upfront gate (≤500ms) + background triage + auto-advance with timestamp
resume. Never block playback on exhaustive checks.
Catalogs: TMDB metadata + Trakt rows; MDBList later. No Sonarr/Radarr — built-in search/Library.
Design system: ink #0B0812, magenta #C13BD6 → coral #FB8B3C gradient, amber #FFC65C;
Sora display / Albert Sans body / JetBrains Mono badges. Signature: gradient focus ring +
backdrop crossfade following focus. Backdrops ARE the interface.


Commands


npm test — full suite (node:test, 113 tests). Must stay green; this gates every phase.
node server/index.js — http://localhost:7777. Everything (providers, indexers, TMDB) is
configured in the web dashboard after first-run setup and encrypted at rest in ./data; env
NNTP_* still works as an optional bootstrap. State dir override: TRIBOON_DATA. Token/settings
key: TRIBOON_SECRET (else generated into ./data).
docker compose up --build — containerized, ffmpeg included, /data on a named volume.
First run: open the UI → create owner → Settings → add provider/indexer/TMDB → press Play.
Auth: API is deny-by-default; stream URLs carry a signed ?t= token so VLC can play them.


Repo map


server/yenc.js — yEnc decode (hot path) + encode (tests). server/nzb.js — NZB parse + primary-file pick + password meta.
server/nntp.js — NNTP client + parallel-connect pool + multi-provider failover (STAT/BODY).
server/vfs.js — NzbFileStream segment map, read-ahead, readAt, triage. server/rar.js — RAR4+RAR5
header parse → extent map. server/zip.js — ZIP parse. server/archive.js — container detection,
volume ordering (.r99→.s00 rollover), archive mounts, verdict tags (🐢/encrypted/unsupported).
server/index.js — HTTP API + Range streaming + static UI. web/index.html — entire UI.
test/ — mock NNTP server + golden e2e suite (byte-exact streams incl. multi-volume RAR, seek
fuzzing, Range semantics incl. suffix ranges, triage verdicts, <250ms cold-seek budget).
test/fixtures/ — real-tool archives (see its README); test/archive-fixtures.js — clean-room
store-RAR/ZIP writers validated against real unrar. bench/ — provider benchmark + real smoke.
android/ — Android TV shell (framework-only Java WebView wrapper: leanback launcher, D-pad
passthrough, BACK→web __tvBack() bridge, native JS dialogs, first-run server screen). Build:
JAVA_HOME=Android Studio jbr, ANDROID_HOME=%LOCALAPPDATA%\Android\Sdk, gradle 8.10.2 in
C:\Users\opencode\tools → gradle assembleDebug → app/build/outputs/apk/debug.


Roadmap (current: Phases 0–4 implemented & verified, 113/113 tests + Docker + real provider)


Phase 1 (DONE — owner streamed a real RAR'd NZB in VLC with seeking): native streaming
store-RAR4/RAR5 + ZIP with seeking, multi-volume (.r99→.s00 rollover), multi-provider
failover, par2/junk awareness. Compressed RAR / encrypted / 7z are DETECTED + verdict-tagged
(🐢/blocked), not yet playable — store covers ~95%+ of video. See docs-phase1-brief.md.
Phase 2 (DONE): newznab/Prowlarr/NZBHydra fan-out (server/newznab.js, hard per-indexer
budget), TRaSH-Guides-style ranking (server/scoring.js — group/source/codec tiers, HDR/audio
boosts, LQ penalties, PLUS Triboon-only streamability + health + per-user cap signals, tuned
for press-play not archiving), verdict cache (server/store.js), press-play pipeline with
bounded 500ms health gate + auto-advance + prefetch/NZB/live-mount caching (server/pipeline.js).
Title verification (server/pipeline.js releaseMatches): wanted title ANCHORED at the start of
the release name, near-consecutive words, structural token (year/SxxEyy/quality) required right
after — fixes one-word titles ("From" played Stranger Things Tales From 85) and spin-off traps
(Daryl Dixon for The Walking Dead). Settings changes invalidate the search cache.
Phase 3 (DONE): scrypt auth + HMAC tokens + stream tokens for VLC, first-run setup, single-use
invites, profiles, Quick Connect; deny-by-default route table (server/index.js ROUTES) with a
route-coverage test; settings encrypted at rest AES-256-GCM (server/auth.js SecureSettings);
TMDB server-side proxy + cache (server/tmdb.js); per-profile watch state.
Phase 4 core (DONE): per-user resolution caps enforced at SOURCE selection; ffmpeg remux
manager (server/transcode.js, source-fit→direct→remux→transcode), graceful no-ffmpeg degrade;
full Plex-style web UI (web/index.html — setup/login/QC/invite, TMDB rows, single Play button,
Sources drawer, player w/ resume + auto-advance + VLC handoff, admin settings, D-pad nav).
Phase 4 polish (DONE): admin size caps + scoring tweaks + per-indexer daily limits + provider/
indexer tests & in-place edit; combined multi-provider load balancing (server/nntp.js);
Wyzie Subs online CC (server/opensubs.js — free key from store.wyzie.io/redeem, search by
TMDB id; replaced OpenSubtitles whose API went paid. BluRay releases carry bitmap-only PGS
subs, so online CC is the path that matters). Client capability claims (canPlayType → caps
on /api/play): true direct play when the hardware decodes container+codecs; otherwise remux
copies video and converts ONLY unsupported audio to AAC (server/transcode.js audioCopyOk).
A/V sync flags (delay_moov + noaccurate_seek + make_zero + 500ms fragments) are MEASUREMENT-
GATED via bench/sync-variants.js — never change them without re-measuring (plain empty_moov
shifted copied B-frame video +83ms vs audio; accurate seek + copy baked in seconds of desync
after every skip). bench/sync-debug.js + bench/search-debug.js drive the live server/indexers.
Phase 5 (IN PROGRESS): Android TV shell built (android/, WebView + key bridge, APK builds;
D-pad audited across every view incl. CC/audio-menu loop, genre filter, quality toggle,
long-press OK on Continue Watching) — pending owner demo on real hardware. NEXT: ExoPlayer
handoff; ffmpeg HW-accel ladder + HDR tone-map; Trakt rows + scrobble; Tauri; par2; MDBList.


Hard rules


A phase is "done" only when its tests pass AND the owner has seen a demo.
Never weaken or delete a failing test to make it pass — fix the code or raise it with the owner.
Security: deny-by-default routing; every new endpoint must declare auth (Phase 3+) and be
covered by the route-coverage test. Credentials encrypted at rest.
This is for legally obtained content; keep the project's disclaimer intact.