package app.triboon.tv;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

public class ProgressiveSeekTest {

    @Test
    public void rapidSameDirectionPressesAccelerateWithACap() {
        ProgressiveSeek ps = new ProgressiveSeek();
        long now = 1000;
        // x1 x1 x2 x3 x4 ... the same curve the web player ships.
        assertEquals(30000, ps.step(30000, now));
        assertEquals(30000, ps.step(30000, now += 100));
        assertEquals(60000, ps.step(30000, now += 100));
        assertEquals(90000, ps.step(30000, now += 100));
        assertEquals(120000, ps.step(30000, now += 100));
        // Ride the streak to the cap: multipliers keep growing to x8, never beyond.
        for (int i = 0; i < 10; i++) ps.step(30000, now += 100);
        assertEquals(30000 * ProgressiveSeek.CAP, ps.step(30000, now += 100));
    }

    @Test
    public void directionFlipResetsToBaseStep() {
        ProgressiveSeek ps = new ProgressiveSeek();
        long now = 1000;
        ps.step(30000, now);
        ps.step(30000, now += 100);
        ps.step(30000, now += 100); // x2 by now
        assertEquals(-10000, ps.step(-10000, now += 100)); // flip -> back to x1
    }

    @Test
    public void pausingLongerThanTheWindowResets() {
        ProgressiveSeek ps = new ProgressiveSeek();
        long now = 1000;
        ps.step(30000, now);
        ps.step(30000, now += 100);
        ps.step(30000, now += 100); // accelerated
        assertEquals(30000, ps.step(30000, now + ProgressiveSeek.WINDOW_MS + 1)); // settled -> x1
    }

    @Test
    public void resetClearsTheStreakLikeANewPlayback() {
        ProgressiveSeek ps = new ProgressiveSeek();
        long now = 1000;
        ps.step(30000, now);
        ps.step(30000, now += 100);
        ps.step(30000, now += 100);
        ps.reset();
        assertEquals(30000, ps.step(30000, now += 100));
    }
}
