package app.triboon.tv;

/**
 * Brief 143: the file's own subtitle on the remux/transcode comes from the server's side file
 * (/api/filesub), which grows while the remux reads ahead. The overlay reads it again on a short
 * clock at first (the opening lines), then a slower one.
 */
final class NativeSideSubtitle {
    private NativeSideSubtitle() {}

    static final int FAST_READS = 8;
    static final long FAST_MS = 3000L;
    static final long SLOW_MS = 8000L;

    static boolean isSideFile(String url) {
        if (url == null) return false;
        int q = url.indexOf('?');
        String path = q < 0 ? url : url.substring(0, q);
        return path.matches("^(?:https?://[^/]+)?/api/filesub/\\w+/\\d+$");
    }

    /** Delay before the next read, after `reads` re-reads so far. */
    static long nextReadMs(int reads) {
        return reads < FAST_READS ? FAST_MS : SLOW_MS;
    }
}
