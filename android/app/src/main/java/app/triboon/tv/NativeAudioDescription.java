package app.triboon.tv;

import androidx.media3.common.C;
import androidx.media3.common.Format;
import androidx.media3.common.Tracks;
import androidx.media3.common.util.UnstableApi;

import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * Audio Description (a narrator describing the picture) is never the audio a title starts with
 * (brief 121). ExoPlayer may start on one: Matroska marks it only with FlagVisualImpaired, which
 * Media3 does not read, and such a track is often also flagged default. These rules name an Audio
 * Description track and the normal track of the same language to play instead.
 */
@UnstableApi
final class NativeAudioDescription {
    private NativeAudioDescription() {}

    // Same words as isAudioDescriptionTrack in server/transcode.js and web/index.html. A bare "AD"
    // counts only as its own word ("English AD", "English (AD)"), not "Ad-free".
    private static final Pattern TITLE = Pattern.compile(
            "(?<![a-z0-9])(?:audio[ ._-]?descri(?:ption|bed|ptive)|descriptive|described[ ._-]+video"
                    + "|visual(?:ly)?[ ._-]+impaired|dvs)(?![a-z0-9])|(?<![a-z0-9-])ad(?![a-z0-9-])",
            Pattern.CASE_INSENSITIVE);

    static boolean titleSaysAudioDescription(String title) {
        return title != null && TITLE.matcher(title).find();
    }

    /** probedByServer: the server's probe of this file flagged the track (visual-impaired flag). */
    static boolean isAudioDescription(Format format, boolean probedByServer) {
        if (probedByServer) return true;
        if (format == null) return false;
        if ((format.roleFlags & C.ROLE_FLAG_DESCRIBES_VIDEO) != 0) return true;
        return titleSaysAudioDescription(format.label);
    }

    private static String lang(Format format) {
        String l = format == null || format.language == null ? "" : format.language.trim().toLowerCase(Locale.ROOT);
        if (l.equals("und")) return "";
        int dash = l.indexOf('-');
        return dash > 0 ? l.substring(0, dash) : l;
    }

    /** Whether the player has picked an audio track yet. */
    static boolean hasSelectedAudio(Tracks tracks) {
        if (tracks == null) return false;
        for (Tracks.Group group : tracks.getGroups()) {
            if (group.getType() == C.TRACK_TYPE_AUDIO && group.isSelected()) return true;
        }
        return false;
    }

    /**
     * When the selected audio is Audio Description: {groupIndex, trackIndex} of the normal track in the
     * same language to play instead (the most channels wins). Null when the selected track is normal,
     * nothing is selected yet, or Audio Description is the only track in that language.
     * probedAudioDescriptionRels: the file's audio tracks (in file order) that the server flagged.
     */
    static int[] normalInstead(Tracks tracks, Set<Integer> probedAudioDescriptionRels) {
        if (tracks == null) return null;
        List<Tracks.Group> groups = tracks.getGroups();
        int audioRel = 0;
        Format selected = null;
        boolean selectedIsAd = false;
        int[] rels = new int[groups.size()];
        for (int g = 0; g < groups.size(); g++) {
            Tracks.Group group = groups.get(g);
            rels[g] = -1;
            if (group.getType() != C.TRACK_TYPE_AUDIO) continue;
            rels[g] = audioRel++;
            for (int i = 0; i < group.length; i++) {
                if (!group.isTrackSelected(i)) continue;
                selected = group.getTrackFormat(i);
                boolean probed = group.length == 1 && probedAudioDescriptionRels != null
                        && probedAudioDescriptionRels.contains(rels[g]);
                selectedIsAd = isAudioDescription(selected, probed);
            }
        }
        if (selected == null || !selectedIsAd) return null;
        String want = lang(selected);
        int[] best = null;
        int bestChannels = -1;
        for (int g = 0; g < groups.size(); g++) {
            Tracks.Group group = groups.get(g);
            if (group.getType() != C.TRACK_TYPE_AUDIO) continue;
            for (int i = 0; i < group.length; i++) {
                if (group.isTrackSelected(i) || !group.isTrackSupported(i, true)) continue;
                Format f = group.getTrackFormat(i);
                boolean probed = group.length == 1 && probedAudioDescriptionRels != null
                        && probedAudioDescriptionRels.contains(rels[g]);
                if (isAudioDescription(f, probed) || !lang(f).equals(want)) continue;
                int channels = f.channelCount == Format.NO_VALUE ? 0 : f.channelCount;
                if (channels > bestChannels) {
                    best = new int[]{g, i};
                    bestChannels = channels;
                }
            }
        }
        return best;
    }
}
