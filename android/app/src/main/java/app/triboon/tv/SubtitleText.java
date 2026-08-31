package app.triboon.tv;

import java.util.ArrayDeque;

/** Pure subtitle text rules shared by the native overlay and local JVM tests. */
final class SubtitleText {
    private SubtitleText() {}

    static String cleanCueText(String raw) {
        return String.valueOf(raw == null ? "" : raw)
                .replaceAll("(?i)<br\\s*/?>", "\n")
                .replaceAll("<[^>]+>", "")
                .replace("&nbsp;", " ")
                .replace("&amp;", "&")
                .replace("&lt;", "<")
                .replace("&gt;", ">")
                .replace("&quot;", "\"")
                .replace("&apos;", "'")
                .trim();
    }

    // TV captions are usually 2 lines. Overlapping SDH cues plus setMaxLines(3) used to
    // clip the last sentence on 4K. Cap visual lines, not cue count, so a 4-line cue
    // still paints and a stack of karaoke cues cannot fill the screen.
    static final int MAX_OVERLAY_LINES = 5;

    static String lastLines(Iterable<String> texts) {
        return lastLines(texts, MAX_OVERLAY_LINES);
    }

    static String lastLines(Iterable<String> texts, int maxLines) {
        int cap = maxLines < 1 ? 1 : maxLines;
        ArrayDeque<String> lines = new ArrayDeque<>(cap);
        if (texts != null) for (String text : texts) {
            for (String part : String.valueOf(text == null ? "" : text).split("\\n", -1)) {
                String clean = part.trim();
                if (clean.isEmpty()) continue;
                if (lines.size() == cap) lines.removeFirst();
                lines.addLast(clean);
            }
        }
        StringBuilder out = new StringBuilder();
        for (String line : lines) {
            if (out.length() > 0) out.append('\n');
            out.append(line);
        }
        return out.toString();
    }

    static float sizeSp(String preference) {
        return "S".equalsIgnoreCase(preference) ? 20f
                : ("L".equalsIgnoreCase(preference) ? 32f : 25f);
    }
}
