# Playback, IPTV & Captions — How It Actually Works

Verified reference for the movies/TV (usenet VOD), Live TV (IPTV), resume, and
closed-caption paths. Line references are accurate as of v1.7.31; treat them as
"start reading here," not gospel — verify before quoting. Canonical perf numbers
still live in `docs-streaming-performance.md`; this file documents the *flow* and
the *constants* that were previously only in code.

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
| Verdict cache TTL / max | 6 h / 20000 entries | store.js |
| Prepare walk cap | 3 attempts / 12 s | pipeline.js |

### Auto-advance & prepare
- A dead source inside one `/api/play` is handled by the candidate walk itself —
  it tries the next-best source automatically and only errors if **all** fail.
- `/api/prepare` (detail-page warm) mounts the first viable source *without* a
  session so a later `/api/play` joins the live mount in ~0 ms.

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
Every ffmpeg remux is killed on: client disconnect, channel retune
(`beginIptvLiveSlot` closes the previous slot, **650ms** grace so the old process
exits before the new one spawns), idle/startup timeout
(**first-byte 12s / idle 45s**), and server shutdown (`closeAllIptvLiveStreams`).
There is **no artificial cap** on simultaneous single-channel plays — the only cap
is the intentional 4-pane multiview budget. EPG/Xtream guide refresh is **paused
while any stream is active** (`iptvPlaybackBusy()`), resuming after a 7s cooldown.

## 4. Resume & Continue Watching

- **Save** (`saveWatch`, web/index.html): debounced every 5s + on close; stored
  server-side keyed `userId:profile:itemKey`; `watched` at >92%; `meta.qualityRank`
  is preserved so a 4K watch resumes in 4K.
- **Continue Watching** (`buildCwItems`): not-watched + position>30s (or Trakt>2%),
  deduped by show identity; server-computed next episode (`/api/watch/next`) carries
  quality rank forward.
- **Resume goes through the full `/api/play` pipeline** — it re-searches, re-scores,
  and **re-runs the health gate**, so a stale link fails the gate and the walk picks
  a fresh source. It does **not** replay a stale mount blindly.
- **Position handoff**: remux/transcode use a server `start=<sec>` seek; direct play
  seeks the `<video>` element; native ExoPlayer uses `startOffset`.

## 5. Closed captions (overview — details pending CC research pass)

- Server: Wyzie client ([`opensubs.js`](server/opensubs.js)). The handler at
  `/api/ossubs/:mount` uses the **V2** path (`searchOnlineSubs` is exported as
  `searchOnlineSubsV2`): it accepts **both** tmdb and imdb ids
  (`wyzieCatalogId` = imdb-first), has a **release-hint fallback** (retries without
  exact-release filters on a mismatch), and **throws (does not cache) on empty
  results** — so misses retry on the next request.
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

### Research-backed accuracy wins that need an owner decision
The deep-research pass (sources: OpenSubtitles oshash spec, Wyzie docs, ffsubsync,
ISO 639-2 registry) confirmed two larger wins that are intentionally NOT done yet
because they cross a Locked Decision:
1. **Hash-exact sync via OpenSubtitles `moviehash`** (filesize + uint64-LE sum of the
   first & last 64 KB — only 128 KB I/O, computable on a mounted NZB via two `readAt`
   reads). Wyzie has **no** hash param, so this means adding OpenSubtitles as a second
   subtitle provider. Biggest single win for *correct-sync* matches.
2. **Content-based auto-sync (ffsubsync)** to fix constant-offset and 23.976↔25 fps
   desync. Requires a new external binary — `docs-architecture.md` locks approved
   binaries to ffmpeg + yt-dlp, so this needs explicit owner sign-off.
Wyzie's imdb-first `id` is already optimal (TMDB is slower — Wyzie resolves imdb from
it internally), so `wyzieCatalogId` needs no change. Remaining minor cleanups: the
`S##E##` parser caps season at 2 digits / episode at 3, and dead legacy V1 functions
(`opensubs.js` ~436/482) are shadowed by the V2 exports and should be deleted.
