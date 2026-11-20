package app.triboon.tv;

import androidx.media3.common.C;
import androidx.media3.common.Format;
import androidx.media3.common.Tracks;

import java.util.List;
import java.util.Locale;

/**
 * Brief 137 step 4: show a subtitle that is inside the file with ExoPlayer's own text renderer.
 * The web names the track by its place among the file's subtitle tracks (ffprobe s:N) plus the
 * language and codec it expects. This finds that track among ExoPlayer's text tracks, in file order,
 * skipping side-loaded online subtitles, and checks language and codec. Any doubt returns null so the
 * caller falls back to an online subtitle instead of showing a neighbouring track.
 */
final class NativeFileSubtitle {
    private NativeFileSubtitle() {}

    static final class Pick {
        final Tracks.Group group;
        final int track;

        Pick(Tracks.Group group, int track) {
            this.group = group;
            this.track = track;
        }
    }

    /** The ffprobe codec name as the MIME types ExoPlayer may report for it. */
    static String[] mimesFor(String codec) {
        String c = codec == null ? "" : codec.trim().toLowerCase(Locale.US);
        switch (c) {
            case "subrip": case "srt": return new String[]{"application/x-subrip"};
            case "ass": case "ssa": return new String[]{"text/x-ssa"};
            case "webvtt": return new String[]{"text/vtt"};
            case "hdmv_pgs_subtitle": case "pgs": return new String[]{"application/pgs"};
            case "dvd_subtitle": case "vobsub": return new String[]{"application/vobsub"};
            case "dvb_subtitle": return new String[]{"application/dvbsubs"};
            case "mov_text": return new String[]{"application/x-quicktime-tx3g"};
            case "text": return new String[]{"application/x-subrip", "text/plain"};
            default: return new String[0];
        }
    }

    /** True when the format carries that codec, raw or already parsed into cues (Media3 1.4+). */
    static boolean codecMatches(Format f, String codec) {
        String[] want = mimesFor(codec);
        if (want.length == 0 || f == null) return false;
        String sample = f.sampleMimeType == null ? "" : f.sampleMimeType;
        String codecs = f.codecs == null ? "" : f.codecs;
        for (String m : want) {
            if (m.equalsIgnoreCase(sample) || m.equalsIgnoreCase(codecs)) return true;
        }
        return false;
    }

    static boolean sideLoaded(Format f, List<String> sideLoadedLabels) {
        if (f == null || f.label == null || sideLoadedLabels == null) return false;
        String label = f.label.toLowerCase(Locale.US);
        if (label.contains("wyzie")) return true;
        for (String s : sideLoadedLabels) {
            if (s != null && !s.isEmpty() && label.contains(s.toLowerCase(Locale.US))) return true;
        }
        return false;
    }

    static Pick find(List<Tracks.Group> groups, int ordinal, String lang, String codec, List<String> sideLoadedLabels) {
        if (groups == null || ordinal < 0) return null;
        int seen = 0;
        for (Tracks.Group group : groups) {
            if (group == null || group.getType() != C.TRACK_TYPE_TEXT) continue;
            for (int i = 0; i < group.length; i++) {
                Format f = group.getTrackFormat(i);
                if (sideLoaded(f, sideLoadedLabels)) continue;
                if (seen++ != ordinal) continue;
                if (!NativeAudioRows.sameLang(lang, f.language)) return null;
                if (!codecMatches(f, codec)) return null;
                if (!group.isTrackSupported(i)) return null;
                return new Pick(group, i);
            }
        }
        return null;
    }
}
