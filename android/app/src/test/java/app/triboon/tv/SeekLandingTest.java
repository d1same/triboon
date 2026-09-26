package app.triboon.tv;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class SeekLandingTest {

    @Test
    public void aBigSkipBackIsNotAGlitchWhileTheOldClockIsStillTalking() {
        long target = 10 * 60 * 1000L;
        long oldClock = 40 * 60 * 1000L;
        assertTrue(SeekLanding.ignoreStaleClock(target, oldClock, 1000L, 20000L, false));
    }

    @Test
    public void aBigSkipForwardIsNotAGlitchEither() {
        long target = 50 * 60 * 1000L;
        long oldClock = 40 * 60 * 1000L;
        assertTrue(SeekLanding.ignoreStaleClock(target, oldClock, 1000L, 20000L, false));
    }

    @Test
    public void onceTheNewMinuteIsPlayingTheGuardStepsAside() {
        long target = 10 * 60 * 1000L;
        assertFalse(SeekLanding.ignoreStaleClock(target, target + 500L, 5000L, 20000L, true));
    }

    @Test
    public void afterTheWaitARealRestartCanStillRecover() {
        assertFalse(SeekLanding.ignoreStaleClock(10 * 60 * 1000L, 40 * 60 * 1000L, 25000L, 20000L, false));
    }
}
