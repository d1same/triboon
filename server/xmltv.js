'use strict';

const path = require('path');
const { Worker } = require('worker_threads');
const zlib = require('zlib');

const XMLTV_MAX_BYTES = 120 * 1024 * 1024;
const XMLTV_WORKER_CONCURRENCY = 2;
const activeWorkerJobs = new Set();
const queuedWorkerJobs = [];
let workerShutdownPromise = null;
let workerShutdownActive = false;

// Some IPTV providers expose guide.xml.gz but omit Content-Encoding, so the HTTP layer correctly
// returns compressed bytes. Detect the gzip signature ourselves and cap the EXPANDED payload too:
// a small gzip must not be able to inflate without bound before it reaches the parser worker.
function decodeXmltvPayload(payload, { maxBytes = XMLTV_MAX_BYTES } = {}) {
  const source = Buffer.isBuffer(payload) ? payload : Buffer.from(payload || '');
  if (source.length < 2 || source[0] !== 0x1f || source[1] !== 0x8b) return Promise.resolve(source);
  return new Promise((resolve, reject) => {
    zlib.gunzip(source, { maxOutputLength: maxBytes }, (err, result) => {
      if (err) return reject(new Error(`XMLTV gzip decode failed: ${err.message}`));
      resolve(result);
    });
  });
}

function parseXmltvDate(s) {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\s*([+-]\d{4}))?/.exec(String(s || ''));
  if (!m) return 0;
  const off = m[7]
    ? (parseInt(m[7].slice(0, 3), 10) * 60 + parseInt(m[7][0] + m[7].slice(3), 10)) * 60000
    : 0;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) - off;
}

function decodeXmlEntities(value) {
  return String(value || '').replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (whole, entity) => {
    const key = entity.toLowerCase();
    if (key === 'amp') return '&';
    if (key === 'lt') return '<';
    if (key === 'gt') return '>';
    if (key === 'quot') return '"';
    if (key === 'apos') return "'";
    const n = key.startsWith('#x') ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10);
    try { return Number.isInteger(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : whole; }
    catch { return whole; }
  });
}

function xmlText(value) {
  return decodeXmlEntities(String(value || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ''))
    .trim();
}

function xmlAttr(attrs, name) {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(String(attrs || ''));
  return m ? decodeXmlEntities(m[1] !== undefined ? m[1] : m[2]) : '';
}

function normChName(s) {
  return String(s || '').toLowerCase()
    .replace(/^[a-z]{2,3}\s*[:|-]\s*/, '')
    .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')
    .replace(/\b(uhd|fhd|hd|sd|4k|8k|1080p?|720p?|h26[45]|hevc|raw|vip|plus|backup)\b/g, ' ')
    .replace(/[^a-z0-9]/g, '');
}

function parseXmltv(xml, carried = [], now = Date.now()) {
  const text = Buffer.isBuffer(xml) ? xml.toString('utf8') : String(xml || '');
  const byName = new Map();
  const chRe = /<channel\b([^>]*)>([\s\S]*?)<\/channel>/gi;
  let m;
  let n = 0;
  while ((m = chRe.exec(text)) && n < 100000) {
    n++;
    const id = xmlAttr(m[1], 'id');
    if (!id) continue;
    const dnRe = /<display-name[^>]*>([\s\S]*?)<\/display-name>/gi;
    let d;
    while ((d = dnRe.exec(m[2]))) {
      const key = normChName(xmlText(d[1]));
      if (key && !byName.has(key)) byName.set(key, id);
    }
  }

  const rows = Array.isArray(carried) ? carried : [];
  const wanted = new Set();
  for (const channel of rows) {
    if (channel && channel.tvgId) wanted.add(String(channel.tvgId));
    const viaName = byName.get(normChName(channel && channel.name));
    if (viaName) wanted.add(viaName);
  }
  const filterToCarried = rows.length > 0;
  const keepFrom = now - 12 * 3600000;
  const keepTo = now + 48 * 3600000;
  const byChannel = new Map();
  const programmeRe = /<programme\b([^>]*)>([\s\S]*?)<\/programme>/gi;
  n = 0;
  while ((m = programmeRe.exec(text)) && n < 200000) {
    n++;
    const channelId = xmlAttr(m[1], 'channel');
    if (!channelId || (filterToCarried && !wanted.has(channelId))) continue;
    const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(m[2]);
    const title = xmlText(titleMatch && titleMatch[1]);
    if (!title) continue;
    const start = parseXmltvDate(xmlAttr(m[1], 'start'));
    const stop = parseXmltvDate(xmlAttr(m[1], 'stop'));
    if (!start || !stop || stop < keepFrom || start > keepTo) continue;
    if (!byChannel.has(channelId)) byChannel.set(channelId, []);
    byChannel.get(channelId).push({ start, stop, title });
  }
  for (const list of byChannel.values()) list.sort((a, b) => a.start - b.start);
  return { byChannel: [...byChannel.entries()], byName: [...byName.entries()] };
}

function xmltvCancellationError(message = 'XMLTV parse cancelled') {
  const err = new Error(message);
  err.code = 'XMLTV_CANCELLED';
  return err;
}

function cancellationReason(signal, fallback) {
  return signal && signal.reason instanceof Error ? signal.reason : xmltvCancellationError(fallback);
}

function removeAbortListener(job) {
  if (job.signal && job.onAbort) job.signal.removeEventListener('abort', job.onAbort);
  job.onAbort = null;
}

