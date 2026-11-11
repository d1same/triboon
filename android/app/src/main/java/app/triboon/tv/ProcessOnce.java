package app.triboon.tv;

// B15B-01 (A2-2): a value built once per process, shared by every Activity of that process.
// Pure Java so the JVM tests cover it. A failed build is not remembered: the next caller retries.
final class ProcessOnce<T> {
    interface Factory<T> {
        T create();
    }

    private T value;

    synchronized T get(Factory<T> factory) {
        if (value == null) value = factory.create();
        return value;
    }
}
