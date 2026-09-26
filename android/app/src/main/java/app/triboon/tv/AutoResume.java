package app.triboon.tv;

/**
 * A quiet remount and a percent resume both start with play held off, then
 * press Play when the picture is ready. Pause during that wait must stay paused.
 */
public final class AutoResume {
    private AutoResume() {}

    /** True when nobody has pressed pause, so the held picture may start. */
    public static boolean shouldStartHeldPlayback(long userPausedAtMs) {
        return userPausedAtMs <= 0L;
    }
}
