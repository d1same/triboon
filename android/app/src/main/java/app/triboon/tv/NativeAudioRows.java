package app.triboon.tv;

import androidx.media3.common.C;
import androidx.media3.common.Format;
import androidx.media3.common.Tracks;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Brief 137 step 3: one audio menu on every app. On direct play ExoPlayer keeps its own track list,
 * and the web sends one probe row per audio track ("English · TrueHD 7.1 · Atmos", or "... · plays as
 * 5.1 AAC" for a track this box cannot play as it is). This pairs each row with ExoPlayer's track by
 * file order, and checks language and channel count on the way. Any doubt means no pairing at all:
 * the menu then keeps ExoPlayer's own labels, exactly as before.
 */
final class NativeAudioRows {
    private NativeAudioRows() {}

    static final class Row {
        final int index;
        final String lang;
        final int channels;
        final String label;
        final boolean needsRemux;

        Row(int index, String lang, int channels, String label, boolean needsRemux) {
            this.index = index;
            this.lang = lang == null ? "" : lang;
            this.channels = channels;
            this.label = label == null ? "" : label;
            this.needsRemux = needsRemux;
        }
    }

    static final class Entry {
        final Tracks.Group group;
        final int track;
        final Row row;
        final boolean supported;
        final boolean selected;

        Entry(Tracks.Group group, int track, Row row, boolean supported, boolean selected) {
            this.group = group;
            this.track = track;
            this.row = row;
            this.supported = supported;
            this.selected = selected;
        }
    }

    // Matroska stores ISO 639-2 codes, some in the bibliographic form; ExoPlayer may hand back 639-1.
    private static final Map<String, String> BIBLIOGRAPHIC = new HashMap<>();
    static {
        String[][] pairs = {
            {"ger", "deu"}, {"fre", "fra"}, {"chi", "zho"}, {"dut", "nld"}, {"cze", "ces"}, {"gre", "ell"},
            {"per", "fas"}, {"rum", "ron"}, {"slo", "slk"}, {"ice", "isl"}, {"mac", "mkd"}, {"may", "msa"},
            {"arm", "hye"}, {"baq", "eus"}, {"alb", "sqi"}, {"bur", "mya"}, {"geo", "kat"}, {"tib", "bod"},
            {"wel", "cym"},
        };
        for (String[] p : pairs) BIBLIOGRAPHIC.put(p[0], p[1]);
    }

    static String langKey(String lang) {
        if (lang == null) return "";
        String l = lang.trim().toLowerCase(Locale.US);
        int cut = l.indexOf('-');
        if (cut > 0) l = l.substring(0, cut);
        if (l.isEmpty() || "und".equals(l) || "mul".equals(l) || "zxx".equals(l)) return "";
        if (BIBLIOGRAPHIC.containsKey(l)) return BIBLIOGRAPHIC.get(l);
        if (l.length() == 3) return l;
        try {
            String iso3 = new Locale(l).getISO3Language();
            return iso3 == null || iso3.isEmpty() ? l : iso3.toLowerCase(Locale.US);
        } catch (Exception e) {
            return l;
        }
    }

    static boolean sameLang(String a, String b) {
        String ka = langKey(a);
        String kb = langKey(b);
        return ka.isEmpty() || kb.isEmpty() || ka.equals(kb);
    }

    /** Pairs every ExoPlayer audio track with its row, in file order, or returns null. */
    static List<Entry> pair(List<Tracks.Group> groups, List<Row> rows) {
        if (groups == null || rows == null || rows.isEmpty()) return null;
        List<Entry> out = new ArrayList<>();
        int ordinal = 0;
        for (Tracks.Group group : groups) {
            if (group == null || group.getType() != C.TRACK_TYPE_AUDIO) continue;
            for (int i = 0; i < group.length; i++) {
                if (ordinal >= rows.size()) return null;
                Row row = rows.get(ordinal++);
                Format f = group.getTrackFormat(i);
                if (!sameLang(row.lang, f.language)) return null;
                if (row.channels > 0 && f.channelCount > 0 && row.channels != f.channelCount) return null;
                out.add(new Entry(group, i, row, group.isTrackSupported(i), group.isTrackSelected(i)));
            }
        }
        return ordinal == rows.size() ? out : null;
    }
}
