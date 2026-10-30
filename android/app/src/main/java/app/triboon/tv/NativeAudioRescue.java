package app.triboon.tv;

import androidx.media3.common.C;
import androidx.media3.common.Format;
import androidx.media3.common.MimeTypes;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Tracks;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.common.util.Util;
import androidx.media3.exoplayer.ExoPlaybackException;

import java.util.LinkedHashSet;

/**
 * When ExoPlayer has no way to play a stream's audio it drops the audio and keeps the picture, with
 * no error. These rules name that case, and an audio failure that did stop the player.
 */
@UnstableApi
final class NativeAudioRescue {
    private NativeAudioRescue() {}

    /**
     * The stream has audio and no track of it can play. Audio turned off by the viewer still counts
     * as playable, and a video with no audio at all is not a problem.
     */
    static boolean noPlayableAudio(Tracks tracks) {
        return tracks != null
                && tracks.containsType(C.TRACK_TYPE_AUDIO)
                // true: a track past the decoder's claimed limits still gets tried by ExoPlayer.
                && !tracks.isTypeSupported(C.TRACK_TYPE_AUDIO, true);
    }

    static String unplayableAudioNames(Tracks tracks) {
        LinkedHashSet<String> names = new LinkedHashSet<>();
        if (tracks != null) {
            for (Tracks.Group group : tracks.getGroups()) {
                if (group.getType() != C.TRACK_TYPE_AUDIO) continue;
                for (int i = 0; i < group.length; i++) {
                    String mime = group.getTrackFormat(i).sampleMimeType;
                    names.add(mime == null ? "unknown" : mime);
                }
            }
        }
        return names.isEmpty() ? "unknown" : String.join(", ", names);
    }

    /** The player stopped because of its audio path, not the stream or the picture. */
    static boolean audioPipelineFailed(PlaybackException error) {
        if (error == null) return false;
        if (error.errorCode == PlaybackException.ERROR_CODE_AUDIO_TRACK_INIT_FAILED
                || error.errorCode == PlaybackException.ERROR_CODE_AUDIO_TRACK_WRITE_FAILED) return true;
        if (!(error instanceof ExoPlaybackException)) return false;
        ExoPlaybackException exo = (ExoPlaybackException) error;
        Format format = exo.rendererFormat;
        return exo.type == ExoPlaybackException.TYPE_RENDERER
                && format != null && MimeTypes.isAudio(format.sampleMimeType);
    }

    /** The saved surround setting: auto, on (trust everything HDMI reports) or off (always decode). */
    static String cleanPassthroughMode(String mode) {
        return "on".equals(mode) || "off".equals(mode) ? mode : "auto";
    }

    /** What actually reached the audio output, for the playback log. */
    static String describeOutput(int encoding, int channelConfig) {
        String channels = Integer.bitCount(channelConfig) + "ch";
        if (Util.isEncodingLinearPcm(encoding)) return "decoded on the device, " + channels;
        return "passthrough " + encodingName(encoding) + ", " + channels;
    }

    private static String encodingName(int encoding) {
        switch (encoding) {
            case C.ENCODING_AC3: return "AC3";
            case C.ENCODING_E_AC3: return "E-AC3";
            case C.ENCODING_E_AC3_JOC: return "E-AC3 Atmos";
            case C.ENCODING_DTS: return "DTS";
            case C.ENCODING_DTS_HD: return "DTS-HD";
            case C.ENCODING_DOLBY_TRUEHD: return "TrueHD";
            default: return "encoding " + encoding;
        }
    }
}
