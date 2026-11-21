package app.triboon.tv;

/**
 * Brief 143: the file's own subtitle on the remux/transcode comes from the server's side file
 * (/api/filesub), which grows while the remux reads ahead. The overlay reads it again: often while
 * the lines on hand end close to the picture (a remux that runs only a few seconds ahead writes the
 * next line just in time), then on a short clock at first, then a slower one.
 */
final class NativeSideSubtitle {
    private NativeSideSubtitle() {}

    static final int FAST_READS = 8;
    static final long NEAR_MS = 1000L;
    static final long FAST_MS = 3000L;
    static final long SLOW_MS = 8000L;
    static final double NEAR_SECONDS = 15.0;

    static boolean isSideFile(String url) {
        if (url == null) return false;
        int q = url.indexOf('?');
        String path = q < 0 ? url : url.substring(0, q);
        return path.matches("^(?:https?://[^/]+)?/api/filesub/\\w+/\\d+$");
    }

    /** The same address with the picture time, so the server can read a local file ahead of it. */
    static String withAt(String url, double seconds) {
        if (url == null) return "";
        String base = url.replaceAll("([?&])at=[^&]*&?", "$1").replaceAll("[?&]$", "");
        long at = Math.max(0L, Math.round(seconds));
        return base + (base.indexOf('?') < 0 ? "?" : "&") + "at=" + at;
    }

    /** Consecutive failed re-reads after which the chain stops (a mount gone, an expired token). */
    static final int MAX_REREAD_FAILS = 30;

    static boolean stopRereads(int consecutiveFails) {
        return consecutiveFails >= MAX_REREAD_FAILS;
    }

    /**
     * How far the lines on hand run on from the picture: a run of lines with no gap over 30 s, NaN when
     * none reaches the picture. The end of the whole list is no measure after a seek back (second check
     * 3.5.7): lines far ahead, none here, and the reads slowed to every 8 s exactly where lines were missing.
     */
    static double aheadSeconds(double[] starts, double[] ends, double now) {
        double end = now;
        boolean found = false;
        int n = Math.min(starts == null ? 0 : starts.length, ends == null ? 0 : ends.length);
        for (int i = 0; i < n; i++) {
            if (!(ends[i] >= now)) continue;
            if (starts[i] - end > 30.0) break;
            end = Math.max(end, ends[i]);
            found = true;
        }
        return found ? end - now : Double.NaN;
    }

    /** Delay before the next read, after `reads` re-reads, when the last line ends `aheadSeconds` ahead. */
    static long nextReadMs(int reads, double aheadSeconds) {
        if (!(aheadSeconds >= NEAR_SECONDS)) return NEAR_MS;
        return reads < FAST_READS ? FAST_MS : SLOW_MS;
    }
}
