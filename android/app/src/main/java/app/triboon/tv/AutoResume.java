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

    /** A quiet rebuild of the same movie must not forget a pause. */
    public static boolean keepPauseOnQuietRemount(long userPausedAtMs, boolean quietReuse) {
        return quietReuse && userPausedAtMs > 0L;
    }

    /** A dropped line may start the picture again only when nobody pressed pause. */
    public static boolean mayReconnectWhilePaused(long userPausedAtMs) {
        return userPausedAtMs <= 0L;
    }
}
