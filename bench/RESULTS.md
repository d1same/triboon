# Provider Benchmark - Easynews (news.easynews.com:563, TLS)

Measured 2026-06-10 from the owner's machine with `bench/provider-bench.js`
and `bench/stat-followup.js`. Credentials were supplied through `NNTP_*`
environment variables and were never committed.

These numbers are historical evidence for the Phase 1 fast-start model and the
bounded health gate. They no longer define the live runtime connection policy.
Current provider capacity, multi-user read-ahead, and health scheduling are
documented in `../docs-streaming-performance.md`.

## Connection Setup

TCP + TLS + greeting + AUTHINFO:

```text
min 121ms - median 135ms - mean 173ms - max 386ms
n=6, first connection pays ~386ms, warm path ~130ms
```

## Round-Trip Latency

| Command | Min | Median | Max | Meaning |
| --- | --- | --- | --- | --- |
| DATE | 23.4ms | 23.5ms | 23.7ms | Pure network RTT baseline. |
| STAT article exists, 223 | 28ms | 61ms | 249ms | Health probe on a healthy segment. |
| STAT missing, 430 | 551ms | 560ms | 574ms | Health probe on a dead/missing segment. |

Key insight: Easynews answers STAT for existing articles in about 60ms, but
takes about 555ms to report a miss because the provider performs a deeper
backend lookup. A parallel STAT gate confirms healthy releases quickly, while a
dead release exposes itself much later. The 500ms gate budget is a soft timeout:
no verdict by 500ms means suspect, auto-advance or continue background checking.
Healthy releases, the common case, clear the gate almost instantly.

## BODY Throughput

Test scope: `alt.binaries.boneless`, random recent articles, about 8 seconds per
tier, 0 misses.

| Connections | MB/s | Mbps | MB/s per connection |
| --- | --- | --- | --- |
| 1 | 5.5 | 43.8 | 5.47 |
| 4 | 17.5 | 139.7 | 4.37 |
| 8 | 33.8 | 270.6 | 4.23 |
| 12 | 59.4 | 475.1 | 4.95 |
| 16 | 68.4 | 547.5 | 4.28 |

Near-linear scaling held through 12 connections. Around 548 Mbps at 16 likely
approached the owner's line rate, not the provider cap. Per-connection
throughput was stable around 4-5 MB/s.

## Historical Phase 1 Tuning Conclusions

- Historical pool note: 16 warm connections and 8-12 read-ahead fan-out were
  useful for the original Easynews measurement and test design. They are not the
  current runtime rule. Runtime sizing now comes from Settings -> Streaming
  performance, per-provider connection caps, startup/seek reserve, active mounts,
  and NNTP priority lanes.
- Time-to-first-frame budget: with about 750KB articles at 4-5 MB/s per
  connection, fetching the first 8 segments in parallel lands about 6MB of
  leading video in about 150-250ms after mount. A roughly 1s perceived start is
  realistic when search and triage are prefetched before Play.
- Health gate: parallel STAT checks can return in about 60-250ms when healthy;
  500ms soft timeout flags suspect releases without blocking playback.
- Seek burst: a cold seek is about 1 RTT plus the first article, comfortably
  inside the 250ms cold-seek test budget over the real provider when the segment
  map is exact.
