'use strict';
// `npm test` reporter that fails the run when any test file's results did not fully arrive.
//
// Each test file runs in a child process that streams its events to the runner. The child's last
// event is its own test:summary (data.file = that file). If the stream is cut short (a child that
// exits with output still queued, see test/support/blocking-stdio.js, or one that calls
// process.exit mid-file), the runner still exits 0 and simply counts fewer tests. That summary
// is the one event that proves the whole stream arrived, so every file that started must have one.
//
// It writes nothing on a complete run; on an incomplete one it names each file and sets a
// non-zero exit code, which the runner keeps through --test-force-exit.

const path = require('node:path');

function findIncompleteFiles(events) {
  const started = new Set();
  const summarized = new Set();
  for (const event of events) {
    const raw = event && event.data && event.data.file;
    if (!raw) continue;
    // The runner tags a file's stdout/stderr lines with its relative path; the child uses the
    // absolute one. Both name the same file.
    const file = path.resolve(raw);
    if (event.type === 'test:summary') summarized.add(file);
    else started.add(file);
  }
  return [...started].filter((file) => !summarized.has(file)).sort();
}

async function* completeRunReporter(source) {
  const events = [];
  for await (const event of source) {
    const data = event && event.data;
    if (data && data.file) events.push({ type: event.type, data: { file: data.file } });
  }
  const incomplete = findIncompleteFiles(events);
  if (!incomplete.length) return;
  process.exitCode = 1;
  yield '\n✖ incomplete test run: these files ended before all of their results arrived, so the\n'
    + '  test count above is short and this run proves nothing about the missing tests:\n';
  for (const file of incomplete) yield `  - ${file}\n`;
}

module.exports = completeRunReporter;
module.exports.findIncompleteFiles = findIncompleteFiles;
