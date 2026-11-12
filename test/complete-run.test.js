'use strict';
// The npm test guard: a run whose results from any test file were cut short must fail, not pass
// with a smaller count. Background: on Linux, --test-force-exit could end a fast file's child
// with its results still queued in stdout (test/support/blocking-stdio.js has the details).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { findIncompleteFiles } = require('./support/complete-run-reporter');

const root = path.join(__dirname, '..');

function fileEvents(file, { summary = true } = {}) {
  const events = [
    { type: 'test:enqueue', data: { file, nesting: 0 } },
    { type: 'test:start', data: { file, nesting: 0 } },
    { type: 'test:pass', data: { file, nesting: 0 } },
  ];
  if (summary) events.push({ type: 'test:summary', data: { file, counts: { tests: 1 } } });
  return events;
}

test('complete run guard: every file that sent its own summary is complete', () => {
  const events = [
    ...fileEvents('/repo/test/a.test.js'),
    ...fileEvents('/repo/test/b.test.js'),
    { type: 'test:plan', data: { nesting: 0, count: 2 } },
    { type: 'test:summary', data: { file: undefined, counts: { tests: 2 } } },
  ];
  assert.deepEqual(findIncompleteFiles(events), []);
});

test('complete run guard: output lines tagged with the relative path belong to the same file', () => {
  const abs = path.join(root, 'test', 'search-widen.test.js');
  const events = [
    { type: 'test:stderr', data: { file: path.join('test', 'search-widen.test.js'), message: 'log line' } },
    ...fileEvents(abs),
  ];
  const prev = process.cwd();
  process.chdir(root);
  try {
    assert.deepEqual(findIncompleteFiles(events), []);
  } finally {
    process.chdir(prev);
  }
});

test('complete run guard: a file whose stream stopped before its summary is named', () => {
  const events = [
    ...fileEvents('/repo/test/a.test.js'),
    ...fileEvents('/repo/test/title-collision-cases.test.js', { summary: false }),
    ...fileEvents('/repo/test/tmdb.test.js'),
    { type: 'test:summary', data: { file: undefined, counts: { tests: 3 } } },
  ];
  assert.deepEqual(findIncompleteFiles(events), [path.resolve('/repo/test/title-collision-cases.test.js')]);
});

test('complete run guard: npm test fails when a test file ends before all of its results arrive', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-complete-run-'));
  try {
    const cut = path.join(dir, 'cut-short.test.js');
    const whole = path.join(dir, 'whole.test.js');
    // Exit 0 mid-file: the same shape as a child whose last results were dropped.
    fs.writeFileSync(cut, [
      "const { test } = require('node:test');",
      "test('first', () => {});",
      "test('second leaves early', () => { process.exit(0); });",
      "test('third never reports', () => {});",
    ].join('\n'));
    fs.writeFileSync(whole, "require('node:test').test('fine', () => {});\n");
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT; // run a real top-level runner, not a child of this one
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    // The same runner flags npm test uses, minus the explicit suite list.
    const words = pkg.scripts.test.split(/\s+/);
    assert.equal(words[0], 'node');
    const flags = words.slice(1, words.findIndex((word) => word.endsWith('.test.js')))
      .filter((word) => !word.startsWith('--test-concurrency'));
    const run = (files) => spawnSync(process.execPath, [...flags, ...files], { cwd: root, env, encoding: 'utf8', timeout: 60000 });

    const bad = run([cut, whole]);
    assert.equal(bad.status, 1, `a cut-short file must fail the run\n${bad.stdout}\n${bad.stderr}`);
    assert.match(bad.stderr, /incomplete test run/);
    assert.ok(bad.stderr.includes(cut), 'the cut-short file is named');
    assert.ok(!bad.stderr.includes(whole), 'a complete file is not named');

    const good = run([whole]);
    assert.equal(good.status, 0, `a complete run still passes\n${good.stdout}\n${good.stderr}`);
    assert.doesNotMatch(good.stderr, /incomplete test run/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
