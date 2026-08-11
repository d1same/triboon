package app.triboon.tv;

// Progressive D-pad seek math, shared shape with the web player's nudgeSeek: rapid same-direction
// seek presses grow the step x1 x1 x2 x3 ... capped x8; a pause longer than WINDOW_MS or a
// direction flip resets to x1. A ten-minute jump becomes a short burst instead of twenty presses.
// Kept player-agnostic (no clock, no player reference) so unit tests cover the exact curve the
// remote produces.
final class ProgressiveSeek {
    static final long WINDOW_MS = 700;
    static final long CAP = 8;

    private long streak = 0;
    private int lastDir = 0;
    private long lastAtMs = 0;

    // Returns the accelerated delta for this press. nowMs must be monotonic (uptimeMillis).
    long step(long deltaMs, long nowMs) {
        int dir = deltaMs > 0 ? 1 : -1;
        streak = (dir == lastDir && nowMs - lastAtMs < WINDOW_MS) ? streak + 1 : 0;
        lastDir = dir;
        lastAtMs = nowMs;
        return deltaMs * Math.min(CAP, Math.max(1, streak));
    }

    void reset() {
        streak = 0;
        lastDir = 0;
        lastAtMs = 0;
    }
}
