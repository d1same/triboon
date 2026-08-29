# VOD remount playbook

Pause, seek, and a wifi blip must not feel like a new Play. A 4K rebuild is a ~30s spinner. A new source hunt is worse. This file is the lock so those do not come back.

Example: you pause The Rookie for a minute, press Play, and sit on Preparing. That is a rebuild. The fix is: keep the same ExoPlayer.

## What the user may see

| What they see | What actually happened | Allowed? |
| --- | --- | --- |
| Instant Play after pause | `nativePlayer.play()` | Yes. Required for a live buffer. |
| Short buffer, same file | In-place retry or quiet same-URL remount | Yes, after a real drop while playing, or remux/transcode pause whose pipe is already dead |
| ~30s Preparing, same file | `releaseNativePlayer` + new `ExoPlayer.Builder` | No, except first Play or a new episode |
| "Finding source" / new filename | `autoAdvance` / new NZB | Only if health says the current release is dead, or the user picks Sources |
| Sources empty / "too many attempts" | 60s route throttle | Different bug. Wait one minute. |

## Triggers that must NOT rebuild ExoPlayer

1. User pause / resume (`toggleVideo`, Play button, media key).
2. First OK that only opens chrome. That press must not click Play.
3. IO / HTTP abort while `playWhenReady` is false.
4. `STATE_ENDED` while paused.
5. Stall watchdog while paused.
6. `recoverSamePlaybackSource` while `nativePaused` and the source is not dead.
7. `notifyNativeVideoError` must not `releaseNativePlayer`. A quiet remount needs the live player.
8. After playback has started, an error must not show the circling Preparing loader. Resume uses `resumeNativeVideoInPlace` (play, or prepare+seek if IDLE/ENDED). Remux/transcode Play after pause remounts the same file quietly (`requestNativeVideoSeek`) — leftover buffer still looks healthy and must not be played. Multiple Play presses must not rebuild.

## Triggers that MAY remount the same file (quiet)

- Recoverable IO while **playing** (direct: `retryNativeDirectInPlace`; remux/transcode: `__tvNativeVideoSeek` + `quietSeek`).
- User Play on remux/transcode after pause. Same file, last frame held, no Preparing. Leftover remux/transcode buffer is a dead ffmpeg pipe.
- User seek on remux/transcode (`start=` URL).
- Quality / audio change that needs a new server stream.
- Mid-title remux `ENDED` while **playing**.
- Remux jumped backward (stream replayed from the head) — seek back to the last good time.
- Session/mount `404` / server restart (`reMountAndResume`) — wait for `/api/server`, hold the last frame, same title, new mount, resume. Do not replay the dead URL (that flickers Preparing).

Reuse the existing ExoPlayer (`reuseQuietVideo` / same playback token + same URL). Do not `new ExoPlayer.Builder`.

## Triggers that MAY change source

- Health `blocked` (missing usenet articles, not a slow pipe).
- User picked another row in Sources.

Never change the episode. Never search indexers again for a pause.

## How to test (now and later)

Device: TV emulator `emulator-5554`. Use the living-room Shield only when the owner asks.

On a playing 1080p or 4K title, watch logcat for:

```
ExoPlayerImpl: Release
ExoPlayerImpl: Init
Native VOD buffer profile
```

A second `Init` / `buffer profile` during pause, resume, or a 10s seek is a failure.

Manual matrix (each row: same filename, no Finding-source):

1. Pause 5s, Play. Instant.
2. Pause 60s, Play. Instant or a short buffer. No Release+Init.
3. First OK opens chrome only. Second OK pauses.
4. Seek +30s / -30s. Same file.
5. Leave it playing 2 minutes. Same file.
6. Hop to another title. New file is OK; leftover toast must clear.

Automated lock: `test/phase4.test.js` (`VOD pause resume` and `VOD remount playbook`).

## Do not reintroduce

- `releaseNativePlayer` inside `notifyNativeVideoError`.
- `schedulePauseWarmAhead` on native (it steals sockets from ExoPlayer).
- Treating pause as a stall (`updateNativeVideoWatchdog` must return when `!playWhenReady`).
- First OK clicking Play (`nativeIgnoreNextPlayClick`).

Code: `MainActivity.java` (`startNativePlayback`, `onPlayerError`, `STATE_ENDED`, `notifyNativeVideoError`, `resumeNativeVideoInPlace`, `retryNativeDirectInPlace`, `handleNativeSurfaceKey`, `updateNativeVideoWatchdog`); `web/index.html` `recoverSamePlaybackSource`, `togglePlay`. Contract: `docs-player-regression-map.md` P5.
