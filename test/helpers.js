'use strict';
// Shared HTTP test helpers: JSON requests with bearer tokens, server bootstrap with a fresh
// data dir, and the setup→login flow every authenticated test needs.

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

function httpJson(port, method, p, body, token) {
  return new Promise((resolve, reject) => {
    const headers = { 'content-type': 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(raw); } catch { /* non-json */ }
        resolve({ status: res.statusCode, json, raw, headers: res.headers });
      });
    });
    req.on('error', reject);
    // Only POST/PUT/PATCH carry a body (matches real clients); GET/HEAD/DELETE never do.
    const send = (!/^(POST|PUT|PATCH)$/.test(method) || body == null)
      ? undefined : (typeof body === 'string' ? body : JSON.stringify(body));
    req.end(send);
  });
}

function httpRaw(port, p, { range, method = 'GET', token } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (range) headers.Range = range;
    if (token) headers.authorization = `Bearer ${token}`;
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

// Boot a fresh server module with an isolated data dir. Returns { server, shutdown, port, ... }.
async function bootServer(env = {}) {
  const { TRIBOON_DATA, ...restEnv } = env;
  process.env.TRIBOON_DATA = TRIBOON_DATA || fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-data-'));
  for (const [k, v] of Object.entries(restEnv)) {
    if (v === null) delete process.env[k]; else process.env[k] = String(v);
  }
  delete require.cache[require.resolve('../server/index.js')];
  const mod = require('../server/index.js');
  await new Promise((r) => mod.server.listen(0, '127.0.0.1', r));
  return { ...mod, port: mod.server.address().port };
}

// First-run setup → returns an admin token.
async function setupAdmin(port, name = 'owner', password = 'hunter22') {
  const r = await httpJson(port, 'POST', '/api/setup', { name, password });
  if (r.status !== 200) throw new Error(`setup failed: ${r.status} ${r.raw}`);
  return r.json.token;
}

module.exports = { httpJson, httpRaw, bootServer, setupAdmin };
