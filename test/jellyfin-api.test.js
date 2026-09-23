'use strict';
// Jellyfin app door: off by default, same Triboon password, empty shelf, no usenet.

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { httpJson, bootServer, setupAdmin } = require('./helpers');
const { JELLYFIN_ROUTES, JELLYFIN_MAX_RANK, mediaStreamsFromProbe, tmdbSort, genreIdsFromNames } = require('../server/jellyfin-api');
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

test('jellyfin sort uses the first key, so release date is not treated as a name sort', () => {
  assert.strictEqual(tmdbSort('movie', { sortBy: 'PremiereDate,SortName', asc: false }), 'primary_release_date.desc');
  assert.strictEqual(tmdbSort('series', { sortBy: 'DateCreated,SortName', asc: false }), 'first_air_date.desc');
  assert.strictEqual(tmdbSort('movie', { sortBy: 'SortName', asc: true }), 'original_title.asc');
  assert.deepStrictEqual(genreIdsFromNames(['Action'], 'series'), [10759]);
  assert.deepStrictEqual(genreIdsFromNames(['Action'], 'movie'), [28]);
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
  assert.match(info.json.LocalAddress, /^http:\/\/127\.0\.0\.1:\d+$/);
  const behind = await httpSend(srv.port, 'GET', '/System/Info/Public', {
    headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'media.example' },
  });
  assert.strictEqual(behind.status, 200);
  assert.strictEqual(behind.json.LocalAddress, 'https://media.example');
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
  assert.strictEqual(me.json.Id, login.json.User.Id);
  assert.strictEqual(me.json.Policy.EnableLiveTvAccess, false, 'live TV stays on the Triboon app');

  const headerToken = await httpSend(srv.port, 'GET', '/Users/Me', { headers: { 'x-emby-token': token } });
  assert.strictEqual(headerToken.status, 200);

  const views = await httpSend(srv.port, 'GET', `/Users/${me.json.Id}/Views`, { headers: { authorization: authz } });
  assert.strictEqual(views.status, 200);
  assert.deepStrictEqual(views.json.Items.map((row) => row.Name), ['Movies', 'Shows']);
  const moviesFolder = views.json.Items.find((row) => row.Name === 'Movies');
  assert.match(moviesFolder.Id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.strictEqual(moviesFolder.UserData.Key, 'viewmovies');
  assert.strictEqual(moviesFolder.UserData.ItemId, moviesFolder.Id);
  assert.strictEqual(moviesFolder.UserData.Played, false);
  assert.ok(moviesFolder.ImageTags.Primary, 'Movies has a cover the home row can show');
  assert.ok(moviesFolder.ImageTags.Thumb, 'Movies has a wide cover too');
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
    { idx: 0, kind: 'show', title: 'Day Show', year: 2025 },
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
  assert.match(libraryCover.headers['content-type'], /jpeg/);
  assert.ok(withDisk.json.Items.some((row) => row.Name === 'Disk Shows'), 'a show folder shows up too');
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
  const showHeart = await httpSend(srv.port, 'POST', `/Users/${me.json.Id}/FavoriteItems/${showShelf.json.Items[0].Id}`, { headers: { authorization: authz } });
  assert.strictEqual(showHeart.json.IsFavorite, true);
  const showHearts = await httpSend(srv.port, 'GET', `/Users/${me.json.Id}/Items?Filters=IsFavorite&IncludeItemTypes=Series&Recursive=true`, { headers: { authorization: authz } });
  assert.deepStrictEqual(showHearts.json.Items.map((row) => row.Name), ['Day Show'], 'Home favorites includes the show');
  const episodes = await httpSend(srv.port, 'GET', `/Shows/${showShelf.json.Items[0].Id}/Episodes`, { headers: { authorization: authz } });
  const first = episodes.json.Items.find((row) => row.IndexNumber === 1);
  const second = episodes.json.Items.find((row) => row.IndexNumber === 2);
  assert.ok(first && second, 'the show has two episodes');
  const watchedEp = await httpSend(srv.port, 'POST', `/Users/${me.json.Id}/PlayedItems/${first.Id}`, { headers: { authorization: authz } });
  assert.strictEqual(watchedEp.json.Played, true);
  const nextUp = await httpSend(srv.port, 'GET', `/Shows/NextUp?UserId=${me.json.Id}`, { headers: { authorization: authz } });
  assert.strictEqual(nextUp.status, 200);
  assert.ok(nextUp.json.Items.some((row) => row.Id === second.Id), 'finishing episode 1 offers episode 2');

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
    headers: { authorization: authz, 'content-type': 'application/json' },
    body: '{}',
  });
  assert.strictEqual(playback.status, 200);
  assert.match(playback.json.MediaSources[0].TranscodingUrl, /\/api\/hls\//, 'Jellyfin plays short pieces so the computer does not hold the whole movie');
  assert.match(playback.json.MediaSources[0].TranscodingUrl, /\/master\.m3u8\?/, 'the TV app needs a playlist name or it will not play');
  assert.strictEqual(playback.json.MediaSources[0].Type, 'Default');
  assert.strictEqual(playback.json.MediaSources[0].HasSegments, false);
  assert.strictEqual(playback.json.MediaSources[0].SupportsProbing, true);
  assert.strictEqual(playback.json.MediaSources[0].TranscodingSubProtocol, 'hls');
  const sub = (playback.json.MediaSources[0].MediaStreams || []).find((row) => row.Type === 'Subtitle');
  assert.ok(sub && sub.DeliveryMethod === 'External', 'Jellyfin CC sees the subtitle file beside the movie');
  assert.strictEqual(sub.IsTextSubtitleStream, true);
  assert.strictEqual(sub.SupportsExternalStream, true);
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
  assert.strictEqual(resumed.UserData.PlaybackPositionTicks, 120 * 10000000);
  const again = await httpSend(srv.port, 'GET', `/Items/${localId}`, { headers: { authorization: authz } });
  assert.strictEqual(again.json.UserData.PlaybackPositionTicks, 120 * 10000000, 'the details page offers Resume');
  const triboonHome = await httpJson(srv.port, 'GET', '/api/watch', null, admin);
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

  const shut = await httpJson(srv.port, 'POST', '/api/settings', { jellyfinApps: false }, admin);
  assert.strictEqual(shut.status, 200);
  assert.strictEqual((await httpJson(srv.port, 'GET', '/api/settings', null, admin)).json.jellyfinApps, false);
  assert.strictEqual((await httpSend(srv.port, 'GET', '/System/Info/Public')).status, 404);

  for (const route of JELLYFIN_ROUTES) {
    assert.ok(['public', 'user'].includes(route.auth), `jellyfin route ${route.re} declares auth`);
    assert.ok(srv.ROUTES.some((r) => r.re === route.re && r.m === route.m), 'the route table lists the jellyfin door');
  }
});

test('jellyfin door closes with the server', async () => {
  if (srv) await srv.shutdown();
});
