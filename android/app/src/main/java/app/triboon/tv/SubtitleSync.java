package app.triboon.tv;

/**
 * Captions follow a skip, and they stay with the frame during a buffer.
 * A stall makes the player clock jump by the wait. That jump is not a new minute.
 */
public final class SubtitleSync {
    private SubtitleSync() {}

    public static final class Sample {
        public final long mediaMs;
        public final long shownMs;
        public final long slipMs;

        public Sample(long mediaMs, long shownMs, long slipMs) {
            this.mediaMs = mediaMs;
            this.shownMs = shownMs;
            this.slipMs = slipMs;
        }
    }

    public static Sample step(
            long liveMs,
            boolean moving,
            long shownMs,
            long shownWallMs,
            long nowMs,
            long slipMs,
            long seekTargetMs,
            long seekUntilMs) {
        if (seekTargetMs >= 0L && nowMs <= seekUntilMs) {
            long at = Math.max(0L, seekTargetMs);
            return new Sample(at, at, 0L);
        }
        if (shownMs < 0L) shownMs = Math.max(0L, liveMs);
        if (!moving) {
            return new Sample(Math.max(0L, shownMs - slipMs), shownMs, slipMs);
        }
        if (shownWallMs > 0L && liveMs - shownMs > 2000L) {
            long wall = Math.max(0L, nowMs - shownWallMs);
            long jump = liveMs - shownMs;
            if (Math.abs(jump - wall) < 2000L || jump > wall + 1500L) slipMs += jump;
        }
        return new Sample(Math.max(0L, liveMs - slipMs), liveMs, slipMs);
    }
}
