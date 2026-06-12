'use strict';
// Tiny mock Xtream Codes server for demoing Live TV without a real IPTV subscription.
// Run: node demo/mock-xtream.js  → http://127.0.0.1:7799
const http = require('http');
const b64 = (s) => Buffer.from(s).toString('base64');
const now = () => Math.floor(Date.now() / 1000);

const CATS = [
  { category_id: '1', category_name: 'News' },
  { category_id: '2', category_name: 'Sports' },
  { category_id: '3', category_name: 'Movies' },
];
const CHANNELS = [
  { stream_id: 1, name: 'Global News 24', category_id: '1', epg: ['World Briefing', 'Market Hour'] },
  { stream_id: 2, name: 'City News HD', category_id: '1', epg: ['Local Desk', 'Weather Watch'] },
  { stream_id: 3, name: 'Premier Sports', category_id: '2', epg: ['Matchday Live', 'Post-Match Analysis'] },
  { stream_id: 4, name: 'Motor TV', category_id: '2', epg: ['Grand Prix Recap', 'Pit Lane Stories'] },
  { stream_id: 5, name: 'Cinema One', category_id: '3', epg: ['Feature Presentation', 'Midnight Classic'] },
];

http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const action = u.searchParams.get('action');
  res.writeHead(200, { 'content-type': 'application/json' });
  if (action === 'get_live_categories') return res.end(JSON.stringify(CATS));
  if (action === 'get_live_streams') {
    return res.end(JSON.stringify(CHANNELS.map((c) => ({
      stream_id: c.stream_id, name: c.name, category_id: c.category_id,
      stream_icon: '', epg_channel_id: `ch${c.stream_id}.mock`,
    }))));
  }
  if (action === 'get_short_epg') {
    const ch = CHANNELS.find((c) => String(c.stream_id) === u.searchParams.get('stream_id'));
    const t = now();
    return res.end(JSON.stringify({ epg_listings: (ch ? ch.epg : []).map((title, i) => ({
      title: b64(title), start_timestamp: t - 900 + i * 1800, stop_timestamp: t + 900 + i * 1800,
    })) }));
  }
  res.end('[]');
}).listen(7799, '127.0.0.1', () => console.log('mock xtream on http://127.0.0.1:7799'));
