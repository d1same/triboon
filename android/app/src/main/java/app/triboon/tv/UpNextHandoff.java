package app.triboon.tv;

// Up Next play: the shell stops the old episode and shows its loader BEFORE the web call. If the web
// then refuses the next episode without a word (an unaired episode on an older server, or any other
// early return), nothing ever replaces that loader and it sits over a stopped video. This safety net
// closes it the way Back does, but only when nothing has touched the loader and no new native
// playback started since. The window is longer than the web's own next-episode handoff (50 s) and
// play-start (60 s) watchdogs, so a slow but healthy handoff is always left to the web.
final class UpNextHandoff {
    static final long STUCK_LOADER_TIMEOUT_MS = 75000L;

    private UpNextHandoff() {}

    static boolean shouldCloseStuckLoader(int armedLoaderToken, int currentLoaderToken,
            int armedStartSeq, int currentStartSeq, boolean loaderVisible) {
        if (!loaderVisible) return false;
        if (armedLoaderToken != currentLoaderToken) return false; // the web showed or hid a loader since
        return armedStartSeq == currentStartSeq; // no new native playback started since
    }

    // Review R5: the web refused the next episode (a finale, or the next one has not aired) after
    // the Next button or the Up Next card silenced the video. Resume that episode only when this
    // shell silenced it for a handoff (armedStartSeq >= 0), no new native playback started since,
    // and the refusal is for this playback (an older page sends token 0).
    static final int MAX_REFUSAL_TEXT = 140;

    static boolean shouldResumeAfterRefusal(boolean videoOpen, long refusedToken, long currentToken,
            int armedStartSeq, int currentStartSeq) {
        if (!videoOpen || armedStartSeq < 0 || armedStartSeq != currentStartSeq) return false;
        return refusedToken == 0L || refusedToken == currentToken;
    }

    static String refusalText(String message) {
        String text = message == null ? "" : message.replaceAll("\\s+", " ").trim();
        if (text.isEmpty()) return "No next episode";
        return text.length() > MAX_REFUSAL_TEXT ? text.substring(0, MAX_REFUSAL_TEXT) : text;
    }

    static long parseToken(String token) {
        try {
            long v = Long.parseLong(token == null ? "" : token.trim());
            return v > 0L ? v : 0L;
        } catch (NumberFormatException e) {
            return 0L;
        }
    }
}
