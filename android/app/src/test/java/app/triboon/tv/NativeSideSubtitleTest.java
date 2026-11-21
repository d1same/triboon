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
    public void readsFastAtFirstThenSlower() {
        assertEquals(3000L, NativeSideSubtitle.nextReadMs(0));
        assertEquals(3000L, NativeSideSubtitle.nextReadMs(7));
        assertEquals(8000L, NativeSideSubtitle.nextReadMs(8));
        assertEquals(8000L, NativeSideSubtitle.nextReadMs(100));
    }
}
