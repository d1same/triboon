# Continue Watching Contract

Continue Watching is a product contract, not only a row on Home. It ties
watch-state persistence, source quality, TV next-up behavior, local-library
identity, Trakt imports, D-pad focus, and player resume together.

## Ownership Map

```mermaid
flowchart LR
  Player["Web player / Android native bridge"] --> Save["saveWatch()"]
  Save --> WatchApi["POST /api/watch"]
  WatchApi --> Store["watch store bucket"]
  Store --> WatchList["GET /api/watch"]
  Store --> WatchNext["GET /api/watch/next"]
  WatchList --> Build["buildCwItems()"]
  WatchNext --> Build
  LocalMap["S.localMap local libraries"] --> Build
  Build --> Row["Home Continue Watching row"]
  Row --> Play["play() / playLocal()"]
  Row --> Details["detailTargetForItem()"]
  Row --> Remove["cwOp() remove / mark watched"]
  Remove --> WatchApi
```

## Files To Review First

- `web/index.html`
  - `saveWatch()` writes resume position, duration, metadata, and
    `qualityRank`.
  - Final checkpoints run immediately on pause, Back/Stop, EOF/Up Next,
    Cast pause, page hide, mobile visibility loss, and Android backgrounding.
    Identical lifecycle beacons are coalesced and final requests use
    `keepalive`; Multiview VOD slots follow the same contract.
  - `preferredQualityRankForItem()` owns the durable title/show preference;
    `qualityRankForItem()` applies only the current device's effective cap.
  - `loadWatchState()`, `buildCwItems()`, `continueWatchingIdentity()`,
    and `dedupeContinueWatchingItems()` build the Home row.
  - `cwOp()`, `homeFocusSnapshot()`, and `restoreHomeFocus()` keep row focus
    stable after remove/mark actions.
  - `epItemOf()`, `epTarget()`, `prepNextEpisode()`, and
    `prepPlayerSeasonEpisodes()` carry quality into remaining episodes.
- `server/index.js`
  - `watchRowsForProfileFromAll()` scopes rows by user/profile and merges
    Trakt fallback rows.
  - `watchSet` saves or removes one canonical watch key.
  - `nextWatchEpisodes()` creates server-side next-up suggestions and carries
    the saved `qualityRank`.
- `test/phase4.test.js`
  - Client contract checks for quality, dedupe, focus, details routing, and
    Up Next behavior.
- `test/security.test.js`
  - Server behavior checks for profile isolation, removal, and next-up payloads.

## Identity Rules

- Movies use `movie:<tmdbId>`.
- TV uses `tv:<tmdbId>` for every episode of the same show in the Home row.
  The row shows the most useful show card: active in-progress beats next-up,
  then the newest activity wins.
- When TMDB ids are missing, the row falls back to a cleaned title identity
  with common quality/source tags stripped so local-only `1080p` and `4K`
  copies do not create duplicate cards.
- Exact watch storage still stays episode-level:
  `tmdb:tv:<id>:s<season>e<episode>`. The show-level identity is only for the
  Home row merge.

## Quality Rules

- The selected source class is saved as `qualityRank` in watch metadata.
- Device-only safety caps are not durable preferences. A browser may request
  1080p when web 4K is disabled, but that effective cap must not overwrite the
  saved 4K rank that Android uses later.
- `qualityRank` is title/show scoped through `qualityTitleKey()`, so a TV show
  selection applies to remaining episodes.
- Continue Watching cards, `/api/watch/next` next-up cards, the Up Next popup,
  and the player episode strip all carry that same rank.
- A 4K preference should request 4K sources first and must not silently fall
  back to a local 1080p file unless the user changes the quality choice or no
  quality preference exists.

## Trakt Resume Rules

- Trakt imports may contain only a watched percentage, with no position or
  duration. The client sends that bounded fraction to `/api/prepare` and
  `/api/play` so the server warms the matching byte window.
- Web playback converts the fraction after metadata supplies duration.
- Android sends `startFraction` through the native bridge. Direct playback
  seeks once ExoPlayer knows duration; remux/transcode performs one
  token-guarded server-seek remount at the computed absolute timestamp.
- Native progress, READY state, and the loading surface must not report a false
  zero position before that resume handoff completes. READY alone is not proof
  that resumed frames are advancing; real playback owns that boundary.

## Resume Source Recovery

- Web and native playback re-check the live mount after opening. A confirmed
  blocked source advances immediately to the next ranked release.
- Startup without a real first frame uses the bounded player fallback ladder.
  An established playback stall retries the same source/kind/timestamp once;
  a second sustained stall changes release, never episode.
- Source replacement retains the requested Continue Watching point even when
  it occurs before the native player reports its first position callback.

## Focus Rules

- Remove/mark actions capture the action card before the request.
- After the server accepts the change, the local watch cache is updated first
  and Home is repainted with `watchReady: true`; it must not publish an empty
  placeholder row during a preserve-focus repaint.
- If the removed card is gone, focus lands on the nearest remaining card in the
  same row. It should not jump into Live TV unless the Continue Watching row no
  longer exists.

## Change Checklist

When changing Continue Watching, verify:

1. A movie watched in 4K resumes as 4K.
2. A show watched in 4K continues remaining episodes as 4K.
3. 4K and 1080p versions of the same movie/show do not appear as duplicate
   Home cards.
4. Removing a middle card keeps focus in Continue Watching near the removed
   position.
5. Details from a Continue Watching episode opens the show details page, while
   Resume plays the exact episode.
6. Trakt-imported progress still appears for every active profile without
   overwriting stronger local progress.
7. Percent-only Trakt progress resumes on Android for both direct and
   remux/transcode paths without briefly publishing position zero.
8. A browser's automatic 1080p cap does not replace a durable 4K preference;
   the next Android Continue Watching request still asks for 4K.
9. Pause or stop web, native direct/remux/transcode, Cast, and Multiview VOD;
   the latest position is immediately visible in Continue Watching, including
   after backgrounding or closing the app.
10. Resume an episode whose saved source is now blocked: playback advances to a
    healthy release at the same episode and timestamp without visiting details.
11. `npm.cmd test` passes after behavior changes.
