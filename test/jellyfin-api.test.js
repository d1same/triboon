'use strict';
// Jellyfin app door: off by default, same Triboon password, empty shelf, no usenet.

process.env.TRIBOON_POSTER_STUB = '1';
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { httpJson, bootServer, setupAdmin } = require('./helpers');
const { JELLYFIN_ROUTES, JELLYFIN_MAX_RANK, bindJellyfin, jellyfinCors, jellyfinToken, clientAddress, mediaStreamsFromProbe, tmdbSort, genreIdsFromNames, resumeClockPlaylist, fullTimelinePlaylist, rememberResumeOrigin, progressSeconds, resumeFracFor, traktResumeSeconds, loadingCardPng, loadingHoldPlaylist, pictureAfterLoadingCard } = require('../server/jellyfin-api');
const { LibraryDb } = require('../server/library-db');

let srv, admin;

function httpSend(port, method, p, { body, headers } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: headers || {} }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = raw ? JSON.parse(raw) : null; } catch { /* text or empty */ }
        resolve({ status: res.statusCode, json, raw, headers: res.headers });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

function openJfSocket(port, p) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let ws;
    const timer = setTimeout(() => finish(reject, new Error('timeout')), 4000);
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    ws = new WebSocket(`ws://127.0.0.1:${port}${p}`);
    ws.addEventListener('message', (ev) => finish(resolve, { ws, first: String(ev.data) }));
    ws.addEventListener('error', () => {});
    ws.addEventListener('close', () => finish(reject, new Error('closed')));
  });
}

test('jellyfin sort uses the first key, so release date is not treated as a name sort', () => {
  assert.strictEqual(tmdbSort('movie', { sortBy: 'PremiereDate,SortName', asc: false }), 'primary_release_date.desc');
  assert.strictEqual(tmdbSort('series', { sortBy: 'DateCreated,SortName', asc: false }), 'first_air_date.desc');
  assert.strictEqual(tmdbSort('movie', { sortBy: 'SortName', asc: true }), 'original_title.asc');
  assert.deepStrictEqual(genreIdsFromNames(['Action'], 'series'), [10759]);
  assert.deepStrictEqual(genreIdsFromNames(['Action'], 'movie'), [28]);
});

