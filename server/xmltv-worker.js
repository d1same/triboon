'use strict';

const { parentPort } = require('worker_threads');
const { parseXmltv } = require('./xmltv');

parentPort.once('message', ({ xml, carried, now }) => {
  try {
    const result = parseXmltv(Buffer.from(xml), carried, now);
    parentPort.postMessage({ ok: true, result });
  } catch (err) {
    parentPort.postMessage({ ok: false, error: (err && err.message) || 'XMLTV parse failed' });
  }
});
