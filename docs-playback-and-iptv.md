# Playback, IPTV & Captions — How It Actually Works

Verified reference for the movies/TV (usenet VOD), Live TV (IPTV), resume, and
closed-caption paths. Code symbols and file links are "start reading here," not
fixed line references; verify them against the current tree before quoting.
Canonical performance contracts live in `docs-streaming-performance.md`; this
file documents the flow and the important constants that otherwise live in code.

## 1. Press-play → first frame (usenet VOD)

Entry: `POST /api/play` → [`pipeline.play()`](server/pipeline.js). Order:

1. **Search** (`pipeline.search`) — indexer fan-out via [`newznab.js`](server/newznab.js),
   `Promise.allSettled`, **2000ms per-indexer** timeout, dedupe by normalized
   title + ~2% size window. A failed indexer never fails the search.
2. **Title verification + fallbacks** — strict anchored/consecutive match; on empty
   it retries a simplified query, then a title-only query (up to 3 fan-outs).
3. **Search cache** — 60s per query key (with/without imdb/tvdb variants).
4. **Rank** ([`scoring.js`](server/scoring.js)) — TRaSH-style custom-format score
   + Triboon stream-class & health signals. Anything `≤ -5000` is unplayable.
5. **Candidate walk** (`_advance`) — best-first, **MAX_ATTEMPTS=18**,
   **MAX_ADVANCE_MS=45000**. Per candidate:
   - live-mount reuse by URL (instant) → NZB cache/in-flight join →
     **NZB fetch (idle 5s, deadline 15s)** → **first-article STAT probe (800ms)**
     → **mount (deadline 30s)** → streamable/sample check →
     **bounded health gate (500ms)**.
6. Return `mountPayload` (stream/remux/transcode URLs, session id, chosen candidate).

### The health gate never blocks first frame
[`pipeline.js`](server/pipeline.js) races `vf.triage(healthProbeLimit||6)` against a
**500ms** timer. `blocked` → try next candidate. `verified`/`degraded` → play.
**Timeout → play anyway**, triage finishes in the background and records the verdict.
Triage STATs 6 articles (first, last, 4 random) on the `health` NNTP lane.

### Constants (previously code-only)
| Constant | Value | Where |
| --- | --- | --- |
| Per-indexer search timeout | 2000 ms | newznab.js |
| Search cache TTL | 60 s | pipeline.js |
| NZB fetch idle / deadline | 5 s / 15 s | pipeline.js |
| First-article STAT probe | 800 ms | pipeline.js |
| Mount deadline | 30 s | pipeline.js |
| Health gate (soft) | 500 ms | pipeline.js |
| Candidate walk cap | 18 attempts / 45 s | pipeline.js |
| Verdict cache TTL / max | 6 h / 10000 entries | server store policy |
| Prepare walk cap | 6 attempts / 15 s | pipeline.js |

### Auto-advance & prepare
- A dead source inside one `/api/play` is handled by the candidate walk itself —
  it tries the next-best source automatically and only errors if **all** fail.
- `/api/prepare` (detail-page warm) walks a bounded set and mounts the first
  viable source *without* a playback session. A later exact `/api/play` reuses
  or joins that prepared/in-flight mount instead of repeating the cold work.

## 2. Fast startup internals

- **NNTP** ([`nntp.js`](server/nntp.js)): pool pre-warms 4 connections; priority
  lanes `startup/seek(0) > playback(1) > health(2) > readAhead(3) > background(4)`;
  least-loaded multi-provider failover with a 60s circuit breaker; stall timeouts
  `CONNECT 8s / COMMAND 10s / IDLE_RECYCLE 30s`.
- **VFS** ([`vfs.js`](server/vfs.js)): segment map + read-ahead; a playback-priority
  read can *upgrade* a segment already queued as read-ahead; adaptive read-ahead
  boost when playback waits >250 ms.
- **Archive** ([`archive.js`](server/archive.js)): RAR/ZIP volumes mount in parallel;
  streaming-while-unpacking via an ordered extent table; only store/uncompressed +
  unencrypted is `streamable`.
