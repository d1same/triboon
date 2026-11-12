'use strict';
// Loaded by `npm test` (--require) in the runner and in every test-file child process.
//
// Why: each test file runs in its own child, which streams its results to the runner through a
// pipe. With --test-force-exit the child calls process.exit() as soon as its reporter has handed
// the last bytes to process.stdout. On Linux a pipe write is asynchronous once the pipe is full,
// so a fast file (title-collision-cases: about 100 tests in a few ms) can still have tens of KB
// queued in stdout at that moment; process.exit() drops them and the runner silently reports
// fewer tests with exit code 0 (proven 2026-11-11: short runs exited with 5-65 KB queued).
// Blocking stdio makes every write finish before the call returns, so nothing is left to drop.
// Windows pipes are already synchronous, which is why Windows always reported every test.
//
// _handle.setBlocking is a private but long-stable Node API (mocha uses the same call). If it
// ever disappears, test/support/complete-run-reporter.js still fails a run that comes up short.
for (const stream of [process.stdout, process.stderr]) {
  const handle = stream && stream._handle;
  if (handle && typeof handle.setBlocking === 'function') {
    try { handle.setBlocking(true); } catch { /* a file or TTY handle needs no help */ }
  }
}
