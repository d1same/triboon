# Provider benchmark — Easynews (news.easynews.com:563, TLS)

Measured 2026-06-10 from the owner's machine with `bench/provider-bench.js` and
`bench/stat-followup.js` (credentials via `NNTP_*` env vars, never committed).
These numbers drive Phase 1 read-ahead and health-gate tuning.

## Connection setup (TCP + TLS + greeting + AUTHINFO)

min 121ms · median 135ms · mean 173ms · max 386ms (n=6, first connection pays ~386ms, warm path ~130ms)

## Round-trip latency

| Command | min | median | max | Meaning |
|---|---|---|---|---|
| DATE | 23.4ms | 23.5ms | 23.7ms | pure network RTT baseline |
| STAT (article exists, 223) | 28ms | 61ms | 249ms | health probe on a HEALTHY segment |
| STAT (missing, 430) | 551ms | 560ms | 574ms | health probe on a DEAD/missing segment |

**Key insight:** Easynews answers STAT for existing articles in ~60ms, but takes ~555ms to
report a miss (backend exhaustive lookup). So a parallel STAT gate confirms a healthy release
in well under 100ms, while a dead release takes ~560ms to expose. The ≤500ms gate budget should
be treated as a soft timeout: no verdict by 500ms ⇒ suspect ⇒ auto-advance / keep checking in
background. Healthy releases (the common case) clear the gate almost instantly.

## BODY throughput (alt.binaries.boneless, random recent articles, ~8s per tier, 0 misses)

| Connections | MB/s | Mbps | MB/s per conn |
|---|---|---|---|
| 1 | 5.5 | 43.8 | 5.47 |
| 4 | 17.5 | 139.7 | 4.37 |
| 8 | 33.8 | 270.6 | 4.23 |
| 12 | 59.4 | 475.1 | 4.95 |
| 16 | 68.4 | 547.5 | 4.28 |

Near-linear scaling through 12 connections; ~548 Mbps at 16 (likely approaching the line rate
of the owner's connection, not a provider cap). Per-connection throughput is stable at ~4–5 MB/s.

## Tuning conclusions for Phase 1

- **Pool**: keep 16 warm connections (setup is cheap at ~130ms but free is better); default
  read-ahead fan-out 8–12 connections, leaving headroom for triage probes.
- **Time-to-first-frame budget**: with ~750KB articles at 4–5 MB/s per conn, fetching the first
  8 segments in parallel lands ~6MB of leading video in ~150–250ms after mount. A ~1s perceived
  start is realistic when search/triage is prefetched before Play.
- **Health gate**: parallel STAT (first + last + N random) — verdict ~60–250ms when healthy;
  500ms soft timeout flags suspect releases without blocking playback.
- **Seek burst**: a cold seek = 1 RTT (~25ms) + first article (~150ms) ⇒ comfortably inside the
  250ms cold-seek test budget even over the real provider, if the segment map is exact.
