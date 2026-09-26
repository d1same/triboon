package app.triboon.tv;

/**
 * A finger on the seek bar is not a broken stream. The old clock keeps
 * talking until the new minute is actually playing.
 */
public final class SeekLanding {
    public static final long ARRIVE_MS = 3000L;

    private SeekLanding() {}

    /** True while the old clock must not yank playback back to where it was. */
    public static boolean ignoreStaleClock(long targetMs, long reportedMs, long nowMs, long untilMs, boolean arrived) {
        if (targetMs < 0L) return false;
        if (nowMs > untilMs) return false;
        if (arrived && Math.abs(reportedMs - targetMs) <= ARRIVE_MS) return false;
        return true;
    }
}
