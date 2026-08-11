package app.triboon.tv;

import android.content.Context;
import android.net.Uri;
import android.util.Log;

import androidx.media3.common.util.UnstableApi;
import androidx.media3.database.StandaloneDatabaseProvider;
import androidx.media3.datasource.DataSource;
import androidx.media3.datasource.DataSpec;
import androidx.media3.datasource.DefaultHttpDataSource;
import androidx.media3.datasource.cache.CacheDataSource;
import androidx.media3.datasource.cache.CacheKeyFactory;
import androidx.media3.datasource.cache.CacheWriter;
import androidx.media3.datasource.cache.LeastRecentlyUsedCacheEvictor;
import androidx.media3.datasource.cache.SimpleCache;

import java.io.File;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

// Byte pre-cache for prepared DIRECT-PLAY streams: when the server's /api/prepare offers a
// prefetch target (detail page open, Up Next near-end), the opening bytes are written into a
// small on-disk LRU so press-play buffers its first seconds from local storage instead of the
// network. Direct play only — remux/transcode output is a fresh ffmpeg pipe per spawn and can
// never be cache-keyed. Stream tokens rotate per mint (?t=...), so /api/stream/ URLs are keyed
// WITHOUT their query: bytes cached under the prepare-time token hit under the play-time token.
@UnstableApi
final class StreamPrecache {
    private static final String TAG = "TriboonTV";
    static final long MAX_CACHE_BYTES = 100L * 1024 * 1024;

    // Query-stripped key ONLY for direct streams; any other URL keeps its full URL as the key, so
    // an accidental wrap of a remux/HLS source can never collide two different start positions.
    static String cacheKey(String url) {
        String noQuery = stripQuery(url);
        return noQuery.contains("/api/stream/") ? noQuery : url;
    }

    static String stripQuery(String url) {
        int q = url.indexOf('?');
        return q >= 0 ? url.substring(0, q) : url;
    }

    static final CacheKeyFactory KEY_FACTORY = (DataSpec spec) -> cacheKey(spec.uri.toString());

    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private final SimpleCache cache;
    private final DefaultHttpDataSource.Factory upstream;
    private Future<?> job;

    StreamPrecache(Context context, String userAgent) {
        this.cache = new SimpleCache(
                new File(context.getCacheDir(), "precache"),
                new LeastRecentlyUsedCacheEvictor(MAX_CACHE_BYTES),
                new StandaloneDatabaseProvider(context));
        this.upstream = new DefaultHttpDataSource.Factory()
                .setAllowCrossProtocolRedirects(false)
                .setUserAgent(userAgent)
                .setConnectTimeoutMs(12000)
                .setReadTimeoutMs(20000);
    }

    // Playback read path: cache hits serve the pre-cached opening bytes, everything else streams
    // from the network WITHOUT writing (no double disk IO under a 4K stream), and any cache-layer
    // error falls back to the plain upstream.
    DataSource.Factory readOnlyDataSourceFactory(DataSource.Factory playbackUpstream) {
        return new CacheDataSource.Factory()
                .setCache(cache)
                .setCacheKeyFactory(KEY_FACTORY)
                .setUpstreamDataSourceFactory(playbackUpstream)
                .setCacheWriteDataSinkFactory(null)
                .setFlags(CacheDataSource.FLAG_IGNORE_CACHE_ON_ERROR);
    }

    // Fetch [0, budgetBytes) of the stream into the cache. One job at a time: a newer prefetch
    // (focus moved to another title) interrupts the old one. Best-effort — failures only log.
    synchronized void prefetch(String url, long budgetBytes) {
        if (budgetBytes <= 0) return;
        if (job != null) job.cancel(true);
        job = executor.submit(() -> {
            try {
                DataSpec spec = new DataSpec.Builder()
                        .setUri(Uri.parse(url))
                        .setPosition(0)
                        .setLength(budgetBytes)
                        .setFlags(DataSpec.FLAG_ALLOW_CACHE_FRAGMENTATION)
                        .build();
                CacheDataSource writeThrough = new CacheDataSource.Factory()
                        .setCache(cache)
                        .setCacheKeyFactory(KEY_FACTORY)
                        .setUpstreamDataSourceFactory(upstream)
                        .createDataSource();
                new CacheWriter(writeThrough, spec, null, null).cache();
                Log.i(TAG, "Precache complete: " + budgetBytes + "B for " + cacheKey(url));
            } catch (Exception e) {
                // Interrupt (superseded prefetch) and network hiccups land here; playback is unaffected.
                Log.w(TAG, "Precache stopped: " + (e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage()));
            }
        });
    }
}
