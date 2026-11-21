package app.triboon.tv;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class NativeSideSubtitleTest {
    @Test
    public void onlyTheSideFileRouteIsReadAgain() {
        assertTrue(NativeSideSubtitle.isSideFile("http://10.0.2.2:7941/api/filesub/abc123/2?t=x&fs=abcdef12"));
        assertTrue(NativeSideSubtitle.isSideFile("/api/filesub/abc123/0"));
        assertFalse(NativeSideSubtitle.isSideFile("http://h/api/ossubs/abc123?lang=en"));
        assertFalse(NativeSideSubtitle.isSideFile("http://h/api/subtitle/abc123/2"));
        assertFalse(NativeSideSubtitle.isSideFile("http://h/api/filesub/abc123/2/extra"));
        assertFalse(NativeSideSubtitle.isSideFile(null));
    }

    @Test
    public void readsOftenWhileTheLinesEndCloseToThePicture() {
        assertEquals(1000L, NativeSideSubtitle.nextReadMs(0, 2.0));
        assertEquals(1000L, NativeSideSubtitle.nextReadMs(50, 14.9));
        assertEquals("no line yet", 1000L, NativeSideSubtitle.nextReadMs(50, Double.NaN));
    }

    @Test
    public void readsFastAtFirstThenSlowerWhenWellAhead() {
        assertEquals(3000L, NativeSideSubtitle.nextReadMs(0, 40.0));
        assertEquals(3000L, NativeSideSubtitle.nextReadMs(7, 40.0));
        assertEquals(8000L, NativeSideSubtitle.nextReadMs(8, 40.0));
        assertEquals(8000L, NativeSideSubtitle.nextReadMs(100, 15.0));
    }

    @Test
    public void reReadsCarryThePictureTime() {
        assertEquals("http://h/api/filesub/m/2?t=x&at=61", NativeSideSubtitle.withAt("http://h/api/filesub/m/2?t=x", 60.6));
        assertEquals("http://h/api/filesub/m/2?t=x&at=90", NativeSideSubtitle.withAt("http://h/api/filesub/m/2?t=x&at=61", 90.2));
        assertEquals("http://h/api/filesub/m/2?at=5&t=x".replace("?at=5&", "?") + "&at=7", NativeSideSubtitle.withAt("http://h/api/filesub/m/2?at=5&t=x", 7.0));
    }

    @Test
    public void aheadFollowsTheLinesNearThePictureNotTheEndOfTheList() {
        // Read up to 40:00, then a seek back to 10:00: lines far ahead, none near the picture.
        double[] farS = {2390, 2393, 2396}; double[] farE = {2392, 2395, 2398};
        assertTrue("nothing near the picture", Double.isNaN(NativeSideSubtitle.aheadSeconds(farS, farE, 600)));
        assertEquals(1000L, NativeSideSubtitle.nextReadMs(50, NativeSideSubtitle.aheadSeconds(farS, farE, 600)));
        double[] s = {600, 604, 608, 612, 2390}; double[] e = {602, 606, 610, 660, 2392};
        assertEquals(59.0, NativeSideSubtitle.aheadSeconds(s, e, 601), 0.001);
    }

    @Test
    public void rereadsThatKeepFailingStop() {
        assertFalse(NativeSideSubtitle.stopRereads(NativeSideSubtitle.MAX_REREAD_FAILS - 1));
        assertTrue(NativeSideSubtitle.stopRereads(NativeSideSubtitle.MAX_REREAD_FAILS));
    }
}
