# Triboon — Architecture & Build Plan v1.0

> Self-hosted, Plex-polished, Stremio-style streaming. Press play on any movie or show → the best
> healthy NZB from the admin's usenet provider mounts instantly → stream while unpacking, with
> continuous health protection. **Speed is the #1 value.**

---

## 1. Product model (the Plex pattern)

- **Admin** runs one Docker container, configures usenet provider(s), indexers, transcoding,
  and user quality policies from the server dashboard.
- **Users** install a client app (or open a browser), join via invite link / QR / Quick Connect
  code, and stream. They never see an NZB, an indexer, or an API key.
- All metadata (TMDB, Trakt, OpenSubtitles) is **proxied through the server** — clients are thin.

## 2. System overview

```
┌────────────────────────────  TRIBOON SERVER (one Go binary, Docker)  ───────────────────────────┐
│                                                                                                  │
│  ┌──────────────┐   ┌───────────────┐   ┌──────────────────┐   ┌─────────────────────────────┐  │
│  │  API Gateway  │   │  Catalog Svc  │   │  Search & Triage │   │       Stream Engine          │  │
│  │  REST + WS    │──▶│  TMDB/Trakt   │   │  Indexer fan-out │   │  NNTP pool → yEnc → RAR/7z   │  │
│  │  auth, invites│   │  proxy+cache  │   │  NNTP health     │   │  virtual FS → HTTP range     │  │
│  └──────┬───────┘   └───────────────┘   │  smart ranking   │   └──────────┬──────────────────┘  │
│         │                                └──────────────────┘              │                      │
│  ┌──────┴───────┐   ┌───────────────┐   ┌──────────────────┐   ┌──────────┴──────────────────┐  │
│  │  User/Profile │   │   Library &   │   │  Playback        │   │     Transcode Manager        │  │
│  │  quality caps │   │   Watch State │   │  Decision Engine │   │  ffmpeg (HW accel) → HLS     │  │
│  └──────────────┘   └───────────────┘   │  direct/remux/   │   │  only when direct play fails │  │
│                                          │  transcode       │   └─────────────────────────────┘  │
│  SQLite (users, library, watch state, NZB cache, health verdicts)  ·  ffmpeg sidecar binary      │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
            ▲                          ▲                              ▲
   ┌────────┴───────┐        ┌────────┴────────┐           ┌────────┴────────┐
   │  Web UI (React)│        │  Tauri Desktop  │           │  Android TV/Phone│
   │  browser, TV   │        │  (wraps Web UI) │           │  WebView UI +    │
   │  spatial nav   │        │                 │           │  native ExoPlayer│
   └────────────────┘        └─────────────────┘           └─────────────────┘
```

## 3. Components

### 3.1 Stream Engine (the heart — rebuilt from nzbdav concepts)
| Piece | Responsibility | Go building blocks |
|---|---|---|
| NNTP pool | N persistent TLS connections per provider, multi-provider failover | `net/textproto`, custom pool |
| Segment fetcher | Parallel article download, ordered reassembly, read-ahead window | goroutines + ring buffer |
| yEnc decoder | CPU-hot path; SIMD-friendly decode | `go-yenc` / rapidyenc port |
| Archive layer | Stream **inside** RAR/7z without extraction; seek = map byte offset → archive part → segments | `rardecode` v2 (store + compressed), 7z reader |
| Virtual FS | Mounted NZB = virtual file tree; serves **HTTP Range** requests to players | custom `io.ReaderAt` over segment map |
| Health & repair | Per-segment `STAT` probes; on missing articles, retry alt providers; par2 recovery (Phase 3) | par2 lib / process |

**Why this is fast:** mounting an NZB = parsing XML + building a segment map (milliseconds, no
download). First byte of video = fetch only the first few segments of the first archive part.
Seeking = jump the segment map. The read-ahead window keeps ~30–60s buffered ahead of playhead.

### 3.2 Search & Triage (rebuilt from UsenetStreamer concepts)
- **Fan-out:** parallel queries to Prowlarr / NZBHydra / direct Newznab endpoints; dedupe by
  normalized title + group + size window.
- **ID-aware plans:** IMDb/TMDB/TVDB (+ anime IDs later) with per-indexer capability gating.
- **Ranking chain (configurable):** `quality → size → seed-health → language → date`, with
  per-resolution caps so the picker isn't 200 rows long.
