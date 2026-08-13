'use strict';

// Keep this regex in sync with bench/android-tv-stress.ps1 and bench/android-tv-smoke.ps1.
const RADIO_RE = /\[radio\]|\bradio\b|offline/i;

function channelBlob(ch) {
  if (!ch || typeof ch !== 'object') return '';
  return [ch.name, ch.title, ch.group, ch.genre].map((v) => String(v || '')).join(' ');
}

function isRadioLike(ch) {
  return RADIO_RE.test(channelBlob(ch));
}

function pickLiveVideoChannels(channels, n = 2) {
  const list = Array.isArray(channels) ? channels : [];
  const video = list.filter((c) => !isRadioLike(c));
  const pool = video.length ? video : list;
  const count = Math.max(0, Number(n) || 0);
  return pool.slice(0, count);
}

module.exports = { RADIO_RE, channelBlob, isRadioLike, pickLiveVideoChannels };
