'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
  classify,
  recordFinish,
  summarize,
  summarizeEvents,
  DEDUPE_MS,
  finishStreak,
} = require('../server/watch-stats');
const { bootServer, setupAdmin, httpJson } = require('./helpers');

function memStore(init = {}) {
  const tables = { watchStats: { users: {} }, watch: {}, ...init };
  return {
    read(t, fb) { return tables[t] || fb; },
    update(t, fb, fn) { tables[t] = fn(tables[t] || structuredClone(fb)); return tables[t]; },
    tables,
  };
}

test('classify keeps movies and episodes, skips live music and bare shows', () => {
  assert.deepStrictEqual(classify('tmdb:movie:550', {}), { kind: 'movie', showKey: null });
  assert.deepStrictEqual(classify('tmdb:tv:1399:s1e1', {}), { kind: 'episode', showKey: 'tmdb:tv:1399' });
  assert.strictEqual(classify('live:12', { type: 'live' }), null);
  assert.strictEqual(classify('ytm:dQw4w9WgXcQ', { type: 'music' }), null);
  assert.strictEqual(classify('tmdb:tv:1399', { type: 'tv' }), null);
  assert.strictEqual(classify('audible:book1', { type: 'audiobook' }), null);
});

test('summarizeEvents counts unique titles and hours in the range', () => {
  const now = Date.parse('2026-08-20T21:00:00-04:00');
  const events = [
    { at: now - 3600000, key: 'tmdb:movie:1', kind: 'movie', duration: 7200, title: 'Dune' },
    { at: now - 1800000, key: 'tmdb:tv:9:s1e1', kind: 'episode', showKey: 'tmdb:tv:9', duration: 1800, title: 'The Boys' },
    { at: now - 8 * 86400000, key: 'tmdb:movie:2', kind: 'movie', duration: 5400, title: 'Old' },
  ];
  const week = summarizeEvents(events, 'week', now);
  assert.strictEqual(week.movies, 1);
  assert.strictEqual(week.episodes, 1);
  assert.strictEqual(week.shows, 1);
  assert.strictEqual(week.hours, 2.5);
  assert.strictEqual(week.peakHour, new Date(now - 3600000).getHours());
  assert.strictEqual(week.weekday, 2);
  assert.strictEqual(week.weekend, 0);
  assert.strictEqual(week.recent[0].title, 'The Boys');
  assert.strictEqual(week.top[0].title, 'Dune');
  const all = summarizeEvents(events, 'all', now);
  assert.strictEqual(all.movies, 2);
});

test('finishStreak counts consecutive local days and keeps yesterday as grace', () => {
  const now = Date.parse('2026-08-20T10:00:00-04:00');
  const day = 86400000;
  assert.strictEqual(finishStreak([], now), 0);
  assert.strictEqual(finishStreak([{ at: now - 3 * day }], now), 0);
  assert.strictEqual(finishStreak([
    { at: now - day },
    { at: now - 2 * day },
    { at: now - 3 * day },
  ], now), 3);
  assert.strictEqual(finishStreak([{ at: now }, { at: now - day }], now), 2);
});

test('recordFinish dedupes the same title within 6 hours and isolates users', () => {
  const store = memStore();
  const t0 = Date.parse('2026-08-20T21:00:00Z');
  recordFinish(store, { userId: 'u1', key: 'tmdb:movie:1', meta: { title: 'Dune' }, duration: 7200, at: t0 });
  recordFinish(store, { userId: 'u1', key: 'tmdb:movie:1', meta: { title: 'Dune' }, duration: 7200, at: t0 + 1000 });
  recordFinish(store, { userId: 'u2', key: 'tmdb:movie:1', meta: { title: 'Dune' }, duration: 3600, at: t0 });
  assert.strictEqual(store.tables.watchStats.users.u1.events.length, 1);
  assert.strictEqual(store.tables.watchStats.users.u2.events.length, 1);
  recordFinish(store, {
    userId: 'u1', key: 'tmdb:movie:1', meta: { title: 'Dune' }, duration: 7200, at: t0 + DEDUPE_MS + 1,
  });
  assert.strictEqual(store.tables.watchStats.users.u1.events.length, 2);
});

