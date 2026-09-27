'use strict';
// One story per play, kept in memory so the owner can copy it from Settings.
// The Unraid scroll mixes every file in the house. This is just the movie
// that was on screen: play, remount, buffer, subtitles, Jellyfin.
// Never store tokens, passwords, or stream links.

const MAX_PLAYS = 8;
const MAX_EVENTS = 160;
const OPEN_MS = 3 * 60 * 60 * 1000;

const byUser = new Map();
const byMount = new Map();

function clock() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function clean(text) {
  return String(text == null ? '' : text)
    .replace(/([?&](?:t|token|access_token|api_key|apikey)=)[^&\s]+/gi, '$1***')
    .replace(/(Token=")[^"]+/gi, '$1***')
    .replace(/((?:pass|password|secret)\s*[:=]\s*)[^\s,]+/gi, '$1***')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 400);
}

function playsOf(uid) {
  let list = byUser.get(uid);
  if (!list) {
    list = [];
    byUser.set(uid, list);
  }
  return list;
}

function touchPlay(uid, sessionId, title) {
  const list = playsOf(uid);
  let play = list.find((p) => p.id === sessionId);
  if (!play) {
    play = {
      id: String(sessionId),
      title: '',
      file: '',
      started: Date.now(),
      touched: Date.now(),
      stopped: 0,
      events: [],
    };
    list.unshift(play);
    while (list.length > MAX_PLAYS) list.pop();
  }
  if (title) play.title = clean(title).slice(0, 120);
  play.touched = Date.now();
  return play;
}

function addEvent(play, text, movieAt) {
  const line = clean(text);
  if (!line) return;
  const last = play.events[play.events.length - 1];
  if (last && last.text === line) return;
  play.events.push({ t: clock(), at: clean(movieAt).slice(0, 16), text: line });
  if (play.events.length > MAX_EVENTS) play.events.splice(0, play.events.length - MAX_EVENTS);
  play.touched = Date.now();
}

function note(uid, sessionId, text, opts = {}) {
  if (!uid || !sessionId) return;
  const play = touchPlay(uid, sessionId, opts.title);
  if (opts.file) play.file = clean(opts.file).slice(0, 180);
  addEvent(play, text, opts.at);
}

function bindMount(mountId, uid, sessionId, opts = {}) {
  if (!mountId || !uid || !sessionId) return;
  byMount.set(String(mountId), { uid, sessionId });
  if (opts.text) note(uid, sessionId, opts.text, opts);
  else touchPlay(uid, sessionId, opts.title);
}

function noteMount(mountId, text, opts = {}) {
  const hit = byMount.get(String(mountId || ''));
  if (!hit) return;
  note(hit.uid, hit.sessionId, text, opts);
}

// A provider refusal has no session of its own. Attach it to the play
// that is on screen, not to every old episode still in memory.
function noteOpen(text) {
  const now = Date.now();
  for (const list of byUser.values()) {
    let best = null;
    for (const play of list) {
      if (play.stopped) continue;
      if (now - (play.touched || play.started) > OPEN_MS) continue;
      if (!best || (play.touched || 0) > (best.touched || 0)) best = play;
    }
    if (best) addEvent(best, text, '');
  }
}

function markStopped(uid, sessionId) {
  const play = (byUser.get(uid) || []).find((p) => p.id === sessionId);
  if (play) play.stopped = Date.now();
}

function formatPlay(play) {
  if (!play) return '';
  const head = [
    play.title || 'Playback',
    play.file ? `file ${play.file}` : '',
    `session ${play.id}`,
  ].filter(Boolean).join('\n');
  const lines = play.events.map((e) => `${e.t}${e.at ? `  at ${e.at}` : ''}  ${e.text}`);
  return `${head}\n${lines.join('\n')}${lines.length ? '\n' : ''}`;
}

function latestText(uid) {
  const play = (byUser.get(uid) || [])[0];
  if (!play || !play.events.length) return '';
  return formatPlay(play);
}

function recentText(uid) {
  const plays = (byUser.get(uid) || []).filter((p) => p.events && p.events.length);
  return plays.map(formatPlay).filter(Boolean).join('\n');
}

function textFor(uid, sessionId) {
  const play = (byUser.get(uid) || []).find((p) => p.id === sessionId);
  return formatPlay(play);
}

function _reset() {
  byUser.clear();
  byMount.clear();
}

module.exports = {
  note, bindMount, noteMount, noteOpen, markStopped, latestText, recentText, textFor, formatPlay, _reset,
};
