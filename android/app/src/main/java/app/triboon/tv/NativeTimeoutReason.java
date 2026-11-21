package app.triboon.tv;

import androidx.media3.common.PlaybackException;
import androidx.media3.common.util.UnstableApi;

/**
 * ERROR_CODE_TIMEOUT is one code for several different waits that ran out (a surface that would not
 * let go, a player that would not release, a stuck-player check). The error name alone left the
 * playback log unable to tell them apart, so the reason names the wait and what was playing.
 * The text starts with the error name, which the web page matches on.
 */
@UnstableApi
final class NativeTimeoutReason {
    private NativeTimeoutReason() {}

    /** Null for any error that is not a timeout. {@code audioOutput} is describeOutput's text, or empty. */
    static String describe(PlaybackException error, String audioOutput, boolean textTrackOn) {
        if (error == null || error.errorCode != PlaybackException.ERROR_CODE_TIMEOUT) return null;
        String cause = null;
        for (Throwable t = error.getCause(); t != null && cause == null; t = t.getCause()) {
            String m = t.getMessage();
            if (m != null && !m.trim().isEmpty()) cause = m.trim();
            if (t.getCause() == t) break;
        }
        String audio = audioOutput == null || audioOutput.isEmpty() ? "audio not started" : "audio " + audioOutput;
        return "ERROR_CODE_TIMEOUT (" + (cause == null ? "no cause given" : cause) + "; " + audio
                + "; text track " + (textTrackOn ? "on" : "off") + ")";
    }
}
