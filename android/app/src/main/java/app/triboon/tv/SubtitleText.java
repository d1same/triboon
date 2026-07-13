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

    static String lastThree(Iterable<String> texts) {
        ArrayDeque<String> active = new ArrayDeque<>(3);
        if (texts != null) for (String text : texts) {
            String clean = String.valueOf(text == null ? "" : text).trim();
            if (clean.isEmpty()) continue;
            if (active.size() == 3) active.removeFirst();
            active.addLast(clean);
        }
        StringBuilder out = new StringBuilder();
        for (String text : active) {
            if (out.length() > 0) out.append('\n');
            out.append(text);
        }
        return out.toString();
    }

    static float sizeSp(String preference) {
        return "S".equalsIgnoreCase(preference) ? 20f
                : ("L".equalsIgnoreCase(preference) ? 32f : 25f);
    }
}
