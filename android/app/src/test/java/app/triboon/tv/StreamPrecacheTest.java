package app.triboon.tv;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

public class StreamPrecacheTest {

    @Test
    public void directStreamKeysDropTheRotatingToken() {
        // Prepare-time and play-time tokens differ; the key must not.
        assertEquals("http://s/api/stream/abc", StreamPrecache.cacheKey("http://s/api/stream/abc?t=token1"));
        assertEquals("http://s/api/stream/abc", StreamPrecache.cacheKey("http://s/api/stream/abc?t=token2"));
    }

    @Test
    public void nonDirectUrlsKeepTheirFullUrlAsKey() {
        // A remux URL's query carries the START POSITION — two spawns must never share a key,
        // even if a wrapper is ever mis-applied to a non-direct source.
        assertEquals("http://s/api/remux/abc?start=10&t=x", StreamPrecache.cacheKey("http://s/api/remux/abc?start=10&t=x"));
        assertEquals("http://s/api/remux/abc?start=99&t=x", StreamPrecache.cacheKey("http://s/api/remux/abc?start=99&t=x"));
    }

    @Test
    public void stripQueryHandlesUrlsWithoutQueries() {
        assertEquals("http://s/api/stream/abc", StreamPrecache.stripQuery("http://s/api/stream/abc"));
    }
}
