package app.triboon.tv;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class AutoResumeTest {

    @Test
    public void aHeldStartMayPlayWhenNobodyPaused() {
        assertTrue(AutoResume.shouldStartHeldPlayback(0L));
    }

    @Test
    public void pauseDuringTheOpeningWaitStaysPaused() {
        assertFalse(AutoResume.shouldStartHeldPlayback(1_500L));
    }

    @Test
    public void aQuietRemountKeepsThePause() {
        assertTrue(AutoResume.keepPauseOnQuietRemount(1_500L, true));
        assertFalse(AutoResume.keepPauseOnQuietRemount(0L, true));
        assertFalse(AutoResume.keepPauseOnQuietRemount(1_500L, false));
    }

    @Test
    public void aDroppedLineDoesNotStartAPausedMovie() {
        assertFalse(AutoResume.mayReconnectWhilePaused(1_500L));
        assertTrue(AutoResume.mayReconnectWhilePaused(0L));
    }
}
