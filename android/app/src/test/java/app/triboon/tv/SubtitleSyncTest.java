package app.triboon.tv;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

public class SubtitleSyncTest {

    @Test
    public void aSkipForwardMovesTheWordsEvenWhileTheOldClockIsStillTalking() {
        SubtitleSync.Sample sample = SubtitleSync.step(
                10 * 60 * 1000L, true, 10 * 60 * 1000L, 1000L, 1500L, 0L, 25 * 60 * 1000L, 20000L);
        assertEquals(25 * 60 * 1000L, sample.mediaMs);
        assertEquals(0L, sample.slipMs);
    }

    @Test
    public void aSkipBackMovesTheWordsToo() {
        SubtitleSync.Sample sample = SubtitleSync.step(
                40 * 60 * 1000L, true, 40 * 60 * 1000L, 1000L, 1500L, 0L, 12 * 60 * 1000L, 20000L);
        assertEquals(12 * 60 * 1000L, sample.mediaMs);
        assertEquals(0L, sample.slipMs);
    }

    @Test
    public void aBufferKeepsTheLineOnTheFrozenFrame() {
        long frame = 18 * 60 * 1000L;
        SubtitleSync.Sample sample = SubtitleSync.step(
                frame + 8000L, false, frame, 1000L, 9000L, 0L, -1L, 0L);
        assertEquals(frame, sample.mediaMs);
    }

    @Test
    public void whenPlaybackReturnsTheWaitIsNotANewMinute() {
        long frame = 18 * 60 * 1000L;
        long jumped = frame + 8000L;
        SubtitleSync.Sample sample = SubtitleSync.step(
                jumped, true, frame, 1000L, 2500L, 0L, -1L, 0L);
        assertEquals(frame, sample.mediaMs);
        assertEquals(8000L, sample.slipMs);
    }

    @Test
    public void steadyPlayFollowsThePicture() {
        SubtitleSync.Sample sample = SubtitleSync.step(
                20 * 60 * 1000L + 250L, true, 20 * 60 * 1000L, 1000L, 1250L, 0L, -1L, 0L);
        assertEquals(20 * 60 * 1000L + 250L, sample.mediaMs);
        assertEquals(0L, sample.slipMs);
    }
}
