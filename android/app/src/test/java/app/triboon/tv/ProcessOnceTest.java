package app.triboon.tv;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.fail;

import org.junit.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicInteger;

// B15B-01 (A2-2): the stream precache must exist once per process. A second Activity in the same
// process (Back twice, reopen) asked for a second SimpleCache on the same folder, which Media3
// refuses, so direct play fell back to remux until the process died.
public class ProcessOnceTest {
    @Test
    public void twoActivitiesShareOneInstance() {
        ProcessOnce<Object> holder = new ProcessOnce<>();
        AtomicInteger built = new AtomicInteger();
        Object first = holder.get(() -> { built.incrementAndGet(); return new Object(); });
        Object second = holder.get(() -> { built.incrementAndGet(); return new Object(); });
        assertSame(first, second);
        assertEquals(1, built.get());
    }

    @Test
    public void concurrentCallersBuildItOnce() throws Exception {
        ProcessOnce<Object> holder = new ProcessOnce<>();
        AtomicInteger built = new AtomicInteger();
        CountDownLatch go = new CountDownLatch(1);
        List<Thread> threads = new ArrayList<>();
        Object[] seen = new Object[8];
        for (int i = 0; i < seen.length; i++) {
            final int slot = i;
            Thread t = new Thread(() -> {
                try { go.await(); } catch (InterruptedException ignored) { }
                seen[slot] = holder.get(() -> {
                    built.incrementAndGet();
                    try { Thread.sleep(20); } catch (InterruptedException ignored) { }
                    return new Object();
                });
            });
            threads.add(t);
            t.start();
        }
        go.countDown();
        for (Thread t : threads) t.join(5000);
        assertEquals(1, built.get());
        for (Object o : seen) assertSame(seen[0], o);
    }

    @Test
    public void aFailedBuildIsNotRememberedAndCanBeRetried() {
        ProcessOnce<Object> holder = new ProcessOnce<>();
        try {
            holder.get(() -> { throw new IllegalStateException("disk full"); });
            fail("the factory failure reaches the caller");
        } catch (IllegalStateException expected) {
            assertEquals("disk full", expected.getMessage());
        }
        Object ok = new Object();
        assertSame(ok, holder.get(() -> ok));
        assertSame(ok, holder.get(() -> new Object()));
    }
}