test('jellyfin resume clock reaches the saved minute before the picture', () => {
  const raw = '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:2.000,\nseg00000.m4s\n';
  assert.strictEqual(resumeClockPlaylist(raw, 0), raw);
  const out = resumeClockPlaylist(raw, 5);
  let clock = 0;
  let pictureAt = -1;
  const lines = out.split(/\n/);
  for (let i = 0; i < lines.length; i++) {
    const row = lines[i].match(/^#EXTINF:([0-9.]+),/);
    if (!row) continue;
    if (String(lines[i + 1] || '').startsWith('seg')) { pictureAt = clock; break; }
    clock += Number(row[1]);
  }
  assert.ok(pictureAt >= 0 && pictureAt < 5 && pictureAt + 2 > 5, 'the saved minute sits inside the picture, not on the cut');
  assert.match(out, /#EXT-X-DISCONTINUITY/);
  assert.match(out, /seg00000\.m4s/);
  assert.doesNotMatch(out, /EXT-X-GAP|EXT-X-SKIP/);
  const early = resumeClockPlaylist('', 4);
  const earlyDurs = [...early.matchAll(/#EXTINF:([0-9.]+),/g)].map((row) => Number(row[1]));
  assert.ok(Math.abs(earlyDurs.reduce((sum, n) => sum + n, 0) - 4) < 0.02, 'the clock is ready before the first picture piece');
  assert.doesNotMatch(early, /EXT-X-GAP|EXT-X-SKIP|DISCONTINUITY/);
  const long = ['#EXTM3U', '#EXT-X-MAP:URI="init.mp4"'];
  for (let i = 0; i < 5; i++) long.push('#EXTINF:2.000,', `seg${String(i).padStart(5, '0')}.m4s`);
  const held = resumeClockPlaylist(long.join('\n'), 4004);
  let heldClock = 0;
  let heldPicture = -1;
  const heldLines = held.split(/\n/);
  for (let i = 0; i < heldLines.length; i++) {
    const row = heldLines[i].match(/^#EXTINF:([0-9.]+),/);
    if (!row) continue;
    if (String(heldLines[i + 1] || '').startsWith('seg')) { heldPicture = heldClock; break; }
    heldClock += Number(row[1]);
  }
  assert.ok(heldPicture > 0 && heldPicture <= 4002 && 4004 - heldPicture >= 0.5, 'a one-hour resume starts after the loading card');
  assert.ok(Math.abs((4004 - heldPicture) % 2) < 0.02 || Math.abs(((4004 - heldPicture) % 2) - 2) < 0.02, 'pad pieces stay a whole 2 seconds');
  const uneven = [
    '#EXTM3U', '#EXT-X-MAP:URI="init.mp4"',
    '#EXTINF:1.335,', 'seg00000.m4s',
    '#EXTINF:2.669,', 'seg00001.m4s',
    '#EXTINF:2.002,', 'seg00002.m4s',
  ].join('\n');
  const unevenOut = resumeClockPlaylist(uneven, 4004);
  let unevenClock = 0;
  let unevenPicture = -1;
  const unevenLines = unevenOut.split(/\n/);
  const unevenDurs = [];
  for (let i = 0; i < unevenLines.length; i++) {
    const row = unevenLines[i].match(/^#EXTINF:([0-9.]+),/);
    if (!row) continue;
    const dur = Number(row[1]);
    if (String(unevenLines[i + 1] || '').startsWith('seg')) {
      if (unevenPicture < 0) unevenPicture = unevenClock;
      unevenDurs.push(dur);
    }
    unevenClock += dur;
  }
  const into = 4004 - unevenPicture;
  let at = 0;
  let gap = -1;
  for (const dur of unevenDurs) {
    if (into >= at && into <= at + dur) {
      gap = Math.min(into - at, at + dur - into);
      break;
    }
    at += dur;
  }
  assert.ok(gap >= 0.35, 'the saved minute sits in the middle of a piece, not on a cut');
  rememberResumeOrigin('user-1', 'm550', 2400);
  assert.strictEqual(progressSeconds('user-1', 'm550', 10), 2410, 'a clock that still starts at zero keeps the saved minute');
  assert.strictEqual(progressSeconds('user-1', 'm550', 2410), 2410, 'a clock that already includes the saved minute is not added twice');
  rememberResumeOrigin('user-1', 'm550', 0);
  assert.strictEqual(progressSeconds('user-1', 'm550', 10), 10, 'play from the start stays on the player clock');
});

test('jellyfin seek bar is the whole movie, and a drag is a later piece not a skip', () => {
  const raw = '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:2.000,\nseg00000.m4s\n#EXTINF:2.000,\nseg00001.m4s\n';
  assert.strictEqual(fullTimelinePlaylist(raw, 0), raw, 'an unknown runtime must not invent a short ending');
  const out = fullTimelinePlaylist(raw, 10, 2);
  const durs = [...out.matchAll(/#EXTINF:([0-9.]+),/g)].map((row) => Number(row[1]));
  const sum = durs.reduce((total, n) => total + n, 0);
  assert.ok(Math.abs(sum - 10) < 0.05, 'the bar adds up to the real runtime, not just the pieces made so far');
  assert.match(out, /seg00004\.m4s/);
  assert.match(out, /#EXT-X-ENDLIST/);
  assert.match(out, /seg00000\.m4s/);
  assert.doesNotMatch(out, /EXT-X-GAP|EXT-X-SKIP/);
  const resumed = fullTimelinePlaylist(resumeClockPlaylist(raw, 4), 10, 2);
  const resumedSum = [...resumed.matchAll(/#EXTINF:([0-9.]+),/g)].map((row) => Number(row[1])).reduce((total, n) => total + n, 0);
  assert.ok(Math.abs(resumedSum - 10) < 0.05, 'resume still fills the clock and the bar stays the whole movie');
  assert.match(resumed, /#EXT-X-DISCONTINUITY/);
  assert.match(resumed, /pad\.m4s/);
  assert.doesNotMatch(resumed, /EXT-X-GAP|EXT-X-SKIP/);
  const server = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
  const api = fs.readFileSync(path.join(__dirname, '..', 'server', 'jellyfin-api.js'), 'utf8');
  assert.match(server, /if \(jellyfinPlaylist && sess\.timeline\) \{\s*raw = sess\.timeline;/,
    'a later short encode list must not shrink the bar');
  assert.match(server, /if \(jellyfinPlaylist && \(sess\.duration \|\| knownDur\) >= 1 && \/seg\\d\+\\.m4s\/\.test\(raw\)\) raw = fullTimelinePlaylist\(raw, sess\.duration \|\| knownDur, 2\);/,
    'only the Jellyfin list is stretched to the runtime; iOS keeps its rolling window');
  assert.match(server, /index > Math\.max\(highest, encodeAt\) \+ 40/,
    'a drag past the loaded minute restarts there; normal look-ahead must not skip');
  assert.match(api, /&dur=\$\{dur\}/,
    'play tells the phone the real runtime');
});

test('jellyfin resume warms the saved minute, same as Continue Watching', () => {
  assert.strictEqual(resumeFracFor(0, 120), 0, 'play from the start still warms the opening');
  const frac = resumeFracFor(600, 100);
  assert.ok(Math.abs(frac - 0.1) < 0.001, 'ten minutes into a 100 minute movie warms that spot');
  assert.ok(resumeFracFor(50 * 60, 40) === 0, 'a start past the runtime does not invent a fraction');
  assert.strictEqual(traktResumeSeconds({ position: 0, traktPct: 40 }, 100), 2400, 'a Trakt 40 percent of a 100 minute movie is minute 40');
  assert.strictEqual(traktResumeSeconds({ position: 120, traktPct: 40 }, 100), 0, 'a real pause stays on the ticks the TV already sends');
  assert.strictEqual(traktResumeSeconds({ position: 0, traktPct: 40, watched: true }, 100), 0, 'a finished movie does not jump back in');
  const play = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
  assert.match(play, /resumeFrac: Math\.max\(0, Math\.min\(0\.98, Number\(body\.resumeFrac\) \|\| 0\)\)/,
    'a Jellyfin resume uses the same warm window as the Triboon app');
});

test('jellyfin shows a Loading card instead of a frozen picture', () => {
  const png = loadingCardPng();
  assert.strictEqual(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.strictEqual(png.readUInt32BE(16), 1280);
  assert.strictEqual(png.readUInt32BE(20), 720);
  const first = loadingHoldPlaylist(2);
  const next = loadingHoldPlaylist(4);
  assert.strictEqual((first.match(/pad\.m4s/g) || []).length, 2);
  assert.strictEqual((next.match(/pad\.m4s/g) || []).length, 4, 'a later list is longer so the phone keeps the card');
  assert.doesNotMatch(first, /seg\d+/);
  const server = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
  assert.match(server, /loadingCardPng\(\)/);
  assert.doesNotMatch(server, /color=c=black:s=1280x720/);
  assert.match(server, /sessionStart < 1 && !sess\.loadHold && realPieces > 0 && await ensureResumePad\(\)/,
    'Android TV still gets the Loading card when the movie pieces are already named');
  const picture = '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:2.000,\nseg00000.m4s\n#EXT-X-ENDLIST\n';
  const joined = pictureAfterLoadingCard(2, picture);
  assert.ok(joined.indexOf('pad.m4s') >= 0 && joined.indexOf('pad.m4s') < joined.indexOf('seg00000.m4s'), 'the card stays piece 0 when the movie arrives');
  assert.match(joined, /#EXT-X-DISCONTINUITY/);
  assert.match(joined, /#EXT-X-MAP:URI="init\.mp4"/);
  assert.strictEqual(pictureAfterLoadingCard(0, picture), picture);
});

test('jellyfin door stays shut until an admin opens it', async () => {
  srv = await bootServer();
  admin = await setupAdmin(srv.port);
  const before = await httpJson(srv.port, 'GET', '/api/settings', null, admin);
  assert.strictEqual(before.json.jellyfinApps, false, 'the switch defaults off');

  const hidden = await httpSend(srv.port, 'GET', '/System/Info/Public');
  assert.strictEqual(hidden.status, 404);
  assert.strictEqual(hidden.json.error, 'not found');
  const hiddenLogin = await httpSend(srv.port, 'POST', '/Users/AuthenticateByName', {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ Username: 'owner', Pw: 'hunter22' }),
  });
  assert.strictEqual(hiddenLogin.status, 404, 'a shut door does not check the password');

  const home = await httpSend(srv.port, 'GET', '/');
  assert.strictEqual(home.status, 200);
  assert.match(home.raw, /<html/i, 'the Triboon page still loads');
  const meOff = await httpJson(srv.port, 'GET', '/api/me', null, admin);
  assert.strictEqual(meOff.status, 200, 'the normal app login still works while the door is shut');
  assert.strictEqual(srv.mounts.size, 0);
});

test('jellyfin play link does not send a phone to itself or the docker bridge', () => {
  const loop = clientAddress({ req: { headers: { host: '127.0.0.1:7777' } } });
  let lan = '';
  for (const list of Object.values(os.networkInterfaces())) {
    for (const addr of list || []) {
      if ((addr.family === 'IPv4' || addr.family === 4) && !addr.internal && /^(10\.|192\.168\.)/.test(addr.address)) lan = addr.address;
    }
  }
  if (lan) {
    assert.match(loop, /^http:\/\/(10\.|192\.168\.)\d+\.\d+\.\d+:7777$/);
    assert.doesNotMatch(loop, /127\.0\.0\.1/);
  } else {
    assert.strictEqual(loop, 'http://127.0.0.1:7777');
  }
  assert.strictEqual(
    clientAddress({ req: { headers: { host: '172.17.0.2:7777', 'x-forwarded-host': '10.2.4.171:7777' } } }),
    'http://10.2.4.171:7777',
    'a Zima bridge must keep the office IP the phone already opened'
  );
  assert.strictEqual(
    clientAddress({ req: { headers: { host: '127.0.0.1:7777', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'media.example' } } }),
    'https://media.example'
  );
});

test('jellyfin sign-in returns an empty shelf and refuses a stranger', async () => {
  const opened = await httpJson(srv.port, 'POST', '/api/settings', { jellyfinApps: true }, admin);
  assert.strictEqual(opened.status, 200);
  const openedGet = await httpJson(srv.port, 'GET', '/api/settings', null, admin);
  assert.strictEqual(openedGet.json.jellyfinApps, true);

  const info = await httpSend(srv.port, 'GET', '/System/Info/Public');
  assert.strictEqual(info.status, 200);
  assert.strictEqual(info.json.ServerName, 'Triboon');
  assert.strictEqual(info.json.Version, '10.11.11');
  assert.strictEqual(info.json.ProductName, 'Jellyfin Server');
  assert.match(info.json.LocalAddress, /^http:\/\/(127\.0\.0\.1|(10|192\.168)\.\d+\.\d+\.\d+):\d+$/, 'a loopback door advertises a phone-reachable address when this machine has one');
  const behind = await httpSend(srv.port, 'GET', '/System/Info/Public', {
    headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'media.example' },
  });
  assert.strictEqual(behind.status, 200);
  assert.strictEqual(behind.json.LocalAddress, 'https://media.example');
  const house = await httpSend(srv.port, 'GET', '/System/Info/Public', {
    headers: { host: '10.1.20.120:7777', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'media.example' },
  });
  assert.strictEqual(house.json.LocalAddress, 'http://10.1.20.120:7777', 'a phone on the house IP keeps pictures and movies on that IP');
  assert.strictEqual(behind.json.Version, '10.11.11');
  assert.strictEqual(info.json.StartupWizardCompleted, true);
  assert.strictEqual(info.json.providers, undefined);
  assert.doesNotMatch(JSON.stringify(info.json), /hunter22|tmdb|apikey|salt/i);

  const bad = await httpSend(srv.port, 'POST', '/Users/AuthenticateByName', {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ Username: 'owner', Pw: 'nope' }),
  });
  assert.strictEqual(bad.status, 401);

  const anon = await httpSend(srv.port, 'GET', '/Users/Me');
  assert.strictEqual(anon.status, 401);

  const login = await httpSend(srv.port, 'POST', '/Users/AuthenticateByName', {
    headers: { 'content-type': 'application/json', authorization: 'MediaBrowser Client="Test", Device="PC", DeviceId="pc1", Version="1"' },
    body: JSON.stringify({ Username: 'owner', Pw: 'hunter22' }),
  });
  assert.strictEqual(login.status, 200);
  assert.ok(login.json.AccessToken);
  // TV and Android phone reject sign-in if these are missing.
  // iPhone and Apple TV require the two provider ids. Roku reads this same card.
  assert.strictEqual(login.json.User.Policy.SyncPlayAccess, 'None');
  assert.strictEqual(login.json.User.Policy.EnableUserPreferenceAccess, true);
  assert.strictEqual(login.json.User.Policy.AuthenticationProviderId, '');
  assert.strictEqual(login.json.User.Policy.PasswordResetProviderId, '');
  assert.deepStrictEqual(login.json.User.Configuration.GroupedFolders, []);
  assert.strictEqual(login.json.User.Name, 'owner');
  assert.match(login.json.User.Id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.doesNotMatch(JSON.stringify(login.json), /salt|hash|hunter22/);
  const token = login.json.AccessToken;
  const authz = `MediaBrowser Client="Test", Device="PC", DeviceId="pc1", Version="1", Token="${token}"`;

  const me = await httpSend(srv.port, 'GET', '/Users/Me', { headers: { authorization: authz } });
  assert.strictEqual(me.status, 200);

  const qcOn = await httpSend(srv.port, 'GET', '/QuickConnect/Enabled');
  assert.strictEqual(qcOn.status, 200);
  assert.strictEqual(qcOn.json.Enabled, true, 'the TV sign-in button needs a yes');
  const started = await httpSend(srv.port, 'POST', '/QuickConnect/Initiate', {
    headers: {
      'content-type': 'application/json',
      authorization: 'MediaBrowser Client="Jellyfin Android TV", Device="onn", DeviceId="tv1", Version="0.19.10"',
    },
    body: '{}',
  });
  assert.strictEqual(started.status, 200);
  assert.match(started.json.Code, /^\d{6}$/);
  assert.ok(started.json.Secret);
  assert.strictEqual(started.json.DeviceId, 'tv1', 'the TV app drops the code if DeviceId is missing');
  assert.strictEqual(started.json.DeviceName, 'onn');
  assert.strictEqual(started.json.AppName, 'Jellyfin Android TV');
  assert.strictEqual(started.json.AppVersion, '0.19.10');
  const pending = await httpSend(srv.port, 'GET', `/QuickConnect/Connect?Secret=${started.json.Secret}`);
  assert.strictEqual(pending.status, 404, 'the TV keeps waiting until someone approves');
  const approved = await httpSend(srv.port, 'POST', '/QuickConnect/Authorize', {
    headers: { 'content-type': 'application/json', 'x-emby-token': token },
    body: JSON.stringify({ Code: started.json.Code }),
  });
  assert.strictEqual(approved.status, 200);
  assert.strictEqual(approved.json.Authenticated, true);
  const done = await httpSend(srv.port, 'GET', `/QuickConnect/Connect?Secret=${started.json.Secret}`);
  assert.strictEqual(done.status, 200);
  assert.strictEqual(done.json.User.Name, 'owner');
  assert.ok(done.json.AccessToken);
  assert.doesNotMatch(JSON.stringify(done.json), /salt|hash|hunter22/);
  const spent = await httpSend(srv.port, 'GET', `/QuickConnect/Connect?Secret=${started.json.Secret}`);
  assert.strictEqual(spent.status, 404, 'the code works once');
  const startedAgain = await httpSend(srv.port, 'POST', '/QuickConnect/Initiate', {
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  const viaTriboon = await httpJson(srv.port, 'POST', `/api/quickconnect/${startedAgain.json.Code}/approve`, {}, admin);
  assert.strictEqual(viaTriboon.status, 200);
  const viaConnect = await httpSend(srv.port, 'GET', `/QuickConnect/Connect?Secret=${startedAgain.json.Secret}`);
  assert.strictEqual(viaConnect.status, 200);
  assert.strictEqual(viaConnect.json.User.Name, 'owner');
  assert.strictEqual(me.json.Id, login.json.User.Id);
  assert.strictEqual(me.json.Policy.EnableLiveTvAccess, false, 'live TV stays on the Triboon app');

  const headerToken = await httpSend(srv.port, 'GET', '/Users/Me', { headers: { 'x-emby-token': token } });
  assert.strictEqual(headerToken.status, 200);

  const speed = await httpSend(srv.port, 'GET', '/Playback/BitrateTest?Size=500000', { headers: { authorization: authz } });
  assert.strictEqual(speed.status, 200, 'the phone speed check must answer or the app closes');
  assert.strictEqual(speed.raw.length, 500000);
  const prefs = await httpSend(srv.port, 'GET', '/DisplayPreferences/usersettings', { headers: { authorization: authz } });
  assert.strictEqual(prefs.status, 200);
  assert.strictEqual(prefs.json.RememberSorting, true, 'the phone player needs sort settings or play dies');
  assert.strictEqual(prefs.json.ScrollDirection, 'Vertical');
  assert.strictEqual(prefs.json.ShowSidebar, false);
  const livePrefs = await httpSend(srv.port, 'GET', '/DisplayPreferences/livetv', { headers: { authorization: authz } });
  assert.strictEqual(livePrefs.status, 200, 'Android TV asks for livetv prefs on open');
  assert.strictEqual(livePrefs.json.Id, 'livetv');
  const caps = await httpSend(srv.port, 'POST', '/Sessions/Capabilities?playableMediaTypes=Video', { headers: { authorization: authz } });
  assert.strictEqual(caps.status, 204, 'Android TV posts session capabilities without /Full');
  const segments = await httpSend(srv.port, 'GET', `/MediaSegments/${me.json.Id}`, { headers: { authorization: authz } });
  assert.strictEqual(segments.status, 200, 'a missing skip-intro list closes the phone');
  assert.deepStrictEqual(segments.json, { Items: [], TotalRecordCount: 0, StartIndex: 0 });
  const stopEncode = await httpSend(srv.port, 'DELETE', '/Videos/ActiveEncodings', { headers: { authorization: authz } });
  assert.strictEqual(stopEncode.status, 204, 'stopping a previous play must not be a missing page');

  const views = await httpSend(srv.port, 'GET', `/Users/${me.json.Id}/Views`, { headers: { authorization: authz } });
  assert.strictEqual(views.status, 200);
  assert.deepStrictEqual(views.json.Items.map((row) => row.Name), ['Movies', 'Shows']);
  const found = await httpSend(srv.port, 'GET', '/Search/Hints?searchTerm=batman&Limit=5', { headers: { authorization: authz } });
  assert.strictEqual(found.status, 200, 'the Jellyfin search box needs a hints page');
  assert.ok(Array.isArray(found.json.SearchHints));
  const typed = await httpSend(srv.port, 'GET', `/Users/${me.json.Id}/Items?SearchTerm=batman&IncludeItemTypes=Movie,Series&Recursive=true&Limit=5`, { headers: { authorization: authz } });
  assert.strictEqual(typed.status, 200);
  assert.ok(Array.isArray(typed.json.Items));
  const moviesFolder = views.json.Items.find((row) => row.Name === 'Movies');
  assert.match(moviesFolder.Id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.strictEqual(moviesFolder.UserData.Key, 'viewmovies');
  assert.strictEqual(moviesFolder.UserData.ItemId, moviesFolder.Id);
  assert.strictEqual(moviesFolder.UserData.Played, false);
  assert.ok(moviesFolder.ImageTags.Primary, 'Movies has a cover the home row can show');
  assert.ok(moviesFolder.ImageTags.Thumb, 'Movies has a wide cover too');
  const moviesCover = await httpSend(srv.port, 'GET', `/Items/${moviesFolder.Id}/Images/Primary`);
  assert.strictEqual(moviesCover.status, 200, 'the Movies home card uses its own cover');
  assert.match(moviesCover.headers['content-type'], /jpeg/, 'a JPEG named .png must not be labeled png or the TV dies');
  assert.match(moviesCover.raw, /JFIF/);
  const showsFolder = views.json.Items.find((row) => row.Name === 'Shows');
  const showsCover = await httpSend(srv.port, 'GET', `/Items/${showsFolder.Id}/Images/Primary`);
  assert.strictEqual(showsCover.status, 200, 'the Shows home card uses its own cover');
  assert.match(showsCover.headers['content-type'], /jpeg/);
  const movieByCard = await httpSend(srv.port, 'GET', `/Users/${me.json.Id}/Items/${moviesFolder.Id}`, { headers: { authorization: authz } });
  assert.strictEqual(movieByCard.status, 200);
  assert.strictEqual(movieByCard.json.Name, 'Movies');
  const homeLibraries = await httpSend(srv.port, 'GET', '/UserViews', { headers: { authorization: authz } });
  assert.strictEqual(homeLibraries.status, 200);
  assert.deepStrictEqual(homeLibraries.json.Items.map((row) => row.Name), ['Movies', 'Shows']);
  const moviePage = await httpSend(srv.port, 'GET', `/Users/${me.json.Id}/Items/viewmovies`, { headers: { authorization: authz } });
  assert.strictEqual(moviePage.status, 200);
  assert.strictEqual(moviePage.json.Name, 'Movies');
  assert.strictEqual(moviePage.json.Type, 'CollectionFolder');
  const stream = await httpSend(srv.port, 'GET', '/Videos/m1/stream.mp4');
  assert.strictEqual(stream.status, 401, 'the player link still requires a sign-in');
  const latestRow = await httpSend(srv.port, 'GET', `/Users/${me.json.Id}/Items/Latest`, { headers: { authorization: authz } });
  assert.ok(Array.isArray(latestRow.json));
  const missingMovie = await httpSend(srv.port, 'GET', '/Items/m1', { headers: { authorization: authz } });
  assert.strictEqual(missingMovie.status, 404, 'a movie the catalog cannot name does not invent a details page');
  const latest = await httpSend(srv.port, 'GET', '/Items/Latest?ParentId=viewmovies', { headers: { authorization: authz } });
  assert.strictEqual(latest.status, 200);
  assert.ok(Array.isArray(latest.json));
  const items = await httpSend(srv.port, 'GET', '/Items?ParentId=viewmovies&StartIndex=40&Limit=40', { headers: { authorization: authz } });
  assert.ok(Array.isArray(items.json.Items));
  assert.strictEqual(items.json.StartIndex, 40);
  assert.strictEqual(typeof items.json.TotalRecordCount, 'number');
  const counts = await httpSend(srv.port, 'GET', '/Items/Counts', { headers: { authorization: authz } });
  assert.strictEqual(counts.json.MovieCount, 0);
  const strangers = await httpSend(srv.port, 'GET', '/Users/Public');
  assert.strictEqual(strangers.status, 200);
  assert.deepStrictEqual(strangers.json, []);
  const noPlay = await httpSend(srv.port, 'POST', '/Items/m1/PlaybackInfo', {
    headers: { authorization: authz, 'content-type': 'application/json' },
    body: '{}',
  });
  assert.strictEqual(noPlay.status, 404, 'a title the catalog cannot name does not start a download');
  const progress = await httpSend(srv.port, 'POST', '/Sessions/Playing/Progress', {
    headers: { authorization: authz, 'content-type': 'application/json' },
    body: '{}',
  });
  assert.strictEqual(progress.status, 204, 'the play screen can report progress without an error loop');
  const playing = await httpSend(srv.port, 'POST', '/Sessions/Playing', {
    headers: { authorization: authz, 'content-type': 'application/json' },
    body: '{}',
  });
  assert.strictEqual(playing.status, 204);
  const intros = await httpSend(srv.port, 'GET', `/Users/${me.json.Id}/Items/m1/Intros`, { headers: { authorization: authz } });
  assert.strictEqual(intros.status, 200);
  assert.deepStrictEqual(intros.json.Items, []);
  const endpoint = await httpSend(srv.port, 'GET', '/System/Endpoint', { headers: { authorization: authz } });
  assert.strictEqual(endpoint.status, 200);
  assert.strictEqual(endpoint.json.IsInNetwork, true);

  const garbage = await httpSend(srv.port, 'GET', '/Users/Me', { headers: { 'x-emby-token': 'not-a-token' } });
  assert.strictEqual(garbage.status, 401);

  const inv = await httpJson(srv.port, 'POST', '/api/invites', { policy: {} }, admin);
  const joined = await httpJson(srv.port, 'POST', '/api/invite/accept', { token: inv.json.token, name: 'guest', password: 'guest-pass' });
  const guest = await httpSend(srv.port, 'POST', '/Users/AuthenticateByName', {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ Username: 'guest', Pw: 'guest-pass' }),
  });
  assert.strictEqual(guest.status, 200);
  const peek = await httpSend(srv.port, 'GET', `/Users/${me.json.Id}/Views`, {
    headers: { 'x-emby-token': guest.json.AccessToken },
  });
  assert.strictEqual(peek.status, 403, 'one person cannot open another person\'s shelf');

  const still = await httpJson(srv.port, 'GET', '/api/me', null, admin);
  assert.strictEqual(still.status, 200);
  assert.strictEqual(srv.mounts.size, 0, 'signing in does not mount a movie');

  const web = fs.mkdtempSync(path.join(os.tmpdir(), 'jfweb-'));
    fs.writeFileSync(path.join(web, 'index.html'), '<html><script src="main.jellyfin.bundle.js"></script></html>');
    fs.writeFileSync(path.join(web, 'main.jellyfin.bundle.js'), '/* jellyfin */');
    fs.writeFileSync(path.join(web, 'node_modules.@jellyfin.sdk.bundle.js'), '/* at-bundle */');
  process.env.TRIBOON_JELLYFIN_WEB = web;
  try {
    const jump = await httpSend(srv.port, 'GET', '/', { headers: { 'user-agent': 'JellyfinDesktop/1.0' } });
    assert.strictEqual(jump.status, 302);
    assert.strictEqual(jump.headers.location, '/web/');
    const page = await httpSend(srv.port, 'GET', '/web/', { headers: { 'user-agent': 'JellyfinMediaPlayer 1.0' } });
    assert.strictEqual(page.status, 200);
    assert.match(page.raw, /main\.jellyfin\.bundle\.js/);
    const phone = await httpSend(srv.port, 'GET', '/web/main.jellyfin.bundle.js', {
      headers: { 'user-agent': 'Mozilla/5.0 (Linux; Android 14; Phone; wv) AppleWebKit Chrome Mobile' },
    });
    assert.strictEqual(phone.status, 200);
    assert.match(phone.raw, /jellyfin/);
    const atBundle = await httpSend(srv.port, 'GET', '/web/node_modules.%40jellyfin.sdk.bundle.js', {
      headers: { 'user-agent': 'JellyfinDesktop/1.0' },
    });
    assert.strictEqual(atBundle.status, 200);
    assert.match(atBundle.headers['content-type'], /javascript/);
    assert.match(atBundle.raw, /at-bundle/);
    const ours = await httpSend(srv.port, 'GET', '/', {
      headers: { 'user-agent': 'Mozilla/5.0 (Linux; Android 14; wv) TriboonAndroid/3.2.7' },
    });
    assert.strictEqual(ours.status, 200);
    assert.match(ours.raw, /triboon/i);
    const browser = await httpSend(srv.port, 'GET', '/', { headers: { 'user-agent': 'Mozilla/5.0 Chrome' } });
    assert.match(browser.raw, /triboon/i);
  } finally {
    delete process.env.TRIBOON_JELLYFIN_WEB;
    fs.rmSync(web, { recursive: true, force: true });
  }
  const phoneSite = await httpSend(srv.port, 'GET', '/', {
    headers: { 'user-agent': 'Mozilla/5.0 (Linux; Android 14; Phone; wv) AppleWebKit Chrome Mobile' },
  });
  assert.strictEqual(phoneSite.status, 503, 'the phone must not open the Triboon site');
  assert.doesNotMatch(String(phoneSite.raw || ''), /main\.[^/\s]+\.bundle\.js/);

  assert.strictEqual(JELLYFIN_MAX_RANK, 3, 'jellyfin play stops at 1080p');
  const disk = await httpJson(srv.port, 'POST', '/api/libraries', { name: 'Disk Movies', kind: 'movie', path: 'C:\\Movies' }, admin);
  assert.strictEqual(disk.status, 200);
  const shows = await httpJson(srv.port, 'POST', '/api/libraries', { name: 'Disk Shows', kind: 'tv', path: 'C:\\Shows' }, admin);
  assert.strictEqual(shows.status, 200);
  const catalog = new LibraryDb(process.env.TRIBOON_DATA);
  assert.ok(catalog.available, 'the test server can store a scanned library');
  const artDir = fs.mkdtempSync(path.join(os.tmpdir(), 'triboon-jf-art-'));
  fs.writeFileSync(path.join(artDir, 'Aardvark.jpg'), Buffer.from(
    '/9j/4AAQSkZJRgABAQAAAQABAAD/2wCEAAkGBxISEhUQEhIVFhUVFRUVFRUVFRUVFRUWFxUVFRUYHSggGBolGxUVITEhJSkrLi4uFx8zODMtNygtLisBCgoKDg0OGhAQGy0lHyUtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLf/AABEIAAEAAQMBIgACEQEDEQH/xAAbAAABBQEBAAAAAAAAAAAAAAADAAIEBQYBB//EABQBAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAGf/9k=',
    'base64',
  ));
  catalog.replaceLibrary(disk.json.id, Date.now(), [
    { idx: 0, kind: 'movie', title: 'Mahour', year: 2024, runtime: 99, genres: [18], file: 'C:\\Movies\\Mahour.mkv' },
    { idx: 2, kind: 'movie', title: 'Aardvark', year: 1990, genres: [28], file: path.join(artDir, 'Aardvark.mkv') },
    { idx: 3, kind: 'movie', title: 'Zebra', year: 2020, genres: [35], file: 'C:\\Movies\\Zebra.mkv' },
  ]);
  catalog.replaceLibrary(shows.json.id, Date.now(), [
    { idx: 0, kind: 'show', title: 'Day Show', year: 2025, poster: '/dayshow.jpg', backdrop: '/dayshow-wide.jpg' },
    { idx: 1, kind: 'episode', title: 'Day Show S01E01', showIdx: 0, s: 1, e: 1, file: 'C:\\Shows\\Day Show\\S01E01.mkv' },
    { idx: 2, kind: 'episode', title: 'Day Show S01E02', showIdx: 0, s: 1, e: 2, file: 'C:\\Shows\\Day Show\\S01E02.mkv' },
  ]);
  catalog.close();
  const withDisk = await httpSend(srv.port, 'GET', '/UserViews', { headers: { authorization: authz } });
  const diskFolder = withDisk.json.Items.find((row) => row.Name === 'Disk Movies');
  assert.ok(diskFolder, 'a folder on disk shows up next to Movies');
  assert.match(diskFolder.Id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.strictEqual(diskFolder.UserData.ItemId, diskFolder.Id);
  assert.ok(diskFolder.ImageTags.Primary, 'a custom library has a cover');
  const libraryCover = await httpSend(srv.port, 'GET', `/Items/${diskFolder.Id}/Images/Primary`);
  assert.strictEqual(libraryCover.status, 200, 'the custom library cover loads');
  assert.match(libraryCover.headers['content-type'], /jpeg/, 'a home folder uses the designed cover');
  assert.strictEqual(diskFolder.ImageTags.Primary, 'xmovie', 'a custom movie folder asks for the extra movie cover');
  const showFolder = withDisk.json.Items.find((row) => row.Name === 'Disk Shows');
  assert.ok(showFolder, 'a show folder shows up too');
  assert.strictEqual(showFolder.ImageTags.Primary, 'xshow', 'a custom show folder asks for the extra show cover');
  const showCover = await httpSend(srv.port, 'GET', `/Items/${showFolder.Id}/Images/Primary`);
  assert.strictEqual(showCover.status, 200);
  assert.notStrictEqual(showCover.headers['content-length'], libraryCover.headers['content-length'], 'movie and show folders do not share one picture');
  const mix = await httpJson(srv.port, 'POST', '/api/libraries', { name: 'Mix Tapes', kind: 'music', path: 'C:\\Music' }, admin);
  assert.strictEqual(mix.status, 200);
  const withMix = await httpSend(srv.port, 'GET', '/UserViews', { headers: { authorization: authz } });
  const mixFolder = withMix.json.Items.find((row) => row.Name === 'Mix Tapes');
  assert.strictEqual(mixFolder.ImageTags.Primary, 'home1', 'music and other folders keep the Library picture');
  const jpeg = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF]), Buffer.alloc(220, 0x22)]);
  const junk = await httpSend(srv.port, 'POST', '/api/settings/jellyfin-cover/custom-movies', {
    headers: { authorization: 'Bearer ' + admin, 'content-type': 'image/jpeg', 'content-length': '20' },
    body: Buffer.from('not-a-real-picture!!'),
  });
  assert.strictEqual(junk.status, 400, 'a text file is not a home picture');
  const up = await httpSend(srv.port, 'POST', '/api/settings/jellyfin-cover/custom-movies', {
    headers: { authorization: 'Bearer ' + admin, 'content-type': 'image/jpeg', 'content-length': String(jpeg.length) },
    body: jpeg,
  });
  assert.strictEqual(up.status, 200);
  const named = await httpJson(srv.port, 'POST', '/api/settings', {
    jellyfinServerName: 'Living Room',
    jellyfinQuickConnect: false,
  }, admin);
  assert.strictEqual(named.status, 200);
  const infoNamed = await httpSend(srv.port, 'GET', '/System/Info/Public');
  assert.strictEqual(infoNamed.json.ServerName, 'Living Room', 'the TV list uses the name you typed');
  const qcOff = await httpSend(srv.port, 'GET', '/QuickConnect/Enabled');
  assert.strictEqual(qcOff.json.Enabled, false, 'the sign-in code can be turned off');
  const freshViews = await httpSend(srv.port, 'GET', '/UserViews', { headers: { authorization: authz } });
  const freshDisk = freshViews.json.Items.find((row) => row.Name === 'Disk Movies');
  assert.match(freshDisk.ImageTags.Primary, /^xmovie\d+$/, 'a new picture changes the tag so the TV fetches it');
  const customCover = await httpSend(srv.port, 'GET', `/Items/${freshDisk.Id}/Images/Primary`);
  assert.strictEqual(Number(customCover.headers['content-length']), jpeg.length, 'the TV gets the picture you picked');
  const cleared = await httpJson(srv.port, 'DELETE', '/api/settings/jellyfin-cover/custom-movies', null, admin);
  assert.strictEqual(cleared.status, 200);
  const back = await httpSend(srv.port, 'GET', `/Items/${freshDisk.Id}/Images/Primary`);
  assert.strictEqual(Number(back.headers['content-length']), Number(libraryCover.headers['content-length']), 'Use ours puts the designed picture back');
  await httpJson(srv.port, 'POST', '/api/settings', { jellyfinServerName: '', jellyfinQuickConnect: true }, admin);
  const shelfPath = `/Users/${me.json.Id}/Items?ParentId=l${disk.json.id}&IncludeItemTypes=Movie&Recursive=true&Limit=10`;
  const movieShelf = await httpSend(srv.port, 'GET', shelfPath, { headers: { authorization: authz } });
  assert.strictEqual(movieShelf.status, 200);
  assert.strictEqual(movieShelf.json.TotalRecordCount, 3, 'a scanned movie library is not an empty shelf');
  assert.deepStrictEqual(movieShelf.json.Items.map((row) => row.Name), ['Aardvark', 'Mahour', 'Zebra'], 'the shelf is A to Z by default');
  const mahour = movieShelf.json.Items.find((row) => row.Name === 'Mahour');
  assert.strictEqual(mahour.Type, 'Movie');
  assert.strictEqual(mahour.RunTimeTicks, 99 * 60 * 10000000, 'the details clock uses the real runtime');
  assert.ok(mahour.ImageTags.Primary, 'a disk movie asks for its cover');
  const byYear = await httpSend(srv.port, 'GET', `${shelfPath}&SortBy=ProductionYear&SortOrder=Descending`, { headers: { authorization: authz } });
  assert.deepStrictEqual(byYear.json.Items.map((row) => row.Name), ['Mahour', 'Zebra', 'Aardvark'], 'year sort puts the newest movie first');
  const onlyOld = await httpSend(srv.port, 'GET', `${shelfPath}&Years=1990`, { headers: { authorization: authz } });
  assert.deepStrictEqual(onlyOld.json.Items.map((row) => row.Name), ['Aardvark'], 'the year filter keeps that year');
  const action = await httpSend(srv.port, 'GET', `${shelfPath}&Genres=Action`, { headers: { authorization: authz } });
  assert.deepStrictEqual(action.json.Items.map((row) => row.Name), ['Aardvark'], 'the genre filter keeps Action');
  const actionId = await httpSend(srv.port, 'GET', `${shelfPath}&GenreIds=28`, { headers: { authorization: authz } });
  assert.deepStrictEqual(actionId.json.Items.map((row) => row.Name), ['Aardvark'], 'the app genre number keeps Action');
  const letter = await httpSend(srv.port, 'GET', `${shelfPath}&NameStartsWith=Z`, { headers: { authorization: authz } });
  assert.deepStrictEqual(letter.json.Items.map((row) => row.Name), ['Zebra'], 'the letter filter keeps Z');
  const facets = await httpSend(srv.port, 'GET', `/Items/Filters2?ParentId=l${disk.json.id}`, { headers: { authorization: authz } });
  assert.ok(facets.json.Years.includes(1990) && facets.json.Years.includes(2024), 'the filter list offers the years on disk');
  assert.ok(facets.json.Genres.includes('Action'), 'the filter list offers Action');
  const aardvark = movieShelf.json.Items.find((row) => row.Name === 'Aardvark');
  const cover = await httpSend(srv.port, 'GET', `/Items/${aardvark.Id}/Images/Primary`);
  assert.strictEqual(cover.status, 200, 'the poster picture loads without a login header');
  assert.match(cover.headers['content-type'], /jpeg/, 'a jpg named like the movie is the cover');
  assert.strictEqual(aardvark.ImageTags.Primary, 'disk2');
  const limited = await httpJson(srv.port, 'PATCH', `/api/libraries/${disk.json.id}`, { users: ['someone-else'] }, admin);
  assert.strictEqual(limited.status, 200);
  const limitedCover = await httpSend(srv.port, 'GET', `/Items/${aardvark.Id}/Images/Primary`);
  assert.strictEqual(limitedCover.status, 200, 'a library limited to one account still shows its cover');
  await httpJson(srv.port, 'PATCH', `/api/libraries/${disk.json.id}`, { users: [] }, admin);
  const played = await httpSend(srv.port, 'POST', `/Users/${me.json.Id}/PlayedItems/${aardvark.Id}`, { headers: { authorization: authz } });
  assert.strictEqual(played.json.Played, true);
  const playedShelf = await httpSend(srv.port, 'GET', `${shelfPath}&Filters=IsPlayed`, { headers: { authorization: authz } });
  assert.deepStrictEqual(playedShelf.json.Items.map((row) => row.Name), ['Aardvark']);
  const freshShelf = await httpSend(srv.port, 'GET', `${shelfPath}&Filters=IsUnplayed`, { headers: { authorization: authz } });
  assert.ok(!freshShelf.json.Items.some((row) => row.Name === 'Aardvark'), 'played movies leave the unplayed filter');
  const zebra = movieShelf.json.Items.find((row) => row.Name === 'Zebra');
  const heart = await httpSend(srv.port, 'POST', `/Users/${me.json.Id}/FavoriteItems/${zebra.Id}`, { headers: { authorization: authz } });
  assert.strictEqual(heart.json.IsFavorite, true);
  const hearts = await httpSend(srv.port, 'GET', `${shelfPath}&Filters=IsFavorite`, { headers: { authorization: authz } });
  assert.deepStrictEqual(hearts.json.Items.map((row) => row.Name), ['Zebra']);
  const homeHearts = await httpSend(srv.port, 'GET', `/Users/${me.json.Id}/Items?Filters=IsFavorite&IncludeItemTypes=Movie&Recursive=true`, { headers: { authorization: authz } });
  assert.ok(homeHearts.json.Items.some((row) => row.Name === 'Zebra'), 'Home favorites includes a disk movie');
  const tracks = mediaStreamsFromProbe({
    video: [{ codec: 'h264', height: 800 }],
    audio: [{ codec: 'aac', lang: 'eng', channels: 2 }, { codec: 'ac3', lang: 'fas', title: 'Persian', channels: 6 }],
  });
  assert.strictEqual(tracks[0].DisplayTitle, '800p');
  assert.strictEqual(tracks[0].IsInterlaced, false);
  assert.strictEqual(tracks[0].IsForced, false);
  assert.strictEqual(tracks[0].IsExternal, false);
  assert.strictEqual(tracks[0].IsTextSubtitleStream, false);
  assert.strictEqual(tracks[0].SupportsExternalStream, false);
  assert.strictEqual(tracks[2].DisplayTitle, 'Persian');
  assert.strictEqual(tracks[2].Index, 2);
  const showShelf = await httpSend(srv.port, 'GET', `/Users/${me.json.Id}/Items?ParentId=l${shows.json.id}&IncludeItemTypes=Series&Recursive=true&Limit=10`, { headers: { authorization: authz } });
  assert.strictEqual(showShelf.status, 200);
  assert.strictEqual(showShelf.json.TotalRecordCount, 1, 'a scanned show library lists the show, not every episode');
  assert.strictEqual(showShelf.json.Items[0].Name, 'Day Show');
  assert.strictEqual(showShelf.json.Items[0].Type, 'Series');
  // Jellyfin 10.9+ apps (Swiftfin on Apple TV, current Roku) use the new paths.
  const newHeart = await httpSend(srv.port, 'POST', `/UserFavoriteItems/${aardvark.Id}`, { headers: { authorization: authz } });
  assert.strictEqual(newHeart.status, 200, 'the new heart path answers');
  assert.strictEqual(newHeart.json.IsFavorite, true);
  const newUnheart = await httpSend(srv.port, 'DELETE', `/UserFavoriteItems/${aardvark.Id}`, { headers: { authorization: authz } });
  assert.strictEqual(newUnheart.json.IsFavorite, false);
  const newUnplayed = await httpSend(srv.port, 'DELETE', `/UserPlayedItems/${aardvark.Id}`, { headers: { authorization: authz } });
  assert.strictEqual(newUnplayed.json.Played, false, 'the new unwatched path clears the mark');
  const newPlayed = await httpSend(srv.port, 'POST', `/UserPlayedItems/${aardvark.Id}`, { headers: { authorization: authz } });
  assert.strictEqual(newPlayed.json.Played, true, 'the new watched path sets the mark');
  const viaData = await httpSend(srv.port, 'POST', `/UserItems/${aardvark.Id}/UserData`, {
    headers: { authorization: authz, 'content-type': 'application/json' }, body: JSON.stringify({ IsFavorite: true, Played: false }),
  });
  assert.strictEqual(viaData.json.IsFavorite, true);
  assert.strictEqual(viaData.json.Played, false);
  const features = await httpSend(srv.port, 'GET', `/Items/${aardvark.Id}/SpecialFeatures`, { headers: { authorization: authz } });
  assert.strictEqual(features.status, 200, 'the Roku detail page reads special features');
  assert.ok(Array.isArray(features.json), 'special features is a list, not an error object');
  for (const p of ['/Genres', '/Persons', '/Studios', '/Artists', '/Playlists', '/MusicGenres', '/Years']) {
    const page = await httpSend(srv.port, 'GET', p, { headers: { authorization: authz } });
    assert.strictEqual(page.status, 200, `${p} answers`);
    assert.ok(page.json && Array.isArray(page.json.Items), `${p} answers JSON with an Items list, not the website page`);
  }
  const filtersOld = await httpSend(srv.port, 'GET', '/Items/Filters', { headers: { authorization: authz } });
  assert.ok(filtersOld.json && Array.isArray(filtersOld.json.Genres), '/Items/Filters answers like Filters2');
  const ping = await httpSend(srv.port, 'POST', '/Sessions/Playing/Ping', { headers: { authorization: authz } });
  assert.strictEqual(ping.status, 204, 'the play ping is acknowledged');
  const noToken = await httpSend(srv.port, 'POST', `/UserFavoriteItems/${aardvark.Id}`);
  assert.strictEqual(noToken.status, 401, 'the new heart path needs a login');
  const showHeart = await httpSend(srv.port, 'POST', `/Users/${me.json.Id}/FavoriteItems/${showShelf.json.Items[0].Id}`, { headers: { authorization: authz } });
  assert.strictEqual(showHeart.json.IsFavorite, true);
  const showHearts = await httpSend(srv.port, 'GET', `/Users/${me.json.Id}/Items?Filters=IsFavorite&IncludeItemTypes=Series&Recursive=true`, { headers: { authorization: authz } });
  assert.deepStrictEqual(showHearts.json.Items.map((row) => row.Name), ['Day Show'], 'Home favorites includes the show');
  const episodes = await httpSend(srv.port, 'GET', `/Shows/${showShelf.json.Items[0].Id}/Episodes`, { headers: { authorization: authz } });
  const first = episodes.json.Items.find((row) => row.IndexNumber === 1);
  const second = episodes.json.Items.find((row) => row.IndexNumber === 2);
  assert.ok(first && second, 'the show has two episodes');
  assert.ok(second.BackdropImageTags && second.BackdropImageTags.length, 'Next Up asks for a wide picture');
  const episodeStill = await httpSend(srv.port, 'GET', `/Items/${second.Id}/Images/Backdrop`, {
    headers: { host: '10.1.20.120:7777' },
  });
  assert.strictEqual(episodeStill.status, 200, 'an episode with no still uses the show picture from this server');
  assert.match(String(episodeStill.headers['content-type'] || ''), /^image\/jpeg/);
  assert.strictEqual(episodeStill.headers.location, undefined, 'the house IP must not send the TV to another site for the picture');
  assert.match(String(episodeStill.headers['x-triboon-poster'] || ''), /dayshow-wide\.jpg/);
  const episodePoster = await httpSend(srv.port, 'GET', `/Items/${second.Id}/Images/Primary`);
  assert.strictEqual(episodePoster.status, 200);
  assert.match(String(episodePoster.headers['x-triboon-poster'] || ''), /dayshow\.jpg/);
  const watchedEp = await httpSend(srv.port, 'POST', `/Users/${me.json.Id}/PlayedItems/${first.Id}`, { headers: { authorization: authz } });
  assert.strictEqual(watchedEp.status, 200);
  assert.strictEqual(watchedEp.json.Played, true);
  assert.match(String(watchedEp.json.ItemId || ''), /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'mark watched must hand back an id the TV app can read');
  assert.strictEqual(typeof watchedEp.json.PlaybackPositionTicks, 'number');
  assert.strictEqual(typeof watchedEp.json.UnplayedItemCount, 'number');
  const seasons = await httpSend(srv.port, 'GET', `/Shows/${showShelf.json.Items[0].Id}/Seasons`, { headers: { authorization: authz } });
  const season = (seasons.json.Items || [])[0];
  assert.ok(season && season.Id, 'the show has a season to mark');
  const watchedSeason = await httpSend(srv.port, 'POST', `/Users/${me.json.Id}/PlayedItems/${season.Id}`, { headers: { authorization: authz } });
  assert.strictEqual(watchedSeason.status, 200, 'marking a season watched must not close the app');
  assert.strictEqual(watchedSeason.json.Played, true);
  const seasonHeart = await httpSend(srv.port, 'POST', `/Users/${me.json.Id}/FavoriteItems/${season.Id}`, { headers: { authorization: authz } });
  assert.strictEqual(seasonHeart.status, 200, 'a season favorite must not close the app');
  assert.strictEqual(seasonHeart.json.IsFavorite, true);
  assert.strictEqual(seasonHeart.json.Played, true, 'favoriting keeps the watched mark');
  const nextUp = await httpSend(srv.port, 'GET', `/Shows/NextUp?UserId=${me.json.Id}`, { headers: { authorization: authz } });
  assert.strictEqual(nextUp.status, 200);
  const nextCard = nextUp.json.Items.find((row) => row.Id === second.Id);
  assert.ok(nextCard, 'finishing episode 1 offers episode 2 on Play Next');
  assert.strictEqual(nextCard.SeriesName, 'Day Show', 'Play Next says the show name');
  assert.strictEqual(nextCard.ParentIndexNumber, 1);
  assert.strictEqual(nextCard.IndexNumber, 2);
  const homeNext = await httpSend(srv.port, 'GET', `/Users/${me.json.Id}/Items/Resume`, { headers: { authorization: authz } });
  assert.ok(homeNext.json.Items.some((row) => row.Id === second.Id),
    'finishing a custom-library episode puts the next one on Continue Watching');
  const pausedEp = await httpSend(srv.port, 'POST', '/Sessions/Playing/Progress', {
    headers: { authorization: authz, 'content-type': 'application/json' },
    body: JSON.stringify({ ItemId: second.Id, PositionTicks: 90 * 10000000 }),
  });
  assert.strictEqual(pausedEp.status, 204);
  // Jellyfin Roku reads these fields with no guard on Home and detail cards
  // (HomeData.bs: UserData.Played, ImageTags.Primary, BackdropImageTags[0]).
  // One missing object is a BrightScript crash that closes the channel.
  const rokuReads = [
    ['movie shelf', movieShelf.json.Items], ['show shelf', showShelf.json.Items],
    ['episodes', episodes.json.Items], ['seasons', seasons.json.Items],
    ['next up', nextUp.json.Items], ['resume', homeNext.json.Items],
  ];
  for (const latestPath of [`/Users/${me.json.Id}/Items/Latest`, '/Items/Latest']) {
    const latest = await httpSend(srv.port, 'GET', latestPath, { headers: { authorization: authz } });
    rokuReads.push([latestPath, Array.isArray(latest.json) ? latest.json : (latest.json && latest.json.Items) || []]);
  }
  for (const [where, rows] of rokuReads) {
    for (const row of rows) {
      const tag = `${where}: ${row.Name}`;
      assert.ok(row.UserData && typeof row.UserData === 'object', `${tag} has UserData`);
      assert.strictEqual(typeof row.UserData.Played, 'boolean', `${tag} UserData.Played`);
      assert.ok(row.ImageTags && typeof row.ImageTags === 'object', `${tag} has ImageTags`);
      assert.ok(Array.isArray(row.BackdropImageTags), `${tag} has BackdropImageTags list`);
      assert.strictEqual(typeof row.Name, 'string', `${tag} Name`);
      assert.strictEqual(typeof row.Id, 'string', `${tag} Id`);
    }
  }
  // The Roku title page loops People, MediaStreams and Studios with no check.
  for (const [label, id, lists] of [
    ['movie', aardvark.Id, ['People', 'Genres', 'Studios', 'MediaStreams', 'MediaSources']],
    ['episode', second.Id, ['People', 'Genres', 'Studios', 'MediaStreams', 'MediaSources']],
    ['show', showShelf.json.Items[0].Id, ['People', 'Genres', 'Studios', 'AirDays']],
    ['season', season.Id, ['People', 'Genres', 'Studios']],
  ]) {
    const detail = await httpSend(srv.port, 'GET', `/Items/${id}?userId=${me.json.Id}&fields=Chapters,Trickplay`, { headers: { authorization: authz } });
    assert.strictEqual(detail.status, 200, `${label} detail answers`);
    for (const key of lists) assert.ok(Array.isArray(detail.json[key]), `${label} detail carries a ${key} list (Roku loops it without a check)`);
  }
  for (const [where, rows] of rokuReads) {
    for (const row of rows) {
      if (row.Type === 'Movie' || row.Type === 'Episode') {
        assert.ok(Array.isArray(row.MediaStreams) && Array.isArray(row.People), `${where}: ${row.Name} carries MediaStreams and People`);
      }
    }
  }
  const homeAfterPause = await httpSend(srv.port, 'GET', `/Users/${me.json.Id}/Items/Resume`, { headers: { authorization: authz } });
  const pausedCard = homeAfterPause.json.Items.find((row) => row.Id === second.Id);
  assert.ok(pausedCard, 'the paused episode is on Continue Watching');
  assert.strictEqual(pausedCard.SeriesName, 'Day Show');
  assert.strictEqual(pausedCard.UserData.PlaybackPositionTicks, 90 * 10000000);
  assert.ok(!homeAfterPause.json.Items.some((row) => row.Id === first.Id), 'a finished episode leaves Continue Watching');
  const nextAfterPause = await httpSend(srv.port, 'GET', `/Shows/NextUp?UserId=${me.json.Id}`, { headers: { authorization: authz } });
  assert.ok(!nextAfterPause.json.Items.some((row) => row.Id === second.Id), 'a paused episode is not also Play Next');

  const localId = mahour.Id;
  const progressBody = JSON.stringify({ ItemId: localId, PositionTicks: 120 * 10000000 });
  const saved = await httpSend(srv.port, 'POST', '/Sessions/Playing/Progress', {
    headers: { authorization: authz, 'content-type': 'application/json' },
    body: progressBody,
  });
  assert.strictEqual(saved.status, 204);
  const resume = await httpSend(srv.port, 'GET', `/Users/${me.json.Id}/Items/Resume`, { headers: { authorization: authz } });
  assert.strictEqual(resume.status, 200);
  const homeResume = await httpSend(srv.port, 'GET', `/UserItems/Resume?userId=${me.json.Id}`, { headers: { authorization: authz } });
  assert.strictEqual(homeResume.status, 200);
  fs.writeFileSync(path.join(artDir, 'Aardvark.mkv'), 'not-a-video');
  fs.writeFileSync(path.join(artDir, 'Aardvark.en.srt'), '1\n00:00:01,000 --> 00:00:02,000\nHello there\n');
  const playback = await httpSend(srv.port, 'POST', `/Items/${aardvark.Id}/PlaybackInfo`, {
    headers: { authorization: authz, 'content-type': 'application/json', host: '10.1.20.120:7777' },
    body: '{}',
  });
  assert.strictEqual(playback.status, 200);
  assert.match(playback.json.MediaSources[0].TranscodingUrl, /^\/api\/hls\//, 'each app adds the server it already signed into');
  assert.doesNotMatch(playback.json.MediaSources[0].TranscodingUrl, /^https?:/i, 'a full address gets glued on a second time and play asks for a missing page');
  assert.match(playback.json.MediaSources[0].TranscodingUrl, /\/api\/hls\//, 'Jellyfin plays short pieces so the computer does not hold the whole movie');
  assert.match(playback.json.MediaSources[0].TranscodingUrl, /\/master\.m3u8\?/, 'the phone only plays a playlist');
  assert.match(playback.json.MediaSources[0].TranscodingUrl, new RegExp(`/${String(aardvark.Id).toLowerCase()}/master\\.m3u8`), 'the phone reads the movie id from the address or play says source error');
  assert.strictEqual(playback.json.MediaSources[0].Type, 'Default');
  assert.strictEqual(playback.json.MediaSources[0].HasSegments, false);
  assert.strictEqual(playback.json.MediaSources[0].SupportsProbing, true);
  assert.strictEqual(playback.json.MediaSources[0].TranscodingSubProtocol, 'hls');
  assert.strictEqual(playback.json.MediaSources[0].Protocol, 'File', 'Android TV drops a remote source and then crashes on replay');
  const desktopPlay = await httpSend(srv.port, 'POST', `/Items/${aardvark.Id}/PlaybackInfo`, {
    headers: {
      authorization: authz,
      'x-emby-authorization': 'MediaBrowser Client="Emby", Device="Windows MOE-HOME", DeviceId="desk", Version="2.317.2.0"',
      'content-type': 'application/json',
      host: '10.1.20.120:7777',
    },
    body: '{}',
  });
  assert.strictEqual(desktopPlay.status, 200);
  assert.match(desktopPlay.json.MediaSources[0].TranscodingUrl, /^\/api\/hls\//, 'the desktop app adds the server address itself');
  assert.doesNotMatch(desktopPlay.json.MediaSources[0].TranscodingUrl, /^https?:/i);
  assert.strictEqual(desktopPlay.json.MediaSources[0].Protocol, 'Http');
  assert.strictEqual(desktopPlay.json.MediaSources[0].IsRemote, true);
  assert.strictEqual(playback.json.MediaSources[0].IsRemote, false);
  const tvPlay = await httpSend(srv.port, 'POST', `/Items/${aardvark.Id}/PlaybackInfo`, {
    headers: {
      authorization: authz,
      'content-type': 'application/json',
      host: '10.1.20.120:7777',
      'user-agent': 'Mozilla/5.0 (Linux; Android 11; onn) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
      'x-emby-authorization': 'MediaBrowser Client="Jellyfin Android TV", Device="onn", DeviceId="tv", Version="0.19.10"',
    },
    body: JSON.stringify({ MediaSourceId: aardvark.Id }),
  });
  assert.strictEqual(tvPlay.status, 200);
  assert.strictEqual(tvPlay.json.MediaSources[0].Protocol, 'File', 'the guest-room TV still needs a file-shaped source');
  assert.strictEqual(tvPlay.json.MediaSources[0].IsRemote, false);
  assert.strictEqual(tvPlay.json.MediaSources[0].Id, aardvark.Id);
  assert.match(tvPlay.json.MediaSources[0].TranscodingUrl, /^\/api\/hls\//, 'the TV adds the server itself, so a full address becomes two addresses');
  assert.doesNotMatch(tvPlay.json.MediaSources[0].TranscodingUrl, /^https?:/i);
  assert.match(tvPlay.json.MediaSources[0].TranscodingUrl, /master\.m3u8/);
  const tvSource = tvPlay.json.MediaSources[0];
  const tvAudio = (tvSource.MediaStreams || []).filter((row) => row.Type === 'Audio');
  assert.ok(tvAudio.length, 'the TV needs an audio row to pick');
  assert.ok(tvAudio.some((row) => row.Index === tvSource.DefaultAudioStreamIndex),
    'without the chosen audio the TV reads -1, switches to track 1, restarts, and loops forever');
  const rokuPlay = await httpSend(srv.port, 'POST', `/Items/${aardvark.Id}/PlaybackInfo`, {
    headers: {
      authorization: authz,
      'content-type': 'application/json',
      host: '10.1.20.120:7777',
      'x-emby-authorization': 'MediaBrowser Client="Jellyfin Roku", Device="Roku", DeviceId="roku1", Version="2.0"',
    },
    body: JSON.stringify({ MediaSourceId: aardvark.Id }),
  });
  assert.strictEqual(rokuPlay.status, 200);
  assert.match(rokuPlay.json.MediaSources[0].TranscodingUrl, /^\/api\/hls\//, 'Roku glues the server on the front of whatever we send');
  assert.doesNotMatch(rokuPlay.json.MediaSources[0].TranscodingUrl, /^https?:/i);
  assert.strictEqual(rokuPlay.json.MediaSources[0].Protocol, 'File');
  const replay = await httpSend(srv.port, 'POST', `/Items/${aardvark.Id}/PlaybackInfo`, {
    headers: { authorization: authz, 'content-type': 'application/json' },
    body: JSON.stringify({ MediaSourceId: aardvark.Id }),
  });
  assert.strictEqual(replay.status, 200);
  assert.strictEqual(replay.json.MediaSources[0].Id, aardvark.Id, 'replay must hand back the same source id or the TV crashes');
  const dragged = await httpSend(srv.port, 'POST', `/Items/${aardvark.Id}/PlaybackInfo`, {
    headers: { authorization: authz, 'content-type': 'application/json' },
    body: JSON.stringify({ MediaSourceId: aardvark.Id, StartTimeTicks: 600 * 10000000 }),
  });
  assert.strictEqual(dragged.status, 200);
  assert.match(dragged.json.MediaSources[0].TranscodingUrl, /start=600/, 'a Jellyfin seek bar drag starts at that minute');
  assert.strictEqual(replay.json.MediaSources[0].Protocol, 'File');
  assert.strictEqual(replay.json.MediaSources[0].IsRemote, false);
  const sub = (playback.json.MediaSources[0].MediaStreams || []).find((row) => row.Type === 'Subtitle');
  assert.ok(sub && sub.DeliveryMethod === 'External', 'Jellyfin CC sees the subtitle file beside the movie');
  assert.match(sub.DeliveryUrl, new RegExp(`^/videos/${aardvark.Id}/`), 'the app adds the server onto the caption path');
  assert.doesNotMatch(sub.DeliveryUrl, /^https?:/i);
  assert.strictEqual(sub.IsTextSubtitleStream, true);
  assert.strictEqual(sub.SupportsExternalStream, true);
  assert.strictEqual(sub.IsDefault, false, 'the phone player needs IsDefault on every track or play dies');
  assert.ok((playback.json.MediaSources[0].MediaStreams || []).every((row) => typeof row.IsDefault === 'boolean'));
  assert.strictEqual(sub.DisplayTitle, 'English');
  const vtt = await httpSend(srv.port, 'GET', `/Videos/${aardvark.Id}/${playback.json.MediaSources[0].Id}/Subtitles/${sub.Index}/Stream.vtt`, {
    headers: { authorization: authz },
  });
  assert.strictEqual(vtt.status, 200);
  assert.match(vtt.raw, /Hello there/);
  assert.ok(homeResume.json.Items.some((row) => row.Id === localId), 'Home Continue Watching uses UserItems/Resume');
  const listening = await httpSend(srv.port, 'GET', `/UserItems/Resume?userId=${me.json.Id}&MediaTypes=Audio`, { headers: { authorization: authz } });
  assert.strictEqual(listening.status, 200);
  assert.strictEqual(listening.json.TotalRecordCount, 0, 'Continue Listening is for music, not these movies');
  const resumed = resume.json.Items.find((row) => row.Id === localId);
  assert.ok(resumed, 'a stopped movie shows on Continue Watching');
  assert.strictEqual(resumed.Name, 'Mahour');
  const trakt = await httpJson(srv.port, 'POST', '/api/watch', {
    key: 'tmdb:movie:424242',
    position: 0,
    duration: 0,
    traktPct: 40,
    meta: { title: 'Trakt Movie', type: 'movie', tmdbId: 424242 },
  }, admin);
  assert.strictEqual(trakt.status, 200);
  const withTrakt = await httpSend(srv.port, 'GET', `/Users/${me.json.Id}/Items/Resume`, { headers: { authorization: authz } });
  const traktCard = withTrakt.json.Items.find((row) => row.Name === 'Trakt Movie');
  assert.ok(traktCard, 'a Trakt percent on the website is on the Jellyfin row');
  assert.strictEqual(traktCard.UserData.PlayedPercentage, 40);
  const account = await httpJson(srv.port, 'GET', '/api/me', null, admin);
  const appProfile = ((account.json && account.json.profiles) || []).find((p) => (p.level ?? 4) >= 4);
  assert.ok(appProfile && appProfile.id && appProfile.id !== 'default', 'the Triboon app profile is not named default');
  const phoneWatch = await httpJson(srv.port, 'POST', '/api/watch', {
    key: 'tmdb:movie:550550',
    profile: appProfile.id,
    position: 400,
    duration: 2000,
    meta: { title: 'Phone Movie', type: 'movie', tmdbId: 550550 },
  }, admin);
  assert.strictEqual(phoneWatch.status, 200);
  const fromPhone = await httpSend(srv.port, 'GET', `/Users/${me.json.Id}/Items/Resume`, { headers: { authorization: authz } });
  assert.ok(fromPhone.json.Items.some((row) => row.Name === 'Phone Movie'),
    'a movie paused in the Triboon app shows on the Jellyfin Continue Watching row');
  const kid = await httpJson(srv.port, 'POST', '/api/me/profiles', { name: 'Kid', level: 0 }, admin);
  assert.strictEqual(kid.status, 200);
  assert.ok(kid.json && kid.json.id);
  await httpJson(srv.port, 'POST', '/api/watch', {
    key: 'tmdb:movie:660660',
    profile: kid.json.id,
    position: 400,
    duration: 2000,
    meta: { title: 'Kid Movie Hidden', type: 'movie', tmdbId: 660660 },
  }, admin);
  const afterKid = await httpSend(srv.port, 'GET', `/Users/${me.json.Id}/Items/Resume`, { headers: { authorization: authz } });
  assert.ok(!afterKid.json.Items.some((row) => row.Name === 'Kid Movie Hidden'),
    'a kids-profile pause stays off the Jellyfin row');
  const early = await httpJson(srv.port, 'POST', '/api/watch', {
    key: 'tmdb:tv:77:s1e1',
    position: 400,
    duration: 2000,
    meta: { title: 'Same Show', type: 'episode', tmdbId: 77, episodeTitle: 'First' },
  }, admin);
  assert.strictEqual(early.status, 200);
  const later = await httpJson(srv.port, 'POST', '/api/watch', {
    key: 'tmdb:tv:77:s1e2',
    position: 800,
    duration: 2000,
    meta: { title: 'Same Show', type: 'episode', tmdbId: 77, episodeTitle: 'Second' },
  }, admin);
  assert.strictEqual(later.status, 200);
  const oneShow = await httpSend(srv.port, 'GET', `/Users/${me.json.Id}/Items/Resume`, { headers: { authorization: authz } });
  const showCards = oneShow.json.Items.filter((row) => row.SeriesName === 'Same Show');
  assert.strictEqual(showCards.length, 1, 'two paused episodes of one show are one Continue Watching card');
  assert.strictEqual(showCards[0].Name, 'Second', 'the card is the episode you touched last');
  assert.strictEqual(showCards[0].IndexNumber, 2);
  assert.strictEqual(resumed.UserData.PlaybackPositionTicks, 120 * 10000000);
  const again = await httpSend(srv.port, 'GET', `/Items/${localId}`, { headers: { authorization: authz } });
  assert.strictEqual(again.json.UserData.PlaybackPositionTicks, 120 * 10000000, 'the details page offers Resume');
  const triboonHome = await httpJson(srv.port, 'GET', `/api/watch?profile=${encodeURIComponent(appProfile.id)}`, null, admin);
  const mahourAtHome = triboonHome.json.find((row) => row.key === `local:${disk.json.id}:0`);
  assert.ok(mahourAtHome && mahourAtHome.position === 120, 'a pause in the Jellyfin app shows when you open Triboon');
  const browserWatch = await httpJson(srv.port, 'POST', '/api/watch', {
    key: `local:${disk.json.id}:3`,
    position: 90,
    duration: 3600,
    meta: { title: 'Zebra' },
  }, admin);
  assert.strictEqual(browserWatch.status, 200);
  const fromBrowser = await httpSend(srv.port, 'GET', `/Users/${me.json.Id}/Items/Resume`, { headers: { authorization: authz } });
  const zebraResume = fromBrowser.json.Items.find((row) => row.Name === 'Zebra');
  assert.ok(zebraResume, 'a pause in the browser shows on the Jellyfin continue watching row');
  assert.strictEqual(zebraResume.UserData.PlaybackPositionTicks, 90 * 10000000);
  assert.strictEqual(zebraResume.UserData.ItemId, zebraResume.Id);
  assert.match(zebraResume.UserData.Key, /^l[0-9a-f]{10}i3$/);
  const sameA = await httpJson(srv.port, 'POST', '/api/watch', {
    key: `local:${disk.json.id}:0`,
    position: 50,
    duration: 1000,
    meta: { title: 'Same Name', type: 'movie', year: 2024 },
  }, admin);
  const sameB = await httpJson(srv.port, 'POST', '/api/watch', {
    key: `local:${disk.json.id}:3`,
    position: 80,
    duration: 1000,
    meta: { title: 'Same Name', type: 'movie', year: 2020 },
  }, admin);
  assert.strictEqual(sameA.status, 200);
  assert.strictEqual(sameB.status, 200);
  const keptApart = await httpSend(srv.port, 'GET', `/Users/${me.json.Id}/Items/Resume`, { headers: { authorization: authz } });
  assert.ok(keptApart.json.Items.some((row) => row.Id === localId), 'a custom-library movie stays on Continue Watching');
  assert.ok(keptApart.json.Items.some((row) => row.Name === 'Zebra'),
    'two folder movies with the same saved title stay two Continue Watching cards');
  const artStamp = (await httpJson(srv.port, 'GET', '/api/watch', null, admin)).json.find((row) => row.key === `local:${disk.json.id}:3`);
  const artOnly = await httpJson(srv.port, 'POST', '/api/watch', {
    key: `local:${disk.json.id}:3`,
    position: 80,
    duration: 1000,
    artOnly: true,
    meta: { title: 'Zebra', poster: 'https://image.tmdb.org/t/p/w780/zebra.jpg' },
  }, admin);
  assert.strictEqual(artOnly.status, 200);
  const artAfter = (await httpJson(srv.port, 'GET', '/api/watch', null, admin)).json.find((row) => row.key === `local:${disk.json.id}:3`);
  assert.strictEqual(artAfter.updatedAt, artStamp.updatedAt, 'fixing a thumbnail does not reshuffle Continue Watching');
  assert.strictEqual(artAfter.meta.poster, 'https://image.tmdb.org/t/p/w780/zebra.jpg');

  const mountsBefore = srv.mounts.size;
  const live = await openJfSocket(srv.port, `/socket?api_key=${encodeURIComponent(token)}`);
  const hello = JSON.parse(live.first);
  assert.strictEqual(hello.MessageType, 'ForceKeepAlive', 'the phone is told how often to check in');
  assert.strictEqual(hello.Data, 60);
  assert.match(hello.MessageId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'Android TV closes if the hello has no id');
  const reply = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no keepalive')), 3000);
    live.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.MessageType !== 'KeepAlive') return;
      clearTimeout(timer);
      resolve(msg);
    });
    live.ws.send(JSON.stringify({ MessageType: 'KeepAlive' }));
    live.ws.send(JSON.stringify({ MessageType: 'Play', Data: { ItemIds: ['nope'] } }));
  });
  assert.strictEqual(reply.MessageType, 'KeepAlive');
  assert.match(reply.MessageId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  assert.strictEqual(srv.mounts.size, mountsBefore, 'a live-line play command does not start a movie');
  await new Promise((resolve) => {
    live.ws.addEventListener('close', () => resolve());
    live.ws.close();
  });
  await assert.rejects(openJfSocket(srv.port, '/socket?api_key=nope'), /closed|timeout/);
  const plain = await httpSend(srv.port, 'GET', '/socket', { headers: { authorization: authz } });
  assert.strictEqual(plain.status, 426, 'a normal page load is not the live line');
  const anonSocket = await httpSend(srv.port, 'GET', '/socket');
  assert.strictEqual(anonSocket.status, 401);
  const wired = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
  assert.match(wired, /attachJellyfinSocket\(server\)/, 'the live line stays wired to the server');

  const shut = await httpJson(srv.port, 'POST', '/api/settings', { jellyfinApps: false }, admin);
  assert.strictEqual(shut.status, 200);
  assert.strictEqual((await httpJson(srv.port, 'GET', '/api/settings', null, admin)).json.jellyfinApps, false);
  assert.strictEqual((await httpSend(srv.port, 'GET', '/System/Info/Public')).status, 404);
  await assert.rejects(openJfSocket(srv.port, `/socket?api_key=${encodeURIComponent(token)}`), /closed|timeout/);

  for (const route of JELLYFIN_ROUTES) {
    assert.ok(['public', 'user'].includes(route.auth), `jellyfin route ${route.re} declares auth`);
    assert.ok(srv.ROUTES.some((r) => r.re === route.re && r.m === route.m), 'the route table lists the jellyfin door');
  }
});

test('jellyfin door closes with the server', async () => {
  if (srv) await srv.shutdown();
  // The live line finishes closing a moment later. Quitting in that moment
  // crashes the Windows check, so this wait stays.
  await new Promise((resolve) => setTimeout(resolve, 50));
});

// Drives the door with stand-in helpers, so a usenet play needs no provider.
let fakeMounts = 0;
function fakeDoor(extra = {}) {
  const calls = { play: 0, prepare: 0, saved: [], order: [] };
  const live = new Set(extra.live || []);
  const shows = extra.shows || {};
  bindJellyfin({
    settings: { get: () => ({ jellyfinApps: true }) },
    auth: {},
    send: (res, status, body, headers) => { res.status = status; res.body = body; res.headers = headers; },
    readJson: async (req) => req.body || {},
    throttled: () => false,
    clientIp: () => '127.0.0.1',
    tmdb: {
      get: async (p) => {
        if (p === '/movie/550') return { title: 'Fight Club', release_date: '1999-10-15', runtime: 139 };
        if (shows[p]) return shows[p];
        return null;
      },
    },
    jellyfinStream: (id) => (live.has(id) ? {
      hlsUrl: `/api/hls/${id}?t=x`, remuxUrl: '', streamUrl: `/api/stream/${id}?t=x`, name: 'Movie.1080p.mkv', size: 2e9,
    } : null),
    jellyfinMarkDirect: (id, on) => { calls.direct = { id, on }; },
    jellyfinPrepare: async () => {
      calls.prepare += 1;
      calls.order.push('prepare');
      if (extra.prepareMs) await new Promise((r) => setTimeout(r, extra.prepareMs));
      calls.order.push('prepared');
    },
    jellyfinPlay: async () => {
      calls.play += 1;
      calls.order.push('play');
      fakeMounts += 1;
      const id = `mount${fakeMounts}`;
      calls.mounts = [...(calls.mounts || []), id];
      live.add(id);
      return { status: 200, body: {
        id, hlsUrl: `/api/hls/${id}?t=x`, streamUrl: `/api/stream/${id}?t=x`,
        name: 'Movie.1080p.mkv', size: 2e9, sessionId: `s${calls.play}`,
      } };
    },
    jellyfinSubtitleStreams: extra.subs ? async (_ctx, _id, start) => [{ Index: start, Type: 'Subtitle', Codec: 'webvtt', Language: 'en', IsExternal: true, DeliveryMethod: 'External' }] : undefined,
    jellyfinTracks: extra.tracks,
    jellyfinWatchGet: () => ({}),
    jellyfinWatchSave: (_ctx, key, patch) => calls.saved.push({ key, ...patch }),
  });
  const call = async (kind, method, p, { body, headers } = {}) => {
    const url = new URL(`http://x${p}`);
    const route = JELLYFIN_ROUTES.find((r) => r.kind === kind && r.m === method && r.re.test(url.pathname.toLowerCase()));
    assert.ok(route, `route for ${method} ${p}`);
    const res = {
      writeHead(status, h) { res.status = status; res.headers = h; },
      end() {},
    };
    const ctx = {
      req: { headers: headers || {}, body },
      res,
      url,
      m: route.re.exec(url.pathname.toLowerCase()),
      kind,
      user: { id: 'u1', role: 'user' },
    };
    await route.h(ctx);
    return res;
  };
  return { calls, live, call };
}

test('jellyfin CORS lets a browser app unheart and reflects asked headers', () => {
  const plain = jellyfinCors();
  assert.match(plain['access-control-allow-methods'], /\bDELETE\b/, 'unfavorite is a DELETE');
  for (const name of ['X-Emby-Client', 'X-Emby-Device-Name', 'X-Emby-Device-Id', 'X-Emby-Client-Version', 'X-MediaBrowser-Token', 'X-Emby-Authorization']) {
    assert.ok(plain['access-control-allow-headers'].includes(name), `${name} is allowed`);
  }
  const asked = jellyfinCors({ headers: { 'access-control-request-headers': 'x-emby-authorization, x-custom-thing' } });
  assert.strictEqual(asked['access-control-allow-headers'], 'x-emby-authorization, x-custom-thing');
  const junk = jellyfinCors({ headers: { 'access-control-request-headers': 'bad\r\nheader: x' } });
  assert.strictEqual(junk['access-control-allow-headers'], plain['access-control-allow-headers'], 'a broken ask falls back to the list');
});

test('jellyfin sign-in token works with or without quotes', () => {
  const quoted = jellyfinToken({ headers: { authorization: 'MediaBrowser Client="Roku", Token="abc123"' }, url: '/' });
  assert.strictEqual(quoted, 'abc123');
  const bare = jellyfinToken({ headers: { authorization: 'MediaBrowser Client="Roku", Token=abc123, Device="x"' }, url: '/' });
  assert.strictEqual(bare, 'abc123');
  const last = jellyfinToken({ headers: { 'x-emby-authorization': 'MediaBrowser Token=zz9' }, url: '/' });
  assert.strictEqual(last, 'zz9');
});

test('jellyfin second PlaybackInfo with the movie id reuses the live mount', async () => {
  const door = fakeDoor();
  const first = await door.call('playback', 'POST', '/Items/m550/PlaybackInfo', { body: { MediaSourceId: 'm550' } });
  assert.strictEqual(first.status, 200);
  assert.strictEqual(door.calls.play, 1);
  assert.strictEqual(first.body.MediaSources[0].Id, 'm550', 'the TV crashes unless the id it sent comes back');
  const again = await door.call('playback', 'POST', '/Items/m550/PlaybackInfo', { body: { MediaSourceId: 'm550', AudioStreamIndex: 1 } });
  assert.strictEqual(again.status, 200);
  assert.strictEqual(door.calls.play, 1, 'an audio switch must not start a second usenet search');
  assert.strictEqual(again.body.MediaSources[0].Id, 'm550');
  const [firstMount] = door.calls.mounts;
  assert.ok(again.body.MediaSources[0].TranscodingUrl.includes(`/api/hls/${firstMount}/`));
  door.live.delete(firstMount);
  const gone = await door.call('playback', 'POST', '/Items/m550/PlaybackInfo', { body: { MediaSourceId: 'm550' } });
  assert.strictEqual(gone.status, 200);
  assert.strictEqual(door.calls.play, 2, 'a mount that is gone plays again');
  assert.ok(gone.body.MediaSources[0].TranscodingUrl.includes(`/api/hls/${door.calls.mounts[1]}/`));
  assert.strictEqual(gone.body.MediaSources[0].Id, 'm550');
});

test('jellyfin PlaybackInfo never waits behind a slow details warm-up', async () => {
  const door = fakeDoor({ prepareMs: 5000 });
  const started = Date.now();
  const res = await door.call('playback', 'POST', '/Items/m550/PlaybackInfo', { body: {} });
  assert.strictEqual(res.status, 200);
  assert.ok(Date.now() - started < 2000, 'play answers without waiting on the one-at-a-time warm-up');
  assert.strictEqual(door.calls.play, 1);
  assert.strictEqual(door.calls.prepare, 0, 'play joins a running warm-up itself; it does not start a second walk');
});

test('jellyfin PlaybackInfo says which caption is on, or -1', async () => {
  const door = fakeDoor({ subs: true });
  const off = await door.call('playback', 'POST', '/Items/m550/PlaybackInfo', { body: {} });
  assert.strictEqual(off.body.MediaSources[0].DefaultSubtitleStreamIndex, -1, 'no caption asked is -1, never missing');
  const sub = off.body.MediaSources[0].MediaStreams.find((row) => row.Type === 'Subtitle');
  assert.ok(sub);
  const on = await door.call('playback', 'POST', '/Items/m550/PlaybackInfo', { body: { MediaSourceId: 'm550', SubtitleStreamIndex: sub.Index } });
  assert.strictEqual(on.body.MediaSources[0].DefaultSubtitleStreamIndex, sub.Index);
  const missing = await door.call('playback', 'POST', '/Items/m550/PlaybackInfo', { body: { MediaSourceId: 'm550', SubtitleStreamIndex: 99 } });
  assert.strictEqual(missing.body.MediaSources[0].DefaultSubtitleStreamIndex, -1, 'a caption that is not there is off');
});

test('jellyfin audio switch mid-movie keeps the minute from PositionTicks', async () => {
  const door = fakeDoor();
  const body = await door.call('playback', 'POST', '/Items/m550/PlaybackInfo', { body: { MediaSourceId: 'm550', positionticks: 900 * 10000000 } });
  assert.match(body.body.MediaSources[0].TranscodingUrl, /start=900/);
  const query = await door.call('playback', 'POST', '/Items/m550/PlaybackInfo?PositionTicks=1200000000', { body: { MediaSourceId: 'm550' } });
  assert.match(query.body.MediaSources[0].TranscodingUrl, /start=120/);
  const both = await door.call('playback', 'POST', '/Items/m550/PlaybackInfo', { body: { MediaSourceId: 'm550', StartTimeTicks: 300 * 10000000, PositionTicks: 900 * 10000000 } });
  assert.match(both.body.MediaSources[0].TranscodingUrl, /start=300/, 'StartTimeTicks still wins when sent');
});

test('jellyfin usenet PlaybackInfo lists the real audio tracks once probed', async () => {
  const tracks = { video: [{ codec: 'hevc', height: 1080 }], audio: [{ codec: 'eac3', lang: 'eng', channels: 6 }, { codec: 'aac', lang: 'fre', title: 'French', channels: 2 }] };
  const door = fakeDoor({ tracks: async () => tracks });
  const res = await door.call('playback', 'POST', '/Items/m550/PlaybackInfo', { body: { MediaSourceId: 'm550', AudioStreamIndex: 2 } });
  const audio = res.body.MediaSources[0].MediaStreams.filter((row) => row.Type === 'Audio');
  assert.deepStrictEqual(audio.map((row) => row.Index), [1, 2]);
  assert.strictEqual(audio[1].DisplayTitle, 'French');
  assert.strictEqual(res.body.MediaSources[0].DefaultAudioStreamIndex, 2);
  assert.match(res.body.MediaSources[0].TranscodingUrl, /audio=1&/, 'the second audio row is the second track in the file');
  const slow = fakeDoor({ tracks: () => new Promise(() => {}) });
  const t0 = Date.now();
  const placeholder = await slow.call('playback', 'POST', '/Items/m550/PlaybackInfo', { body: {} });
  assert.ok(Date.now() - t0 < 3000, 'a slow probe does not hold up play');
  assert.strictEqual(placeholder.body.MediaSources[0].MediaStreams.filter((row) => row.Type === 'Audio').length, 1);
});

test('jellyfin all-episodes list is not cut at 12 seasons', async () => {
  const shows = { '/tv/77': { name: 'Long Show', seasons: Array.from({ length: 15 }, (_, i) => ({ season_number: i + 1 })) } };
  for (let s = 1; s <= 15; s++) shows[`/tv/77/season/${s}`] = { episodes: [{ episode_number: 1 }, { episode_number: 2 }, { episode_number: 3 }] };
  const door = fakeDoor({ shows });
  const all = await door.call('episodes', 'GET', '/Shows/t77/Episodes');
  assert.strictEqual(all.status, 200);
  assert.strictEqual(all.body.TotalRecordCount, 45);
  assert.strictEqual(all.body.Items.length, 45, 'season 13 to 15 are there too');
  const page = await door.call('episodes', 'GET', '/Shows/t77/Episodes?StartIndex=40&Limit=3');
  assert.strictEqual(page.body.Items.length, 3);
  assert.strictEqual(page.body.StartIndex, 40);
});

test('jellyfin movies and episodes carry a local source so a second play cannot crash Android TV', async () => {
  const shows = {
    '/tv/77': { name: 'Show', seasons: [{ season_number: 1 }] },
    '/tv/77/season/1': { episodes: [{ episode_number: 1 }, { episode_number: 2 }] },
    '/movie/550?append_to_response=credits,release_dates': { id: 550, title: 'Fight Club', release_date: '1999-10-15', runtime: 139 },
    '/tv/77?append_to_response=credits,content_ratings': { id: 77, name: 'Show', seasons: [{ season_number: 1 }] },
  };
  const door = fakeDoor({ shows });
  const eps = await door.call('episodes', 'GET', '/Shows/t77/Episodes');
  const movie = await door.call('item', 'GET', '/Items/m550');
  assert.strictEqual(movie.status, 200, JSON.stringify(movie.body));
  for (const item of [...eps.body.Items, movie.body]) {
    const src = item.MediaSources && item.MediaSources[0];
    assert.ok(src, `${item.Name || item.Id} has a source for the remembered audio language`);
    assert.strictEqual(src.Id, item.Id, 'PlaybackInfo echoes this id back');
    assert.strictEqual(src.Protocol, 'File');
    assert.strictEqual(src.IsRemote, false, 'Android TV drops remote sources');
    assert.ok(Array.isArray(src.MediaStreams) && src.MediaStreams.some((row) => row.Type === 'Audio'));
  }
  const show = await door.call('item', 'GET', '/Items/t77');
  assert.strictEqual(show.body.MediaSources, undefined, 'a show is not playable');
});

test('jellyfin playback start saves the minute like a progress report', async () => {
  const route = JELLYFIN_ROUTES.find((r) => r.m === 'POST' && r.re.test('/sessions/playing'));
  assert.strictEqual(route.kind, 'progress');
  const door = fakeDoor();
  const res = await door.call('progress', 'POST', '/Sessions/Playing', { body: { ItemId: 'm551', PositionTicks: 300 * 10000000 } });
  assert.strictEqual(res.status, 204);
  assert.strictEqual(door.calls.saved.length, 1);
  assert.strictEqual(door.calls.saved[0].position, 300);
  const empty = await door.call('progress', 'POST', '/Sessions/Playing', { body: { ItemId: 'm551', PositionTicks: 0 } });
  assert.strictEqual(empty.status, 204);
  assert.strictEqual(door.calls.saved.length, 1, 'a start at 0:00 does not overwrite the saved minute');
});

const TV_PROFILE = {
  MaxStreamingBitrate: 120000000,
  DirectPlayProfiles: [{ Type: 'Video', Container: 'mkv,mp4', VideoCodec: 'h264,hevc', AudioCodec: 'aac,ac3,eac3' }],
  CodecProfiles: [{
    Type: 'Video', Codec: 'hevc',
    Conditions: [{ Condition: 'EqualsAny', Property: 'VideoRangeType', Value: 'SDR|HDR10', IsRequired: false }],
  }],
};
const H264_FILE = {
  format: 'matroska,webm', bitRate: 9000000, duration: 2700,
  video: [{ codec: 'h264', profile: 'High', height: 1080, width: 1920, bitDepth: 8, level: 41, rangeType: 'SDR' }],
  audio: [{ codec: 'eac3', profile: '', lang: 'eng', channels: 6 }],
};

test('jellyfin app plays the original 1080p file when its own player can', async () => {
  const door = fakeDoor({ tracks: async () => H264_FILE });
  const res = await door.call('playback', 'POST', '/Items/m550/PlaybackInfo', {
    body: { MediaSourceId: 'm550', DeviceProfile: TV_PROFILE, StartTimeTicks: 2400 * 10000000 },
  });
  const src = res.body.MediaSources[0];
  assert.strictEqual(src.SupportsDirectPlay, true, 'no re-encode for a file the TV plays itself');
  assert.strictEqual(src.Container, 'mkv');
  assert.strictEqual(src.Bitrate, 9000000);
  assert.strictEqual(src.Size, 2e9);
  assert.strictEqual(src.Id, 'm550', 'Android TV still needs its own id back');
  assert.strictEqual(src.IsRemote, false);
  assert.ok(src.TranscodingUrl.includes('/api/hls/'), 'the encoded copy stays as the backup');
  assert.deepStrictEqual(door.calls.direct, { id: door.calls.mounts[0], on: true }, 'captions skip the encoded clock');
  assert.strictEqual(progressSeconds('u1', 'm550', 600), 600, 'the original file reports the real minute, so no resume shift');
  const video = src.MediaStreams.find((row) => row.Type === 'Video');
  assert.strictEqual(video.Width, 1920);
  assert.strictEqual(video.BitDepth, 8);
  assert.strictEqual(video.VideoRangeType, 'SDR');
});

test('jellyfin keeps the encoded copy when the app cannot play the file', async () => {
  const cases = [
    ['no profile sent', H264_FILE, {}],
    ['audio the TV lacks', { ...H264_FILE, audio: [{ codec: 'dts', channels: 6 }] }, { DeviceProfile: TV_PROFILE }],
    ['over the app bitrate', H264_FILE, { DeviceProfile: { ...TV_PROFILE, MaxStreamingBitrate: 4000000 } }],
    ['Dolby Vision on a TV without it', {
      ...H264_FILE, video: [{ codec: 'hevc', height: 1080, bitDepth: 10, rangeType: 'DOVI' }],
    }, { DeviceProfile: TV_PROFILE }],
    ['the app asked for the encoded copy', H264_FILE, { DeviceProfile: TV_PROFILE, EnableDirectPlay: false }],
    ['container the TV lacks', { ...H264_FILE, format: 'avi' }, { DeviceProfile: TV_PROFILE }],
  ];
  for (const [why, file, body] of cases) {
    const door = fakeDoor({ tracks: async () => file });
    const res = await door.call('playback', 'POST', '/Items/m550/PlaybackInfo', { body: { MediaSourceId: 'm550', ...body } });
    const src = res.body.MediaSources[0];
    assert.strictEqual(src.SupportsDirectPlay, false, why);
    assert.strictEqual(src.Container, 'mp4', why);
    assert.ok(src.TranscodingUrl.includes('/api/hls/'), why);
  }
  const hdr = fakeDoor({ tracks: async () => ({ ...H264_FILE, video: [{ codec: 'hevc', height: 1080, bitDepth: 10, rangeType: 'HDR10' }] }) });
  const ok = await hdr.call('playback', 'POST', '/Items/m550/PlaybackInfo', { body: { DeviceProfile: TV_PROFILE } });
  assert.strictEqual(ok.body.MediaSources[0].SupportsDirectPlay, true, 'HDR10 is on the TV list');
});

test('jellyfin static stream hands the app the ranged original file', async () => {
  const door = fakeDoor({ tracks: async () => H264_FILE });
  await door.call('playback', 'POST', '/Items/m550/PlaybackInfo', { body: { MediaSourceId: 'm550', DeviceProfile: TV_PROFILE } });
  const res = await door.call('video', 'GET', '/Videos/m550/stream.mkv?Static=true&MediaSourceId=m550', { headers: { host: 'tv.local:7777' } });
  assert.strictEqual(res.status, 302);
  assert.match(res.headers.location, new RegExp(`/api/stream/${door.calls.mounts[0]}\\?t=x$`));
  assert.strictEqual(door.calls.play, 1, 'the file the TV asks for is the mount PlaybackInfo already opened');
  const cold = fakeDoor();
  const fresh = await cold.call('video', 'GET', '/Videos/m550/stream?static=true&mediaSourceId=m550');
  assert.strictEqual(fresh.status, 302);
  assert.match(fresh.headers.location, /\/api\/stream\/mount\d+\?t=x$/);
  assert.strictEqual(cold.calls.play, 1);
  const encoded = await cold.call('video', 'GET', '/Videos/m550/stream?mediaSourceId=m550');
  assert.match(encoded.headers.location, /\/api\/hls\//, 'without static the app still gets the encoded copy');
});

test('jellyfin answers the lists Roku reads right before play', async () => {
  const door = fakeDoor();
  const trailers = await door.call('emptyList', 'GET', '/Items/m550/LocalTrailers');
  assert.strictEqual(trailers.status, 200);
  assert.deepStrictEqual(trailers.body, []);
  const userTrailers = await door.call('emptyList', 'GET', '/Users/u1u1/Items/m550/LocalTrailers');
  assert.deepStrictEqual(userTrailers.body, []);
  const images = await door.call('emptyList', 'GET', '/Items/m550/Images');
  assert.deepStrictEqual(images.body, []);
  const parts = await door.call('emptyItemPage', 'GET', '/Videos/m550/AdditionalParts');
  assert.strictEqual(parts.status, 200);
  assert.strictEqual(parts.body.TotalRecordCount, 0);
  assert.deepStrictEqual(parts.body.Items, []);
  const enc = await door.call('encodingConfig', 'GET', '/System/Configuration/Encoding');
  assert.strictEqual(enc.status, 200);
  assert.ok(JELLYFIN_ROUTES.some((r) => r.kind === 'shelf' && r.re.test('/items/')), 'Roku favorites ask /Items/ with a slash');
});
