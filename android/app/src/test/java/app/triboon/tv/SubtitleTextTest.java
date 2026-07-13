package app.triboon.tv;

import static org.junit.Assert.assertEquals;

import java.util.Arrays;
import org.junit.Test;

public class SubtitleTextTest {
    @Test public void lineBreakTagsBecomeRealLinesBeforeMarkupIsRemoved() {
        assertEquals("First line\nSecond & final",
                SubtitleText.cleanCueText("<i>First line</i><BR />Second &amp; final"));
    }

    @Test public void onlyTheLastThreeOverlappingCueTextsAreRendered() {
        assertEquals("two\nthree\nfour", SubtitleText.lastThree(Arrays.asList("one", "two", "three", "four")));
    }

    @Test public void captionSizePreferenceMapsToNativeSp() {
        assertEquals(20f, SubtitleText.sizeSp("S"), 0f);
        assertEquals(20f, SubtitleText.sizeSp("s"), 0f);
        assertEquals(25f, SubtitleText.sizeSp("M"), 0f);
        assertEquals(32f, SubtitleText.sizeSp("L"), 0f);
        assertEquals(32f, SubtitleText.sizeSp("l"), 0f);
        assertEquals(25f, SubtitleText.sizeSp(null), 0f);
        assertEquals(25f, SubtitleText.sizeSp("unexpected"), 0f);
    }
}
