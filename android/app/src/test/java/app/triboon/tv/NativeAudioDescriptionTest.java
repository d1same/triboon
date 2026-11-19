package app.triboon.tv;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import androidx.media3.common.C;
import androidx.media3.common.Format;
import androidx.media3.common.MimeTypes;
import androidx.media3.common.TrackGroup;
import androidx.media3.common.Tracks;

import org.junit.Test;

import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;

public class NativeAudioDescriptionTest {

    private static Tracks.Group audio(String lang, String label, int roleFlags, boolean selected) {
        Format format = new Format.Builder().setSampleMimeType(MimeTypes.AUDIO_AAC)
                .setLanguage(lang).setLabel(label).setRoleFlags(roleFlags).setChannelCount(2).build();
        return new Tracks.Group(new TrackGroup(format), false, new int[]{C.FORMAT_HANDLED}, new boolean[]{selected});
    }

    private static Tracks.Group video() {
        Format format = new Format.Builder().setSampleMimeType(MimeTypes.VIDEO_H264).build();
        return new Tracks.Group(new TrackGroup(format), false, new int[]{C.FORMAT_HANDLED}, new boolean[]{true});
    }

    @Test
    public void titlesThatMeanAudioDescription() {
        for (String t : new String[]{"English - Audio Description", "English (AD)", "English AD", "Descriptive Audio",
                "Described Video", "Visually Impaired", "DVS", "AudioDescription"}) {
            assertTrue(t, NativeAudioDescription.titleSaysAudioDescription(t));
        }
        for (String t : new String[]{"English", "", null, "Director Commentary", "Headphone Mix", "Ad-free mix", "Stereo"}) {
            assertFalse(String.valueOf(t), NativeAudioDescription.titleSaysAudioDescription(t));
        }
    }

    @Test
    public void startOnAudioDescriptionMovesToTheNormalTrack() {
        // The test MKV: track 1 "English - Audio Description" (selected, as ExoPlayer does), track 2 "English".
        Tracks tracks = new Tracks(Arrays.asList(video(),
                audio("en", "English - Audio Description", 0, true),
                audio("en", "English", 0, false)));
        assertArrayEquals(new int[]{2, 0}, NativeAudioDescription.normalInstead(tracks, Collections.emptySet()));
    }

    @Test
    public void theRoleFlagOrTheServerProbeIsEnough() {
        Tracks byRole = new Tracks(Arrays.asList(video(),
                audio("en", "English", C.ROLE_FLAG_DESCRIBES_VIDEO, true),
                audio("en", "English", 0, false)));
        assertArrayEquals(new int[]{2, 0}, NativeAudioDescription.normalInstead(byRole, Collections.emptySet()));
        // Flag only (no title): the server's probe names audio track 0 of the file.
        Tracks byProbe = new Tracks(Arrays.asList(video(),
                audio("en", "English", 0, true),
                audio("en", "English", 0, false)));
        assertArrayEquals(new int[]{2, 0}, NativeAudioDescription.normalInstead(byProbe, new HashSet<>(Collections.singletonList(0))));
        assertNull(NativeAudioDescription.normalInstead(byProbe, Collections.emptySet()));
    }

    @Test
    public void aNormalStartOrTheOnlyTrackInTheLanguageStays() {
        Tracks normal = new Tracks(Arrays.asList(video(),
                audio("en", "English", 0, true),
                audio("en", "English - Audio Description", 0, false)));
        assertNull(NativeAudioDescription.normalInstead(normal, Collections.emptySet()));
        Tracks onlyEnglishIsAd = new Tracks(Arrays.asList(video(),
                audio("fr", "Francais", 0, false),
                audio("en", "English - Audio Description", 0, true)));
        assertNull("another language is not a replacement", NativeAudioDescription.normalInstead(onlyEnglishIsAd, Collections.emptySet()));
        assertFalse(NativeAudioDescription.hasSelectedAudio(new Tracks(Collections.singletonList(audio("en", "English", 0, false)))));
    }
}
