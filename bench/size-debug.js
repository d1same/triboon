'use strict';
// What does /api/search actually offer for a title, with sizes? Surfaces size-cap effects.
// Usage: node bench/size-debug.js "Inception 2010"
const { Store } = require('../server/store');
const { Auth } = require('../server/auth');
const http = require('http');

const store = new Store();
const auth = new Auth(store, process.env.TRIBOON_SECRET);
const admin = store.read('users', { list: [] }).list.find((u) => u.role === 'owner' || u.role === 'admin');
const token = auth.signToken({ uid: admin.id, role: admin.role, scope: 'session' }, 3600e3);

http.get(`http://127.0.0.1:7777/api/search?q=${encodeURIComponent(process.argv[2] || 'Inception 2010')}`,
  { headers: { authorization: 'Bearer ' + token } }, (res) => {
    let b = ''; res.on('data', (c) => b += c);
    res.on('end', () => {
      const j = JSON.parse(b);
      const cands = j.candidates || [];
      console.log('candidates:', cands.length);
      const uhd = cands.filter((c) => (c.attributes || {}).resolution === '2160p');
      console.log('2160p:', uhd.length, '| >40GB:', uhd.filter((c) => c.sizeBytes > 40e9).length);
      console.log('\nrank | score | size | name   (2160p only, by rank)');
      uhd.slice(0, 30).forEach((c) => console.log(
        String(cands.indexOf(c) + 1).padStart(4), String(c.score).padStart(7),
        (c.sizeBytes / 1e9).toFixed(1).padStart(6) + 'GB', c.name.slice(0, 90)));
    });
  }).on('error', (e) => console.error(e.message));
