package app.triboon.tv;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import androidx.media3.common.ParserException;
import java.io.EOFException;
import java.io.IOException;
import java.net.SocketTimeoutException;
import org.junit.Test;

public class NativeStreamDropTest {
    @Test public void parserCrashIsBadData() {
        Throwable crash = new IllegalStateException("No valid varint length mask found");
        assertTrue(NativeStreamDrop.badData(new IOException("Unexpected loader error", crash)));
        assertTrue(NativeStreamDrop.badData(new Exception(new ArrayIndexOutOfBoundsException())));
        assertTrue(NativeStreamDrop.badData(ParserException.createForMalformedContainer("bad element", null)));
        assertTrue(NativeStreamDrop.badData(new IOException(ParserException.createForMalformedContainer("bad element", new IOException("x")))));
    }

    @Test public void aDeadLineIsNotBadData() {
        assertFalse(NativeStreamDrop.badData(new IOException(new SocketTimeoutException())));
        assertFalse(NativeStreamDrop.badData(new IOException(new EOFException())));
        assertFalse(NativeStreamDrop.badData(new IOException("closed")));
        assertFalse(NativeStreamDrop.badData(new Exception(new OutOfMemoryError())));
        assertFalse(NativeStreamDrop.badData(null));
    }
}
