'use strict';

const http = require('http');

const port = parseInt(process.env.PORT || process.argv[2] || '7796', 10);
const expectedKey = process.env.TRIBOON_WYZIE_KEY || process.env.WYZIE_KEY || 'test-key';

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'content-type': type, 'x-content-type-options': 'nosniff' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  if (url.pathname === '/search') {
    const key = url.searchParams.get('key') || req.headers['api-key'] || '';
    if (expectedKey && key !== expectedKey) return send(res, 401, { message: 'missing key' });
    const lang = url.searchParams.get('language') || 'en';
    return send(res, 200, [
      {
        id: 'mock-main',
        url: `http://127.0.0.1:${port}/main.srt`,
        format: 'srt',
        language: lang,
        display: 'Triboon.Verify.WEB-DL',
      },
      {
        id: 'mock-alt',
        url: `http://127.0.0.1:${port}/alternate.srt`,
        format: 'srt',
        language: lang,
        display: 'Triboon.Verify.Alternate.Cut.WEB-DL',
      },
    ]);
  }
  if (url.pathname === '/main.srt') {
    return send(res, 200, '1\r\n00:00:01,000 --> 00:00:03,000\r\nTriboon captions verified\r\n', 'application/x-subrip');
  }
  if (url.pathname === '/alternate.srt') {
    return send(res, 200, '1\r\n00:00:04,000 --> 00:00:06,000\r\nAlternate captions verified\r\n', 'application/x-subrip');
  }
  return send(res, 404, { message: 'not found' });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`mock-wyzie listening on http://127.0.0.1:${port}`);
});
