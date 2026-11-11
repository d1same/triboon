package app.triboon.tv;

// B15B-02 (A2-1): the native error report to the web player is one-shot per start. If the web
// dropped that report (a quiet remount was pending) and the new stream never played, the shell
// never reported again: endless spinner, no switch, no panel. The stall watchdog may send one
// more report per full stall window. Pure Java so the JVM tests cover it.
final class NativeStallReport {
    private NativeStallReport() {}

    // notified: the one-shot report already went out for this start. lastReportAtMs: when it went
    // out (elapsedRealtime), 0 when unknown. Unknown stays conservative: no second report.
    static boolean shouldReport(boolean notified, long lastReportAtMs, long nowMs, long windowMs) {
        if (!notified) return true;
        return lastReportAtMs > 0L && windowMs > 0L && nowMs - lastReportAtMs >= windowMs;
    }
}
