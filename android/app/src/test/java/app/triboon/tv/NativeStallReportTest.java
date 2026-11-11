package app.triboon.tv;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

// B15B-02 (A2-1): one native stall report per full window, even when the first one was dropped.
public class NativeStallReportTest {
    private static final long WINDOW = 30000L;

    @Test
    public void firstReportGoesOut() {
        assertTrue(NativeStallReport.shouldReport(false, 0L, 50000L, WINDOW));
    }

    @Test
    public void noSecondReportInsideTheSameWindow() {
        long reportedAt = 100000L;
        assertFalse(NativeStallReport.shouldReport(true, reportedAt, reportedAt, WINDOW));
        assertFalse(NativeStallReport.shouldReport(true, reportedAt, reportedAt + WINDOW - 1, WINDOW));
    }

    @Test
    public void reportAgainAfterAFullFurtherWindow() {
        long reportedAt = 100000L;
        assertTrue(NativeStallReport.shouldReport(true, reportedAt, reportedAt + WINDOW, WINDOW));
        assertTrue(NativeStallReport.shouldReport(true, reportedAt, reportedAt + 3 * WINDOW, WINDOW));
    }

    @Test
    public void aReportFromThePlayerErrorPathCountsTooAndUnknownTimeStaysQuiet() {
        // The player-error path also stamps the time, so the watchdog waits a full window after it.
        long playerErrorAt = 200000L;
        assertFalse(NativeStallReport.shouldReport(true, playerErrorAt, playerErrorAt + 1000L, WINDOW));
        assertTrue(NativeStallReport.shouldReport(true, playerErrorAt, playerErrorAt + WINDOW, WINDOW));
        assertFalse(NativeStallReport.shouldReport(true, 0L, 999999L, WINDOW));
        assertFalse(NativeStallReport.shouldReport(true, 100L, 999999L, 0L));
    }
}
