package app.triboon.tv;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import androidx.media3.common.C;
import androidx.media3.common.Format;
import androidx.media3.common.MimeTypes;
import androidx.media3.common.TrackGroup;
import androidx.media3.common.Tracks;

import org.junit.Test;

import java.util.Arrays;
import java.util.List;

public class NativeAudioRowsTest {

    private static Tracks.Group audio(String mime, String lang, int channels, boolean supported, boolean selected) {
        Format format = new Format.Builder().setSampleMimeType(mime)
                .setLanguage(lang).setChannelCount(channels).build();
        return new Tracks.Group(new TrackGroup(format), false,
                new int[]{supported ? C.FORMAT_HANDLED : C.FORMAT_UNSUPPORTED_SUBTYPE}, new boolean[]{selected});
    }

    private static Tracks.Group video() {
        Format format = new Format.Builder().setSampleMimeType(MimeTypes.VIDEO_H264).build();
        return new Tracks.Group(new TrackGroup(format), false, new int[]{C.FORMAT_HANDLED}, new boolean[]{true});
    }

    private static NativeAudioRows.Row row(int index, String lang, int channels, String label, boolean needsRemux) {
        return new NativeAudioRows.Row(index, lang, channels, label, needsRemux);
    }

    @Test
    public void truehdAndAc3FilePairsBothRowsAndKeepsTheUnplayableOne() {
        List<Tracks.Group> groups = Arrays.asList(video(),
                audio(MimeTypes.AUDIO_TRUEHD, "en", 8, false, false),
                audio(MimeTypes.AUDIO_AC3, "en", 6, true, true));
        List<NativeAudioRows.Entry> out = NativeAudioRows.pair(groups, Arrays.asList(
                row(0, "eng", 8, "English · TrueHD 7.1 · Atmos · plays as 5.1 AAC", true),
                row(1, "eng", 6, "English · Dolby Digital 5.1", false)));
        assertNotNull(out);
        assertEquals(2, out.size());
        assertFalse(out.get(0).supported);
        assertTrue(out.get(0).row.needsRemux);
        assertEquals("English · TrueHD 7.1 · Atmos · plays as 5.1 AAC", out.get(0).row.label);
        assertTrue(out.get(1).supported);
        assertTrue(out.get(1).selected);
        assertEquals(0, out.get(1).track);
    }

    @Test
    public void anyDoubtKeepsExoLabels() {
        List<Tracks.Group> groups = Arrays.asList(audio(MimeTypes.AUDIO_E_AC3, "en", 6, true, true),
                audio(MimeTypes.AUDIO_AC3, "fr", 6, true, false));
        // Wrong language order.
        assertNull(NativeAudioRows.pair(groups, Arrays.asList(row(0, "fre", 6, "French", false), row(1, "eng", 6, "English", false))));
        // Wrong channel count.
        assertNull(NativeAudioRows.pair(groups, Arrays.asList(row(0, "eng", 2, "English", false), row(1, "fre", 6, "French", false))));
        // A row missing.
        assertNull(NativeAudioRows.pair(groups, Arrays.asList(row(0, "eng", 6, "English", false))));
        // A row too many.
        assertNull(NativeAudioRows.pair(groups, Arrays.asList(row(0, "eng", 6, "a", false), row(1, "fre", 6, "b", false), row(2, "ger", 2, "c", false))));
        assertNotNull(NativeAudioRows.pair(groups, Arrays.asList(row(0, "eng", 6, "English", false), row(1, "fre", 6, "French", false))));
    }

    @Test
    public void aOneTrackFileStillGetsTheSharedLabel() {
        List<Tracks.Group> one = Arrays.asList(video(), audio(MimeTypes.AUDIO_E_AC3, "en", 6, true, true));
        List<NativeAudioRows.Entry> out = NativeAudioRows.pair(one, Arrays.asList(row(0, "eng", 6, "English · Dolby Digital Plus 5.1 · Atmos", false)));
        assertNotNull(out);
        assertEquals("English · Dolby Digital Plus 5.1 · Atmos", out.get(0).row.label);
        assertNull(NativeAudioRows.pair(one, java.util.Collections.<NativeAudioRows.Row>emptyList()));
    }

    @Test
    public void languageCodesCompareAcrossTheirForms() {
        assertTrue(NativeAudioRows.sameLang("eng", "en"));
        assertTrue(NativeAudioRows.sameLang("ger", "de"));
        assertTrue(NativeAudioRows.sameLang("fre", "fra"));
        assertTrue(NativeAudioRows.sameLang("und", "ko"));
        assertTrue(NativeAudioRows.sameLang("", "ja"));
        assertFalse(NativeAudioRows.sameLang("eng", "fr"));
        assertFalse(NativeAudioRows.sameLang("kor", "ja"));
    }
}