- **Stream route** (`/api/stream/:id`): Range support; priority inferred —
  `start=0 → startup`, sequential range → `playback`, else `seek`.

## 3. Live TV / IPTV

- **Sources are first-class**: each M3U/Xtream source owns its id, channel cache
  (`iptvSourceCaches`, 24h TTL), XMLTV cache (`epgSourceCaches`, 12h), Xtream guide
  cache, source-scoped channel ids (`${sourceId}:${baseId}`), favorites and groups.
  Delete cleans runtime + disk caches + source-prefixed favorites/groups.
- **Browser** uses server fMP4 remux (`/api/iptv/stream/:idx` → ffmpeg in
  [`transcode.js`](server/transcode.js)). **Android** uses ExoPlayer against provider
  TS/HLS first, then server remux fallback.

### Connection lifecycle (no leaks, no artificial caps)
Every browser ffmpeg remux is killed on client disconnect, channel retune,
idle/startup timeout, and server shutdown. `beginIptvLiveSlot` closes the
previous slot before replacement; browser ffmpeg retunes use a **650ms** teardown
cushion, while the native Node proxy uses **120ms**. Browser startup gives each
source/attempt **12s to first byte** inside a **30s overall cap**, with a **45s
idle timeout**. The native proxy has its own **10s first-byte timeout**.
There is **no artificial cap** on simultaneous single-channel plays — the only cap
is the intentional 4-pane multiview budget. EPG/Xtream guide refresh is **paused
while any stream is active** (`iptvPlaybackBusy()`), resuming after a 7s cooldown.

## 4. Resume & Continue Watching

- **Save** (`saveWatch`, web/index.html): periodic checkpoints run every **10s**;
  non-final writes are skipped until playback has moved by at least **5s**.
  Pause, Back/Stop/close, EOF/up-next, Cast pause, page hide/visibility loss, and
  Android backgrounding issue immediate durable final checkpoints. Final writes
  use `keepalive` and coalesce the same point for 2s. State is stored server-side
  by `userId:profile:itemKey`; `watched` flips above 92%, and
  `meta.qualityRank` is preserved so a 4K watch resumes in 4K.
- **Continue Watching** (`buildCwItems`): not-watched + position>30s (or Trakt>2%),
  deduped by show identity; server-computed next episode (`/api/watch/next`) carries
  quality rank forward.
- **Resume goes through the full `/api/play` pipeline** — it re-searches, re-scores,
  and **re-runs the health gate**, so a stale link fails the gate and the walk picks
  a fresh source. It does **not** replay a stale mount blindly.
- **Position handoff**: remux/transcode use a server `start=<sec>` seek; direct play
  seeks the `<video>` element; native ExoPlayer uses `startOffset`.

## 5. Closed captions

- Server: Wyzie plus optional OpenSubtitles
  ([`opensubs.js`](server/opensubs.js)). `/api/ossubs/:mount` activates only the
  configured providers allowed by the Settings source mode, searches active
  providers concurrently, and ranks their combined results. A true empty
  provider combination throws before the result cache is populated, so a miss
  can retry on the next request.
- Bitmap subs (PGS/VobSub) cannot become text tracks; online subs are the practical
  CC path for BluRay releases. Embedded text subs are extracted via ffmpeg.
- **Diagnostics**: every Wyzie search logs one `[subs] …` line (catalog id + kind,
  language incl. the normalized form `raw->norm`, season/ep, release y/n, which path
  matched, result count) with the API key redacted (`redactSubUrl`). Use it to pin a
  CC miss to id/language/release vs. a true no-result.

