'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const zlib = require('zlib');
const {
  decodeXmltvPayload, getXmltvWorkerState, parseXmltv, parseXmltvInWorker, shutdownXmltvWorkers,
} = require('../server/xmltv');

function xmltvStamp(ms) {
  const d = new Date(ms);
  const n = (value) => String(value).padStart(2, '0');
  return `${d.getUTCFullYear()}${n(d.getUTCMonth() + 1)}${n(d.getUTCDate())}${n(d.getUTCHours())}${n(d.getUTCMinutes())}${n(d.getUTCSeconds())} +0000`;
}

test('XMLTV parser decodes entities and keeps only carried channels', () => {
  const now = Date.UTC(2026, 6, 13, 12, 0, 0);
  const start = xmltvStamp(now - 60000);
  const stop = xmltvStamp(now + 3600000);
  const xml = `<?xml version="1.0"?><tv>
    <channel id="news"><display-name>News &amp; Weather</display-name></channel>
    <channel id='other'><display-name>Other</display-name></channel>
    <programme channel="news" start="${start}" stop="${stop}"><title>Tom &amp; Jerry &#x1F4FA;</title></programme>
    <programme channel="other" start="${start}" stop="${stop}"><title>Must not leak into the cache</title></programme>
  </tv>`;
  const parsed = parseXmltv(xml, [{ name: 'News & Weather HD' }], now);
  const byChannel = new Map(parsed.byChannel);
  assert.deepStrictEqual([...byChannel.keys()], ['news']);
  assert.strictEqual(byChannel.get('news')[0].title, 'Tom & Jerry 📺');
});

test('XMLTV payload decoding recognizes headerless gzip and enforces an expanded-size cap', async () => {
  const xml = Buffer.from('<tv><channel id="news"><display-name>News</display-name></channel></tv>');
  assert.deepStrictEqual(await decodeXmltvPayload(zlib.gzipSync(xml)), xml,
    'a .xml.gz body is decoded even when the provider omitted Content-Encoding');
  await assert.rejects(() => decodeXmltvPayload(zlib.gzipSync(Buffer.alloc(4096)), { maxBytes: 1024 }),
    /gzip decode failed|larger than|too large/i, 'the decompressed guide is bounded, not only its wire size');
  await assert.rejects(() => decodeXmltvPayload(Buffer.from([0x1f, 0x8b, 0, 1, 2, 3])), /gzip decode failed/i,
    'a corrupt gzip guide fails explicitly instead of silently producing an empty schedule');
});

test('large XMLTV parsing runs in a worker without blocking the HTTP event loop', async () => {
  const now = Date.now();
  const start = xmltvStamp(now - 60000);
  const stop = xmltvStamp(now + 3600000);
  const programme = `<programme channel="news" start="${start}" stop="${stop}"><title>News &amp; Weather</title></programme>`;
  const xml = Buffer.from(`<tv><channel id="news"><display-name>News</display-name></channel>${programme.repeat(25000)}</tv>`);
  let ticks = 0;
  const ticker = setInterval(() => { ticks++; }, 2);
  try {
    const parsed = await parseXmltvInWorker(xml, [{ tvgId: 'news', name: 'News' }], { timeoutMs: 30000 });
    const rows = new Map(parsed.byChannel).get('news');
    assert.strictEqual(rows.length, 25000);
    assert.ok(ticks >= 2, `main event loop stayed responsive while worker parsed (${ticks} ticks)`);
  } finally {
    clearInterval(ticker);
    await shutdownXmltvWorkers();
  }
});

test('XMLTV parsing globally bounds workers and shutdown drains active and queued jobs', async () => {
  const now = Date.now();
  const start = xmltvStamp(now - 60000);
  const stop = xmltvStamp(now + 3600000);
  const programme = `<programme channel="news" start="${start}" stop="${stop}"><title>Queued News</title></programme>`;
  const makeGuide = () => Buffer.from(`<tv><channel id="news"><display-name>News</display-name></channel>${programme.repeat(12000)}</tv>`);
  const jobs = Array.from({ length: 3 }, () =>
    parseXmltvInWorker(makeGuide(), [{ tvgId: 'news', name: 'News' }], { timeoutMs: 30000 }));
  const outcomesPromise = Promise.allSettled(jobs);
  const busy = getXmltvWorkerState();
  assert.deepStrictEqual({ active: busy.active, queued: busy.queued, limit: busy.limit },
    { active: 2, queued: 1, limit: 2 }, 'a third distinct guide waits instead of creating another 512 MB worker');

  await shutdownXmltvWorkers();
  const outcomes = await outcomesPromise;
  assert.ok(outcomes.every((outcome) => outcome.status === 'rejected' && outcome.reason.code === 'XMLTV_CANCELLED'),
    'shutdown rejects both active and queued parser jobs with a cancellation error');
  assert.deepStrictEqual(getXmltvWorkerState(), { active: 0, queued: 0, limit: 2, shuttingDown: false });

  // The module is shared by sequential in-process server boots. A completed shutdown must leave the
  // worker service reusable for the next server instance, while each old server guards its own jobs.
  const parsed = await parseXmltvInWorker(Buffer.from('<tv><channel id="next"><display-name>Next</display-name></channel></tv>'));
  assert.strictEqual(new Map(parsed.byName).get('next'), 'next');
  await shutdownXmltvWorkers();
});
