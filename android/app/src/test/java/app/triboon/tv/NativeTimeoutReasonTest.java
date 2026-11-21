package app.triboon.tv;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import androidx.media3.common.PlaybackException;
import androidx.media3.exoplayer.ExoPlaybackException;
import androidx.media3.exoplayer.ExoTimeoutException;

import org.junit.Test;

public class NativeTimeoutReasonTest {

    private static PlaybackException timeout(int operation) {
        return ExoPlaybackException.createForUnexpected(new ExoTimeoutException(operation), PlaybackException.ERROR_CODE_TIMEOUT);
    }

    @Test
    public void aTimeoutSaysWhichWaitRanOutAndWhatWasPlaying() {
        String detail = NativeTimeoutReason.describe(
                timeout(ExoTimeoutException.TIMEOUT_OPERATION_DETACH_SURFACE), "passthrough E-AC3, 6ch", true);
        assertTrue(detail, detail.startsWith("ERROR_CODE_TIMEOUT ("));
        assertTrue(detail, detail.contains("Detaching surface timed out"));
        assertTrue(detail, detail.contains("audio passthrough E-AC3, 6ch"));
        assertTrue(detail, detail.contains("text track on"));
    }

    @Test
    public void aReleaseTimeoutAndNoAudioYetAreNamedToo() {
        String detail = NativeTimeoutReason.describe(
                timeout(ExoTimeoutException.TIMEOUT_OPERATION_RELEASE), "", false);
        assertTrue(detail, detail.contains("Player release timed out"));
        assertTrue(detail, detail.contains("audio not started"));
        assertTrue(detail, detail.contains("text track off"));
    }

    @Test
    public void otherErrorsKeepTheirOwnWording() {
        PlaybackException io = new PlaybackException("io", null, PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED);
        assertNull(NativeTimeoutReason.describe(io, "passthrough E-AC3, 6ch", true));
        assertNull(NativeTimeoutReason.describe(null, "", false));
    }

    @Test
    public void aTimeoutWithNoCauseStillReadsAsATimeout() {
        PlaybackException bare = new PlaybackException(null, null, PlaybackException.ERROR_CODE_TIMEOUT);
        assertEquals("ERROR_CODE_TIMEOUT (no cause given; audio decoded on the device, 2ch; text track off)",
                NativeTimeoutReason.describe(bare, "decoded on the device, 2ch", false));
    }
}