### Language normalization (implemented)
ffprobe/Matroska emit 3-letter ISO 639-2 codes — often the **Bibliographic (B)**
variant (`ger`/`fre`/`cze`/`gre`/`per`/`chi`) — but Wyzie (and the OpenSubtitles REST
API) expect 2-letter **ISO 639-1**. Truncating an unmapped code to its first two
letters (`ces`→`ce`) searched the wrong language and was a top cause of "no subtitles"
on non-English titles. Fixed authoritatively server-side: `toIso6391()` in
[opensubs.js](server/opensubs.js) maps every B/T dual-code pair + common languages
(and reduces BCP 47 tags like `pt-BR`→`pt`) before the Wyzie call; the client
`LANG_3TO2` in [web/index.html](web/index.html) mirrors it. **Keep the two maps in sync.**

### OpenSubtitles hash-exact provider (implemented, optional/gated)
A second subtitle provider for **moviehash** matching — the strongest in-sync signal,
which Wyzie cannot do. It is gated by `effectiveOpenSubtitles()` and the selected
subtitle source mode. When OpenSubtitles is active, the handler computes the moviehash on the
mounted file (`moviehashForMount` → `moviehashFromChunks`: filesize + uint64-LE sum of
the first & last 64 KB, ~2 segment reads on the lowest NNTP lane, cached on the mount),
searches the active providers concurrently, and ranks the **combined** set with
`rankSubs`, where a `moviehash_match` gets a decisive
`+1000` boost so a hash-exact hit beats any release-name match. Downloads route by
provider (`_provider === 'opensubtitles'` → `osDownloadVtt` via a cached JWT with one
re-login retry). Quota and login failures return an actionable non-transient error;
when Wyzie is configured, the download path falls back to a Wyzie result before
surfacing that error. All OpenSubtitles client functions are in
[`opensubs.js`](server/opensubs.js) and mock-tested.

Configure Wyzie, OpenSubtitles, and provider priority in **Settings → Subtitles**.
For headless deployments, `TRIBOON_OS_API_KEY`, `TRIBOON_OS_USER`, and
`TRIBOON_OS_PASS` are the OpenSubtitles fallbacks; all three are required for
search plus download. `OPENSUBTITLES_BASE` overrides the host for tests.

### Automatic subtitle sync (alass) — implemented, gated
For a subtitle that is not already release- or hash-matched, **alass can correct
offset and framerate drift in the background**. It was chosen over ffsubsync because it is one small static binary
(no Python/numpy) that runs on Alpine via `gcompat` (build-verified) and fixes offset AND framerate
drift. Engine: `transcode.js` `detectSubSync()` + `spawnSubSync(ref, in, out)` → `alass <stream> in.srt out.srt`
(alass reads audio via ffmpeg; `ALASS_FFMPEG_PATH`/`ALASS_FFPROBE_PATH` point it at our binaries).

Flow (`/api/ossubs/:mount`):
- The chosen subtitle's metadata sets `subtitleLooksSynced` (moviehash match, provider release/
  filename match, or matching release key). The response carries `x-triboon-subsync`:
  `synced` (skip — already in sync), `pending` (not matched + alass available), or `unavailable`.
- On `pending`, the player (web `autoSyncSubtitle`, native `autoSyncNative`) re-requests `?sync=1`
  in the background; the server runs alass against the localhost tokened stream URL, caches the
  corrected VTT, and the player hot-swaps it in. The unsynced track plays meanwhile.
- **Skip rule (the "don't pull audio when you don't need to"):** `?sync=1` returns the sub as-is
  without running alass when `subtitleLooksSynced` is true. alass (which reads audio) only runs for
  non-matched subs. Any failure falls back to the unsynced track — auto-sync can never regress.
- `/api/server` reports `subSync`. When alass is absent, `subSync` is false and none of this runs.

Docker includes `gcompat` plus the alass v2.0.0 static binary; `/api/server`
reports whether it was detected. OpenSubtitles remains an optional hash-exact
provider, while Wyzie plus alass provides a key-authenticated release-ranked
alternative.
When both providers are enabled they search concurrently; alass runs only for a
chosen non-matched subtitle and does not replace either provider.

**Remaining verification:** alignment quality against real NZB streams still
needs the device/hardware pass recorded in `VERIFY.md`. The work is backgrounded
and falls back to the original subtitle on failure.