function rejectQueuedWorkerJob(job, err) {
  if (job.settled) return;
  job.settled = true;
  const idx = queuedWorkerJobs.indexOf(job);
  if (idx !== -1) queuedWorkerJobs.splice(idx, 1);
  removeAbortListener(job);
  job.reject(err);
}

function startXmltvWorkerJob(job) {
  if (job.settled) return;
  if (job.signal && job.signal.aborted) {
    rejectQueuedWorkerJob(job, cancellationReason(job.signal, 'XMLTV parse cancelled'));
    return;
  }
  job.started = true;
  let worker;
  try {
    worker = new Worker(path.join(__dirname, 'xmltv-worker.js'), {
      resourceLimits: { maxOldGenerationSizeMb: 512 },
    });
  } catch (err) {
    rejectQueuedWorkerJob(job, err);
    return;
  }
  job.worker = worker;
  activeWorkerJobs.add(job);
  let timer = null;
  const finish = (err, result) => {
    if (job.settled) return;
    job.settled = true;
    if (timer) clearTimeout(timer);
    removeAbortListener(job);
    // Keep this job in the active set until termination completes. Otherwise a timed-out worker
    // can overlap its replacement, and shutdown can miss a worker that is still being torn down.
    job.termination = worker.terminate().catch(() => {}).finally(() => {
      activeWorkerJobs.delete(job);
      drainXmltvWorkerQueue();
    });
    if (err) job.reject(err); else job.resolve(result);
  };
  job.finish = finish;
  timer = setTimeout(() => finish(new Error('XMLTV parse timed out')), job.timeoutMs);
  if (timer.unref) timer.unref();
  worker.once('message', (message) => {
    if (!message || message.ok !== true) return finish(new Error((message && message.error) || 'XMLTV worker failed'));
    finish(null, message.result);
  });
  worker.once('error', (err) => finish(err));
  worker.once('exit', (code) => {
    if (!job.settled) finish(new Error(code === 0 ? 'XMLTV worker exited without a result' : `XMLTV worker exited ${code}`));
  });
  try {
    worker.postMessage({ xml: job.payload, carried: job.carried, now: Date.now() }, [job.payload]);
  } catch (err) {
    finish(err);
  }
}

function drainXmltvWorkerQueue() {
  if (workerShutdownActive) return;
  while (activeWorkerJobs.size < XMLTV_WORKER_CONCURRENCY && queuedWorkerJobs.length) {
    const job = queuedWorkerJobs.shift();
    startXmltvWorkerJob(job);
  }
}

function parseXmltvInWorker(xml, carried = [], { timeoutMs = 45000, signal = null } = {}) {
  const source = Buffer.isBuffer(xml) ? xml : Buffer.from(xml || '');
  const payload = source.byteOffset === 0 && source.byteLength === source.buffer.byteLength
    ? source.buffer
    : source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength);
  const safeCarried = (Array.isArray(carried) ? carried : []).slice(0, 100000).map((channel) => ({
    tvgId: String((channel && channel.tvgId) || '').slice(0, 512),
    name: String((channel && channel.name) || '').slice(0, 512),
  }));
  return new Promise((resolve, reject) => {
    if (workerShutdownActive) return reject(xmltvCancellationError('XMLTV parser is shutting down'));
    if (signal && signal.aborted) return reject(cancellationReason(signal, 'XMLTV parse cancelled'));
    const requestedTimeout = Number(timeoutMs);
    const job = {
      payload,
      carried: safeCarried,
      timeoutMs: Math.max(1000, Number.isFinite(requestedTimeout) ? requestedTimeout : 45000),
      signal,
      resolve,
      reject,
      settled: false,
      started: false,
      worker: null,
      finish: null,
      termination: null,
      onAbort: null,
    };
    if (signal) {
      job.onAbort = () => {
        const err = cancellationReason(signal, 'XMLTV parse cancelled');
        if (job.started && job.finish) job.finish(err);
        else rejectQueuedWorkerJob(job, err);
      };
      signal.addEventListener('abort', job.onAbort, { once: true });
    }
    queuedWorkerJobs.push(job);
    drainXmltvWorkerQueue();
  });
}

function getXmltvWorkerState() {
  return {
    active: activeWorkerJobs.size,
    queued: queuedWorkerJobs.length,
    limit: XMLTV_WORKER_CONCURRENCY,
    shuttingDown: workerShutdownActive,
  };
}

function shutdownXmltvWorkers() {
  if (workerShutdownPromise) return workerShutdownPromise;
  workerShutdownActive = true;
  workerShutdownPromise = (async () => {
    const err = xmltvCancellationError('XMLTV parser is shutting down');
    for (const job of [...queuedWorkerJobs]) rejectQueuedWorkerJob(job, err);
    const active = [...activeWorkerJobs];
    for (const job of active) {
      if (job.finish) job.finish(err);
    }
    await Promise.allSettled(active.map((job) => job.termination));
  })().finally(() => {
    workerShutdownPromise = null;
    workerShutdownActive = false;
    drainXmltvWorkerQueue();
  });
  return workerShutdownPromise;
}

module.exports = {
  decodeXmltvPayload,
  decodeXmlEntities,
  getXmltvWorkerState,
  normChName,
  parseXmltv,
  parseXmltvDate,
  parseXmltvInWorker,
  shutdownXmltvWorkers,
};