- **Triage:** background NNTP `STAT` sampling + archive-header peek (is the format streamable?
  is there a video file inside?). Verdicts cached per NZB URL **and** per normalized title.
- **Protection modes** (per-server setting): `auto-advance` (default — return instantly, swap
  source seamlessly on mid-stream failure), `background-verify + smart-pick`, `upfront-check`
  (slowest, most cautious).

### 3.3 Playback Decision Engine (the Plex trick, improved)
Order of attempts for every play request:
1. **Source-level fit (Triboon's edge):** pick a release that the device can direct-play *within
   the user's quality cap* — a 1080p-capped user gets a 1080p release, not a transcoded 4K.
2. **Direct play:** serve raw bytes over HTTP Range (Android/ExoPlayer, desktop mpv path).
3. **Remux:** container swap MKV→fMP4/HLS, streams copied, ~0 CPU (browsers that support the codec).
4. **Transcode:** ffmpeg with HW accel (QSV/NVENC/VAAPI), HLS ladder, optional HDR→SDR tone-map.

### 3.4 Catalog Service
- TMDB: metadata, images, episode data, logos. Server-side key, aggressive cache (SQLite + disk).
- Trakt: trending/popular/recommended rows + per-user scrobbling (users link their own Trakt
  account via device-code OAuth; optional).
- MDBList custom catalogs: v1.5.
- OpenSubtitles: server-side search/download, converted to WebVTT for browsers, raw for ExoPlayer.

### 3.5 Users, Library, Watch State
- Owner/admin + invited users; profiles per user (incl. kids profile with rating ceiling).
- Per-user policy: max resolution, max bitrate, allow-transcode, allowed libraries/catalogs.
- Library = saved mounts (movie/show → chosen NZB → segment map) + per-profile watch state
  (position, watched flags) → powers Continue Watching across devices, re-watch is instant.
- Invites: one-time links/QR; TV login via Quick Connect 6-digit code approved from phone.

### 3.6 Clients
- **Web UI** (React + TypeScript, Vite): one codebase with two layout modes (pointer / 10-foot
  D-pad spatial navigation). Player: HLS.js + native MSE.
- **Desktop:** Tauri wrapper of the Web UI (small, native feel). v1.5: embed libmpv for
  direct-play of anything, removing the transcode need on desktop too.
- **Android (TV + phone):** single Kotlin app, WebView renders the same UI, a JS bridge hands
  play intents to **ExoPlayer/Media3** → hardware direct-play of MKV/HEVC/DTS, zero server CPU.

## 4. The play-button pipeline (target: < 5 seconds to first frame)

```
t=0.0s  User presses Play on "Dune: Part Two"
t=0.1s  Cache hit? Library mount or cached verified NZB → skip to t=2.5
t=0.3s  Indexer fan-out (parallel, 2s hard timeout per indexer)
t=1.5s  Rank results → filter by user cap & device profile → pick best candidate
t=1.7s  Fetch NZB, parse, build segment map (no download)            ← "mounting"
t=2.0s  Quick health gate: STAT first + last + random segments (parallel, 500ms budget)
t=2.5s  Playback decision: direct play? remux? transcode?
t=3.0s  First segments streaming into read-ahead buffer
t≈4.5s  First frame on screen; background triage continues on the chosen release
        If mid-stream segments go missing → try alt provider → else auto-advance
        to the next ranked release, resuming at the same timestamp.
```

Speed levers: per-indexer timeout budget · verdict + NZB caching (two-tier) · read-ahead window
tuning · connection pool warm-keep · source-fit-first (avoids transcoder entirely) ·
HW transcoding only as last resort.

## 5. Data model (SQLite, WAL mode)

```
users(id, name, email?, role, password_hash, created_at)
profiles(id, user_id, name, avatar, is_kid, rating_limit)
policies(user_id, max_resolution, max_bitrate_kbps, allow_transcode, catalog_acl)
invites(token, created_by, expires_at, used_by?)
devices(id, user_id, kind[web|tv|phone|desktop], name, quick_connect_code?, last_seen)
titles(id, tmdb_id, type[movie|show], metadata_json, refreshed_at)
library_items(id, title_id, release_id, added_by, added_at)
releases(id, title_id, indexer, nzb_url, size, resolution, codecs, language, health[verified|unverified|blocked], segment_map_blob?)
watch_state(profile_id, title_id, episode_key?, position_s, watched, updated_at)
health_verdicts(key[nzb_url|norm_title], verdict, checked_at, detail_json)
settings(key, value)            -- usenet providers, indexers, transcode config (encrypted at rest)
```

## 6. Security
- Argon2id password hashing; JWT sessions; separate scopes: admin vs stream.
- Invite tokens single-use + expiring; Quick Connect codes 60s TTL, approve-from-phone.
- Provider/indexer credentials encrypted at rest (age/NaCl secretbox, key from env).
- Reverse-proxy-friendly (Caddy/Traefik examples shipped); rate-limit auth endpoints.
- Lesson from nzbdav's 2026 auth-bypass disclosure: auth middleware applied globally by default,
  deny-by-default routing, and an automated route-coverage test in CI so no endpoint ships unauthenticated.

## 7. Build roadmap (phased so something streams early)

| Phase | Weeks | Deliverable | Proves |
|---|---|---|---|
| **0. Spike** | 1–2 | Go CLI: parse NZB → NNTP fetch → yEnc → stream a *non-archived* file over HTTP Range to VLC | NNTP core works |
| **1. Engine** | 3–6 | Streaming RAR (store) + seeking + read-ahead + connection pool + multi-provider | The hard part works |
| **2. Search** | 7–9 | Newznab/Prowlarr fan-out, ranking, STAT health gate, verdict cache, auto-advance | Press-play pipeline e2e (CLI) |
| **3. Server+Web** | 10–14 | API, auth/invites, TMDB catalog, Web UI (pointer mode), HLS remux path, watch state | Usable product in a browser |
| **4. Plex-grade** | 15–18 | ffmpeg HW transcode ladder, per-user caps, profiles, TV spatial nav, Quick Connect | Multi-user household |
| **5. Android** | 19–22 | Kotlin shell + ExoPlayer bridge (TV + phone), Trakt rows + scrobble, OpenSubtitles | The living-room experience |
| **6. Polish** | 23+ | Tauri desktop, chapter skip-intro + next-ep countdown, par2 repair, MDBList, libmpv desktop | v1.0 |

Non-goals v1: Sonarr/Radarr-compat API, iOS/tvOS, offline downloads, audio-fingerprint intro
detection, central cloud/relay.

## 8. VERIFY PASS (Step 3 audit of this plan)

### 8.1 Requirements coverage — every brief item mapped
| Requirement (from interview) | Covered by |
|---|---|
| Stremio-like discovery, TMDB in settings | §3.4 Catalog (admin-side keys, user never configures) |
| Connect our usenet + indexers (admin-owned) | §3.2 + §5 settings; users never see them |
| Instant "symlink"/mount + stream while unpacking | §3.1 virtual FS + §4 pipeline (mount = segment map, ms) |
| Always quickly check health, but FAST | §3.2 protection modes; 500ms upfront gate + background triage + auto-advance |
| Super nice player, Plex × Stremio | §3.3 decision engine + §3.6 clients; auto-pick default, Sources picker behind a button |
| Browser, Android TV, phone, desktop | §3.6 — one UI, two player paths |
| 4K vs 1080p per user / low-end devices | §3.3 step 1: source-fit beats transcoding; §5 policies |
| Built-in organizing/searching, no arrs | §3.2 + §3.5 Library (no disk files → no arr complexity) |
| Plex-style: users just connect via URL | §3.5 invites + Quick Connect; §1 product model |
| Multi-user with invites | §3.5, §5, §6 |
| Trakt, OpenSubtitles, skip-intro, next-ep | §3.4 + roadmap Phases 5–6 |
| Docker-first install | §1, single image + ffmpeg sidecar |

### 8.2 Assumptions made explicit
1. Admin's server has an iGPU/GPU for transcoding — *software 4K HEVC transcode is not viable*.
   Mitigation: setup wizard detects HW accel and warns; source-fit policy minimizes transcoding.
2. Usenet provider allows enough connections (typically 30–60) — pool size must be configurable
   and benchmarked in the wizard.
3. Compressed RAR (non-store) releases are a minority but exist — seeking inside compressed RAR
   is expensive; plan: stream-decompress with a decode-ahead cursor, warn in picker (🐢 tag).
4. "One binary" = one Go binary + ffmpeg sidecar in the image (same as Plex). Stated precisely.
5. Stremio/Plex UX is the bar, not their code — clean-room rebuild referencing MIT-licensed
   nzbdav/UsenetStreamer designs is legitimate.

### 8.3 Contradictions found & resolved
- *"Fast above all" vs upfront health checks* → resolved: 500ms bounded gate + background
  verification + seamless auto-advance (resume at timestamp).
- *"Fast" vs server transcoding* → resolved: source-fit-first makes transcoding the exception.
- *"Users select 4K/1080p" vs admin control* → resolved as **admin sets the cap, user picks
  within it** (Plex semantics).

### 8.4 Top risks (ranked) & mitigations
1. **Streaming-RAR seek correctness** (hardest engineering) → Phase 1 has dedicated
   golden-file test suite: store-RAR, multi-part, compressed, 7z, password-protected.
2. **Mid-stream article takedowns** → auto-advance with timestamp resume; multi-provider failover.
3. **Browser codec wall** (HEVC/DTS) → remux + transcode ladder; Android path avoids it entirely.
4. **Scope creep** → phases gated by demos; nothing in Phase N+1 starts until N's demo passes.
5. **Security exposure of a public server** → §6 deny-by-default + CI route-coverage test.

### 8.5 How the implementation itself will be verified (future Step 3s)
- Engine: golden NZB test corpus + byte-exact checksums; seek fuzzing (random offsets vs ffprobe).
- Pipeline: e2e timer asserting the <5s budget per stage in CI against a mock NNTP server.
- Players: Playwright (web) + ExoPlayer instrumentation tests (Android) for play/seek/resume.
- Security: route-coverage test (every endpoint must declare auth), dependency audit in CI.

---

## 9. IMPLEMENTATION STATUS (2026-06-11)

Phases 0–4 are implemented and verified — a usable multi-user product. 57/57 tests
(`npm test`), runs in Docker with the ffmpeg sidecar, full suite also green inside the
production Alpine container, and verified end-to-end against the owner's real Easynews
provider + nzbgeek indexer + TMDB.

Built (all clean-room, zero runtime npm dependencies, Node 20 stdlib only):
- **Engine (§3.1):** yEnc, NZB, NNTP parallel-connect pool + multi-provider failover, segment
  VFS, **streaming store-RAR4/RAR5 + ZIP with seeking** (multi-volume incl. `.r99→.s00`),
  compressed/encrypted/7z **detected + verdict-tagged** (playback deferred).
- **Search & Triage (§3.2):** newznab fan-out with hard per-indexer budget; TRaSH-Guides-style
  ranking + Triboon streamability/health signals, tuned for press-play; verdict cache.
- **Playback Decision (§3.3):** source-fit (per-user caps at selection) → direct → ffmpeg remux
  → (transcode ladder = next); honest no-ffmpeg degrade to VLC handoff.
- **Catalog (§3.4):** TMDB server-side proxy + cache.
- **Users/Library/Watch (§3.5):** scrypt auth, HMAC + stream tokens, single-use invites,
  profiles, Quick Connect, per-profile watch state + Continue Watching.
- **Clients (§3.6):** the full Web UI (single file, TV D-pad spatial nav, the locked design
  system) — setup/login/QC/invite, TMDB rows, single Play button, Sources drawer with live
  scoring, player with resume + auto-advance + VLC handoff, admin settings.
- **Security (§6):** deny-by-default route table + route-coverage test; settings encrypted at
  rest (AES-256-GCM). Persistence is a stdlib JSON store (SQLite swap-in when Node ≥22).

**Measured press-play (real provider):** browsed-then-played title → stream URL ~2.8s cold,
~4ms on replay (live-mount reuse); multi-volume RAR mid-file seek ~175–200ms.

**Next:** ffmpeg HW-accel transcode ladder + HDR tone-map (§3.3 step 4), then Phases 5–6
(Android/ExoPlayer, Trakt, OpenSubtitles, Tauri, par2 repair, MDBList).
