# Migration fixtures: saved progress written by Triboon 3.4.13, 3.4.14 and 3.4.15

Each folder is what one released version wrote for the same made-up library and the same clicks, so a
migration (re-keying `local:<lib>:<position>` rows) can be tested against real rows of every version.

| Folder | Version | Commit |
|---|---|---|
| `3.4.13/` | 3.4.13 | `a039b68` |
| `3.4.14/` | 3.4.14 | `22635b1` |
| `3.4.15/` | 3.4.15 | `cedd7f2` |

Made with `capture-fixtures.js` (see `../RIG.md`): the version's own server and web page (headless Edge,
real UI clicks, progress saved by the page itself), stopped through SIGTERM so the store flushed.

## Files in each folder

| File | What it is |
|---|---|
| `watch.json` | The `watch` table as written: key `<userId>:<profileId>:<item key>`. |
| `watchlist.json` | The `watchlist` table: key `<userId>:<item key>`. **Per user, not per profile** (no profile id in the key), so both profiles' adds land in one table. |
| `libraries.json` | The two libraries: Movies (`kind: movie`) and TV (`kind: tv`), both `tmdbMatch: auto`. |
| `library-items.json` | `{ source, rows: [{ lib_id, idx, payload }] }` exported from `library.sqlite` table `library_items` (ordered by lib_id, idx). `payload` is the parsed JSON item. |
| `capture.json` | User id, profile ids and names, the key each click saved under, and the result of every extra click. |

Not copied: `users.json`, `secret.json`, `settings.json`, tokens, caches, thumbnails.
Scrubbed: the rig's scratch library root is replaced by `C:\qa-lib` (in `libraries.json` paths and the
item payloads' `file`/`dir`), and any `?t=` stream or picture token by `t=REDACTED`.

Library layout (the same in all three; positions are the scan order):

| Library | idx | Row |
|---|---|---|
| Movies | 0 | Copper Lantern (2010), matched TMDB movie 9001, 301 s |
| Movies | 1 | Gol Sorkh گل سرخ [1080p], unmatched, 302 s |
| Movies | 2 | Shab Abi (2019) شب آبی, unmatched, 303 s |
| TV | 0 | show Darya دریا [1080p], unmatched |
| TV | 1-3 | Darya S01E01-03 (131-133 s) |
| TV | 4 | show Iron Harbor (2015), matched TMDB tv 9101 |
| TV | 5-7 | Iron Harbor S01E01-03 (121-123 s), episodes carry tmdbId 9101 |
| TV | 8 | show Kuh کوه [1080p], unmatched, `tvshow.nfo` title "IR - Kuh کوه [1080p]" |
| TV | 9-11 | Kuh S01E01-03 (141-143 s) |

Titles differ by version (that is part of what the fixtures show): 3.4.13 keeps "Gol Sorkh گل سرخ [1080p]",
"Darya دریا [1080p]", "Shab Abi" (no Persian) and "IR - Kuh کوه [1080p]"; 3.4.14 cleans the folder titles
but keeps "IR - Kuh کوه [1080p]" from the NFO; 3.4.15 has "Kuh کوه".

## Which row is which (same clicks in every version)

Item keys below: `M` = the Movies library id, `T` = the TV library id of that folder (see `capture.json`).

**Profile "owner"**

| watch key | Written by | Value |
|---|---|---|
| `tmdb:movie:9001` | Copper Lantern played from the library to about 42 % | 126/301, not watched |
| `local:M:1` | Gol Sorkh, same | 127/302 |
| `local:M:2` | Shab Abi, same | 127/303 |
| `local:T:5` | Iron Harbor E01 played to its end (the player then started E02 by itself) | 121/121, watched |
| `local:T:6` | Iron Harbor E02 to about 55 % | 67/122 |
| `local:T:1`, `local:T:2` | Darya E01 finished, E02 to about 55 % | 131/131 watched; 72/132 |
| `local:T:9`, `local:T:10` | Kuh E01 finished, E02 to about 55 % | 141/141 watched; 77/142 |
| `local:T:3` | **Watched tick**: Darya E03, episode ⋯ "Mark watched" | 0/0, watched |

Note that the matched show's episodes (Iron Harbor) are saved under `local:` keys, not `tmdb:tv:9101:s1eN`
(fault F-1 of result 98), in all three versions.

**Profile "Second"**

| watch key | Written by | Value |
|---|---|---|
| `local:T:5`, `local:T:1`, `local:T:9` | E01 of each show played to its end, then Back on the Up next card | watched |
| `local:T:6`, `local:T:2` | written by the page when E01 ended (its Up next prepared E02) | 0/122, 0/132 |
| `local:T:10` | Kuh E02: Up next row, then played to about 55 % | 77/142 |
| `local:M:2` | Shab Abi to about 42 % | 127/303 |
| `local:M:1` | **Watched tick**: Gol Sorkh, library card ⋯ "Mark watched" | 0/0, watched |

**Watchlist** (one table for the user)

| key | Added by |
|---|---|
| `tmdb:movie:9001` | owner, Copper Lantern card ⋯ "Add to watchlist" |
| `local:T:0` | owner, Darya show page bookmark (the ⋯ menu offers no watchlist entry for unmatched titles) |
| `tmdb:tv:9101` | Second, Iron Harbor card ⋯ "Add to watchlist" |
| `local:M:1` | Second, Gol Sorkh detail-page bookmark |
