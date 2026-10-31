package app.triboon.tv;

import androidx.media3.common.ParserException;
import androidx.media3.common.util.UnstableApi;

@UnstableApi
final class NativeStreamDrop {
    private NativeStreamDrop() {}

    // A dead line surfaces as an IOException. Only bytes ExoPlayer could not read cause a ParserException
    // (which is also an IOException), or a crash inside its parser that it files under the same IO code
    // (The Good Doctor S07E05, 34:15: "No valid varint length mask found", six reconnects onto the same
    // byte). Reconnecting cannot fix those.
    static boolean badData(Throwable error) {
        Throwable root = error;
        while (root != null) {
            if (root instanceof ParserException) return true;
            if (root.getCause() == null || root.getCause() == root) break;
            root = root.getCause();
        }
        return root instanceof RuntimeException;
    }
}