test('recordFinish ignores live and music keys', () => {
  const store = memStore();
  assert.strictEqual(recordFinish(store, { userId: 'u1', key: 'live:3', meta: { type: 'live' } }), false);
  assert.strictEqual(recordFinish(store, { userId: 'u1', key: 'ytm:abc', meta: { type: 'music' } }), false);
  assert.deepStrictEqual(store.tables.watchStats.users, {});
});

test('all-time counts can use existing watched rows when the ledger is empty', () => {
  const store = memStore({
    watch: {
      'u1:default:tmdb:movie:7': { watched: true, duration: 5400, meta: { title: 'Seven' }, updatedAt: 1 },
      'u1:kids:tmdb:tv:2:s1e1': { watched: true, duration: 1200, meta: { title: 'Pilot', type: 'episode' }, updatedAt: 2 },
      'u2:default:tmdb:movie:7': { watched: true, duration: 5400, meta: { title: 'Seven' }, updatedAt: 3 },
    },
  });
  const mine = summarize(store, 'u1', 'all');
  assert.strictEqual(mine.movies, 1);
  assert.strictEqual(mine.episodes, 1);
  assert.strictEqual(mine.hours, 0, 'legacy rows do not invent hours');
  assert.strictEqual(mine.ledgerEmpty, true);
  const other = summarize(store, 'u2', 'all');
  assert.strictEqual(other.movies, 1);
  assert.strictEqual(other.episodes, 0);
});

test('GET /api/watch-stats is per-account and records a local finish', async () => {
  const srv = await bootServer();
  try {
    const admin = await setupAdmin(srv.port);
    const inv = await httpJson(srv.port, 'POST', '/api/invites', { policy: {} }, admin);
    const joined = await httpJson(srv.port, 'POST', '/api/invite/accept', {
      token: inv.json.token, name: 'guest', password: 'guest-pass1',
    });
    const guest = joined.json.token;

    const mark = await httpJson(srv.port, 'POST', '/api/watch', {
      key: 'tmdb:movie:550', watched: true, position: 7200, duration: 7200, meta: { title: 'Fight Club' },
    }, admin);
    assert.strictEqual(mark.status, 200);

    const live = await httpJson(srv.port, 'POST', '/api/watch', {
      key: 'live:1', watched: true, duration: 600, meta: { title: 'CNN', type: 'live' },
    }, admin);
    assert.strictEqual(live.status, 200);

    const again = await httpJson(srv.port, 'POST', '/api/watch', {
      key: 'tmdb:movie:550', watched: true, position: 7200, duration: 7200, meta: { title: 'Fight Club' },
    }, admin);
    assert.strictEqual(again.status, 200);

    const mine = await httpJson(srv.port, 'GET', '/api/watch-stats?range=week', null, admin);
    assert.strictEqual(mine.status, 200);
    assert.strictEqual(mine.json.movies, 1);
    assert.strictEqual(mine.json.hours, 2);
    assert.strictEqual(mine.json.eventCount, 1);
    assert.ok(mine.json.top.some((t) => t.title === 'Fight Club'));

    const theirs = await httpJson(srv.port, 'GET', '/api/watch-stats?range=week', null, guest);
    assert.strictEqual(theirs.status, 200);
    assert.strictEqual(theirs.json.movies, 0);
    assert.strictEqual(theirs.json.eventCount, 0);
    assert.strictEqual(theirs.json.ledgerEmpty, true);

    const guestId = joined.json.user.id;
    const adminMe = await httpJson(srv.port, 'GET', '/api/me', null, admin);
    assert.strictEqual(adminMe.status, 200);
    const asAdmin = await httpJson(srv.port, 'GET', `/api/watch-stats?range=week&user=${guestId}`, null, admin);
    assert.strictEqual(asAdmin.status, 200);
    assert.strictEqual(asAdmin.json.movies, 0, 'admin peeking a guest sees that guest’s empty ledger');
    const forbidden = await httpJson(srv.port, 'GET', `/api/watch-stats?range=week&user=${adminMe.json.id}`, null, guest);
    assert.strictEqual(forbidden.status, 403);
    const missing = await httpJson(srv.port, 'GET', '/api/watch-stats?range=week&user=no-such-user', null, admin);
    assert.strictEqual(missing.status, 404);
  } finally {
    await srv.shutdown();
  }
});
