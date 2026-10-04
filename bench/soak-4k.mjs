#!/usr/bin/env node
// Long 4K playback soak on a real Android TV (or the emulator) running the Triboon app.
//
// Plays each title for --minutes, polls the native clock every 2s, does two 10-minute
// forward seeks, then reads the server's playback story for that session. A run fails
// when the stream drops, the player crashes, or the picture stalls longer than --max-stall.
// It also fails unless the set covered BOTH a remux and a direct-play 4K stream.
//
// It streams real usenet. Run it only when nobody is watching on a server that shares
// the same usenet logins, or both servers drop each other's lines.
//
//   node bench/soak-4k.mjs --device 10.1.20.43:5555 --minutes 20
//   node bench/soak-4k.mjs --device emulator-5554 --title movie:1226863 --title tv:71712:1:17
//
// Titles: movie:<tmdbId> or tv:<tmdbId>:<season>:<episode>. Defaults cover a 4K DD+ movie
// (remux on boxes without passthrough), a 4K AAC movie (direct), and a 4K DD+ episode.
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const titles = args.flatMap((a, i) => (a === '--title' && args[i + 1] ? [args[i + 1]] : []));
const device = opt('device', '');
const minutes = Number(opt('minutes', '20'));
const maxStall = Number(opt('max-stall', '10'));
const port = Number(opt('port', '9231'));
const adb = process.env.ADB || `${process.env.LOCALAPPDATA}\\Android\\Sdk\\platform-tools\\adb.exe`;
const set = titles.length ? titles : ['movie:1226863', 'movie:693134', 'tv:71712:1:17'];

if (!device) {
  console.error('usage: node bench/soak-4k.mjs --device <adb serial> [--minutes 20] [--title movie:ID | tv:ID:S:E]...');
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const adbOut = (...a) => execFileSync(adb, ['-s', device, ...a], { encoding: 'utf8' });

function forwardDevtools() {
  const unix = adbOut('shell', 'cat /proc/net/unix');
  const socks = unix.match(/webview_devtools_remote_\d+/g) || [];
  if (!socks.length) throw new Error('no Triboon WebView devtools socket (is the app open?)');
  execFileSync(adb, ['-s', device, 'forward', `tcp:${port}`, `localabstract:${socks[socks.length - 1]}`]);
}

async function evalPage(expression) {
  const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
  const target = list.find((t) => t.webSocketDebuggerUrl && t.url && t.url !== 'about:blank') || list[0];
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  const res = await new Promise((resolve) => {
    ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id === 1) resolve(m); };
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true, timeout: 180000 } }));
  });
  ws.close();
  const r = res.result || {};
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception ? r.exceptionDetails.exception.description : 'page error');
  return r.result ? r.result.value : undefined;
}

function startExpr(spec) {
  const [kind, id, s, e] = spec.split(':');
  return `(async () => {
    const w = (ms) => new Promise((r) => setTimeout(r, ms));
    if (S.playing) { closePlayer(); await w(2500); }
    if (S.view === 'detail') { closeDetail(); await w(600); }
    let target;
    if (${JSON.stringify(kind)} === 'tv') {
      const show = { key: 'tmdb:tv:${id}', tmdbId: ${Number(id)}, type: 'tv', title: 'tv ${id}' };
      target = epTarget(show, ${Number(s) || 1}, ${Number(e) || 1}, 0);
    } else {
      target = { key: 'tmdb:movie:${id}', tmdbId: ${Number(id)}, type: 'movie', title: 'movie ${id}' };
    }
    S.qualityPref = 4;
    saveQualityPref(target, 4);
    const t0 = Date.now();
    play(startOverItem(target));
    for (let i = 0; i < 360; i++) {
      const p = S.playing;
      if (p && p.usingNative && p.started && p.nativePos > 0) {
        return { ok: true, firstFrameMs: Date.now() - t0, kind: currentPlayerKind(p), name: p.name || '' };
      }
      await w(250);
    }
    return { ok: false, view: S.view, name: S.playing && S.playing.name };
  })()`;
}

const seekExpr = `(async () => {
  const w = (ms) => new Promise((r) => setTimeout(r, ms));
  const from = S.playing.nativePos || 0;
  const t0 = Date.now();
  seekTo(from + 600);
  let jumped = 0;
  for (let i = 0; i < 160; i++) {
    await w(250);
    const pos = S.playing && S.playing.nativePos || 0;
    if (!jumped && pos > from + 300) jumped = pos;
    if (jumped && pos > jumped + 1) return Date.now() - t0;
  }
  return -1;
})()`;

const storyExpr = (name) => `(async () => {
  const r = await api('/api/playback-story');
  const block = (r.text || '').split('\\n\\n').find((b) => b.includes(${JSON.stringify(name)}));
  return block || '';
})()`;

async function soak(spec) {
  const start = await evalPage(startExpr(spec));
  if (!start || !start.ok) return { spec, ok: false, why: 'did not start', start };
  const stalls = [];
  let last = await evalPage('S.playing && S.playing.nativePos || 0');
  let stallStart = 0;
  const seeks = [];
  const end = Date.now() + minutes * 60000;
  const seekAt = [Date.now() + minutes * 20000, Date.now() + minutes * 40000];
  while (Date.now() < end) {
    await sleep(2000);
    if (seekAt.length && Date.now() >= seekAt[0]) {
      seekAt.shift();
      seeks.push(await evalPage(seekExpr));
      last = await evalPage('S.playing && S.playing.nativePos || 0');
      continue;
    }
    const st = await evalPage('S.playing ? { pos: S.playing.nativePos || 0, paused: !!S.playing.paused } : null');
    if (!st) return { spec, ok: false, why: 'player closed', start, stalls, seeks };
    if (st.pos - last < 0.5 && !st.paused) {
      if (!stallStart) stallStart = Date.now();
    } else if (stallStart) {
      stalls.push(Math.round((Date.now() - stallStart) / 1000));
      stallStart = 0;
    }
    last = st.pos;
  }
  const story = await evalPage(storyExpr(start.name.replace(/\.[a-z0-9]{2,4}$/i, '')));
  await evalPage('(() => { if (S.playing) closePlayer(); return 1; })()');
  const drops = (story.match(/connection dropped|player crashed|could not start/g) || []).length;
  const worst = stalls.length ? Math.max(...stalls) : 0;
  const ok = drops === 0 && worst <= maxStall && seeks.every((ms) => ms > 0);
  return { spec, ok, kind: start.kind, name: start.name, firstFrameMs: start.firstFrameMs, seeks, stalls, drops,
    storyIssues: story.split('\n').filter((l) => /dropped|crashed|buffered|took \d/.test(l)).slice(0, 6) };
}

forwardDevtools();
const results = [];
for (const spec of set) {
  console.log(`\n▶ ${spec} for ${minutes} min`);
  const r = await soak(spec);
  results.push(r);
  console.log(JSON.stringify(r, null, 2));
}
const kinds = new Set(results.filter((r) => r.kind).map((r) => (r.kind === 'direct' ? 'direct' : 'remux')));
const covered = kinds.has('direct') && kinds.has('remux');
const allOk = results.every((r) => r.ok);
console.log(`\n4K soak: ${results.filter((r) => r.ok).length}/${results.length} passed; modes ${[...kinds].join('+') || 'none'}${covered ? '' : ' (missing direct or remux)'}`);
process.exit(allOk && covered ? 0 : 1);
