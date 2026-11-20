package app.triboon.tv;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertSame;

import androidx.media3.common.C;
import androidx.media3.common.Format;
import androidx.media3.common.MimeTypes;
import androidx.media3.common.TrackGroup;
import androidx.media3.common.Tracks;

import org.junit.Test;

import java.util.Arrays;
import java.util.Collections;
import java.util.List;

public class NativeFileSubtitleTest {

    private static Tracks.Group text(String mime, String codecs, String lang, String label, boolean supported) {
        Format f = new Format.Builder().setSampleMimeType(mime).setCodecs(codecs).setLanguage(lang).setLabel(label).build();
        return new Tracks.Group(new TrackGroup(f), false,
                new int[]{supported ? C.FORMAT_HANDLED : C.FORMAT_UNSUPPORTED_SUBTYPE}, new boolean[]{false});
    }

    private static Tracks.Group video() {
        Format f = new Format.Builder().setSampleMimeType(MimeTypes.VIDEO_H264).build();
        return new Tracks.Group(new TrackGroup(f), false, new int[]{C.FORMAT_HANDLED}, new boolean[]{true});
    }

    private static final String CUES = "application/x-media3-cues";

    private static List<Tracks.Group> file() {
        return Arrays.asList(video(),
                text(CUES, "application/x-subrip", "en", null, true),        // s:0 forced English
                text(CUES, "application/x-subrip", "en", null, true),        // s:1 English
                text(MimeTypes.APPLICATION_PGS, null, "en", null, true),     // s:2 English picture
                text(CUES, "text/x-ssa", "ja", null, true),                  // s:3 Japanese ASS
                text(CUES, "text/vtt", "en", "English · Wyzie", true));     // side-loaded online row
    }

    @Test
    public void findsTheTrackByFileOrderAndChecksLanguageAndCodec() {
        List<Tracks.Group> g = file();
        NativeFileSubtitle.Pick p = NativeFileSubtitle.find(g, 1, "eng", "subrip", Collections.emptyList());
        assertNotNull(p);
        assertSame(g.get(2), p.group);
        assertEquals(0, p.track);
        assertSame(g.get(3), NativeFileSubtitle.find(g, 2, "eng", "hdmv_pgs_subtitle", Collections.emptyList()).group);
        assertSame(g.get(4), NativeFileSubtitle.find(g, 3, "jpn", "ass", Collections.emptyList()).group);
    }

    @Test
    public void anyDoubtIsNullSoTheWebFallsBackOnline() {
        List<Tracks.Group> g = file();
        assertNull("wrong language", NativeFileSubtitle.find(g, 1, "fre", "subrip", Collections.emptyList()));
        assertNull("wrong codec", NativeFileSubtitle.find(g, 1, "eng", "hdmv_pgs_subtitle", Collections.emptyList()));
        assertNull("no such track: the side-loaded row is never counted", NativeFileSubtitle.find(g, 4, "eng", "webvtt", Collections.emptyList()));
        assertNull("unknown codec", NativeFileSubtitle.find(g, 0, "eng", "eia_608", Collections.emptyList()));
        List<Tracks.Group> unsupported = Arrays.asList(text(MimeTypes.APPLICATION_PGS, null, "en", null, false));
        assertNull("a track this box cannot render", NativeFileSubtitle.find(unsupported, 0, "eng", "hdmv_pgs_subtitle", Collections.emptyList()));
    }
}
