package app.triboon.tv;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class UpNextHandoffTest {
    @Test public void aLoaderNobodyTouchedIsClosed() {
        assertTrue(UpNextHandoff.shouldCloseStuckLoader(7, 7, 3, 3, true));
    }

    @Test public void aWebLoaderOrAHideDisarmsTheNet() {
        assertFalse(UpNextHandoff.shouldCloseStuckLoader(7, 8, 3, 3, true));
    }

    @Test public void aNewNativeStartDisarmsTheNet() {
        assertFalse(UpNextHandoff.shouldCloseStuckLoader(7, 7, 3, 4, true));
    }

    @Test public void aHiddenLoaderIsLeftAlone() {
        assertFalse(UpNextHandoff.shouldCloseStuckLoader(7, 7, 3, 3, false));
    }

    @Test public void theWindowOutlastsTheWebWatchdogs() {
        // web/index.html: PLAY_NEXT_HANDOFF_MS = 50000, PLAY_START_WATCHDOG_MS = 60000.
        assertTrue(UpNextHandoff.STUCK_LOADER_TIMEOUT_MS > 60000L);
    }

    // Review R5: the web refused the next episode after the Next button silenced the video.
    @Test public void aRefusalResumesTheSilencedEpisode() {
        assertTrue(UpNextHandoff.shouldResumeAfterRefusal(true, 42L, 42L, 3, 3));
        assertTrue("an older page sends no token", UpNextHandoff.shouldResumeAfterRefusal(true, 0L, 42L, 3, 3));
    }

    @Test public void aRefusalWithNothingSilencedOnlyShowsTheReason() {
        assertFalse(UpNextHandoff.shouldResumeAfterRefusal(true, 42L, 42L, -1, 3));
    }

    @Test public void aRefusalAfterANewStartOrForAnotherPlaybackIsIgnored() {
        assertFalse(UpNextHandoff.shouldResumeAfterRefusal(true, 42L, 42L, 3, 4));
        assertFalse(UpNextHandoff.shouldResumeAfterRefusal(true, 41L, 42L, 3, 3));
        assertFalse(UpNextHandoff.shouldResumeAfterRefusal(false, 42L, 42L, 3, 3));
    }

    @Test public void theReasonTextIsBoundedAndNeverEmpty() {
        assertEquals("No next episode", UpNextHandoff.refusalText(null));
        assertEquals("No next episode", UpNextHandoff.refusalText("   "));
        assertEquals("This episode hasn’t aired yet — airs Nov 17", UpNextHandoff.refusalText("  This episode hasn’t aired yet —\n airs Nov 17 "));
        StringBuilder longText = new StringBuilder();
        for (int i = 0; i < 400; i++) longText.append('x');
        assertEquals(UpNextHandoff.MAX_REFUSAL_TEXT, UpNextHandoff.refusalText(longText.toString()).length());
    }

    @Test public void theTokenParserFallsBackToZero() {
        assertEquals(42L, UpNextHandoff.parseToken("42"));
        assertEquals(0L, UpNextHandoff.parseToken("nope"));
        assertEquals(0L, UpNextHandoff.parseToken(null));
        assertEquals(0L, UpNextHandoff.parseToken("-5"));
    }
}
