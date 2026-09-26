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
}
