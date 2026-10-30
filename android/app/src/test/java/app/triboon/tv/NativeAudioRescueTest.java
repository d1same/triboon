package app.triboon.tv;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import androidx.media3.common.C;
import androidx.media3.common.Format;
import androidx.media3.common.MimeTypes;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.TrackGroup;
import androidx.media3.common.Tracks;

import org.junit.Test;

import java.util.Arrays;
import java.util.Collections;

public class NativeAudioRescueTest {

    private static Tracks.Group group(String mime, int support, boolean selected) {
        Format format = new Format.Builder().setSampleMimeType(mime).build();
        return new Tracks.Group(new TrackGroup(format), false, new int[]{support}, new boolean[]{selected});
    }

    @Test
    public void audioNothingCanPlayIsTheSilentCase() {
        Tracks tracks = new Tracks(Arrays.asList(
                group(MimeTypes.VIDEO_H265, C.FORMAT_HANDLED, true),
                group(MimeTypes.AUDIO_TRUEHD, C.FORMAT_UNSUPPORTED_SUBTYPE, false)));
        assertTrue(NativeAudioRescue.noPlayableAudio(tracks));
        assertEquals(MimeTypes.AUDIO_TRUEHD, NativeAudioRescue.unplayableAudioNames(tracks));
    }

    @Test
    public void oneOfManyPlayableTracksIsEnough() {
        Tracks tracks = new Tracks(Arrays.asList(
                group(MimeTypes.AUDIO_TRUEHD, C.FORMAT_UNSUPPORTED_SUBTYPE, false),
                group(MimeTypes.AUDIO_AC3, C.FORMAT_HANDLED, true)));
        assertFalse(NativeAudioRescue.noPlayableAudio(tracks));
    }

    @Test
    public void audioTurnedOffByTheViewerIsNotAProblem() {
        Tracks tracks = new Tracks(Collections.singletonList(group(MimeTypes.AUDIO_AAC, C.FORMAT_HANDLED, false)));
        assertFalse(NativeAudioRescue.noPlayableAudio(tracks));
    }

    @Test
    public void aTrackPastDecoderLimitsStillGetsItsTry() {
        Tracks tracks = new Tracks(Collections.singletonList(
                group(MimeTypes.AUDIO_E_AC3, C.FORMAT_EXCEEDS_CAPABILITIES, true)));
        assertFalse(NativeAudioRescue.noPlayableAudio(tracks));
    }

    @Test
    public void aVideoWithNoAudioIsNotAProblem() {
        Tracks tracks = new Tracks(Collections.singletonList(group(MimeTypes.VIDEO_H264, C.FORMAT_HANDLED, true)));
        assertFalse(NativeAudioRescue.noPlayableAudio(tracks));
        assertFalse(NativeAudioRescue.noPlayableAudio(Tracks.EMPTY));
    }

    @Test
    public void audioOutputFailuresCountAndStreamFailuresDoNot() {
        assertTrue(NativeAudioRescue.audioPipelineFailed(
                new PlaybackException("sink", null, PlaybackException.ERROR_CODE_AUDIO_TRACK_INIT_FAILED)));
        assertTrue(NativeAudioRescue.audioPipelineFailed(
                new PlaybackException("sink", null, PlaybackException.ERROR_CODE_AUDIO_TRACK_WRITE_FAILED)));
        assertFalse(NativeAudioRescue.audioPipelineFailed(
                new PlaybackException("net", null, PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED)));
        assertFalse(NativeAudioRescue.audioPipelineFailed(null));
    }

    @Test
    public void anUnknownSurroundSettingFallsBackToAuto() {
        assertEquals("on", NativeAudioRescue.cleanPassthroughMode("on"));
        assertEquals("off", NativeAudioRescue.cleanPassthroughMode("off"));
        assertEquals("auto", NativeAudioRescue.cleanPassthroughMode("auto"));
        assertEquals("auto", NativeAudioRescue.cleanPassthroughMode("anything"));
        assertEquals("auto", NativeAudioRescue.cleanPassthroughMode(null));
    }

    @Test
    public void theLogSaysWhetherTheDeviceDecodedOrPassedThrough() {
        assertEquals("decoded on the device, 6ch",
                NativeAudioRescue.describeOutput(C.ENCODING_PCM_16BIT, 0xFC));
        assertEquals("passthrough E-AC3 Atmos, 8ch",
                NativeAudioRescue.describeOutput(C.ENCODING_E_AC3_JOC, 0x18FC));
    }
}
