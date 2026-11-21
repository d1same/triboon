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

    /** Delay before the next read, after `reads` re-reads, when the last line ends `aheadSeconds` ahead. */
    static long nextReadMs(int reads, double aheadSeconds) {
        if (!(aheadSeconds >= NEAR_SECONDS)) return NEAR_MS;
        return reads < FAST_READS ? FAST_MS : SLOW_MS;
    }
}
