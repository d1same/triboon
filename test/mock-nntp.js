'use strict';
// In-memory NNTP server for tests. Speaks just enough protocol: greeting, AUTHINFO, STAT, BODY, QUIT.

const net = require('net');

function dotStuff(buf) {
  // Lines starting with "." get an extra "." per RFC 3977.
  let s = buf.toString('latin1');
  if (s.startsWith('.')) s = '.' + s;
  return Buffer.from(s.replace(/\r\n\./g, '\r\n..'), 'latin1');
}

function createMockNntp({ articles, requireAuth = false, latencyMs = 0 } = {}) {
  // articles: Map<msgId, Buffer (article body, yEnc encoded)>
  const missing = new Set();
  const sockets = new Set();
  const state = { stallNext: 0, connCount: 0 }; // stallNext: swallow N STAT/BODY commands (no response — wedged socket)
  const server = net.createServer((sock) => {
    state.connCount++;
    sockets.add(sock); sock.on('close', () => sockets.delete(sock));
    sock.write('200 mock-nntp ready\r\n');
    let buf = '';
    let authed = !requireAuth;
    sock.on('data', (d) => {
      buf += d.toString('latin1');
      let nl;
      while ((nl = buf.indexOf('\r\n')) !== -1) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 2);
        const respond = (out) => setTimeout(() => { if (!sock.destroyed) sock.write(out); }, latencyMs);
        const [cmd, ...rest] = line.split(' ');
        const C = cmd.toUpperCase();
        if (C === 'AUTHINFO') {
          const kind = (rest[0] || '').toUpperCase();
          if (kind === 'USER') respond('381 password required\r\n');
          else { authed = true; respond('281 auth accepted\r\n'); }
        } else if (C === 'QUIT') { respond('205 bye\r\n'); sock.end(); }
        else if (!authed) respond('480 auth required\r\n');
        else if ((C === 'STAT' || C === 'BODY') && state.stallNext > 0) { state.stallNext--; /* never answer — simulates a NAT-dropped socket */ }
        else if (C === 'STAT') {
          const id = rest.join(' ').replace(/[<>]/g, '');
          if (articles.has(id) && !missing.has(id)) respond(`223 0 <${id}>\r\n`);
          else respond('430 no such article\r\n');
        } else if (C === 'BODY') {
          const id = rest.join(' ').replace(/[<>]/g, '');
          if (articles.has(id) && !missing.has(id)) {
            const body = dotStuff(articles.get(id));
            respond(Buffer.concat([Buffer.from(`222 0 <${id}>\r\n`), body, Buffer.from('.\r\n')]));
          } else respond('430 no such article\r\n');
        } else if (C === 'GROUP') respond('211 1 1 1 mock.group\r\n');
        else respond('500 unknown\r\n');
      }
    });
    sock.on('error', () => {});
  });
  return {
    server,
    markMissing: (id) => missing.add(id),
    stallNext: (n) => { state.stallNext = n; },          // next n STAT/BODY commands get NO response
    connCount: () => state.connCount,                    // total connections ever accepted
    dropConnections: () => { for (const s of sockets) s.destroy(); }, // provider idle-kill (FIN), server stays up
    listen: () => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port))),
    close: () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(r); }),
  };
}

module.exports = { createMockNntp };
