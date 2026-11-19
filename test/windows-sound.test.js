'use strict';

// Windows app no-sound (3.5.3). A browser engine (Edge/WebView2) plays AC3/E-AC3 video as a moving
// picture with zero audio decoded and no error, so nothing fell back. Names below are made up.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { decidePlayback, detectFfmpeg } = require('../server/transcode');

const html = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8');
function extractFunction(name) {
  let start = html.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} exists in web/index.html`);
  if (html.slice(start - 6, start) === 'async ') start -= 6;
  let depth = 0;
  for (let i = html.indexOf(') {', start) + 2; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}' && --depth === 0) return html.slice(start, i + 1);
  }
  throw new Error(`${name} has no end`);
}

const WEB = { mkv: true, mp4: true, h264: true, hevc: true, aac: true, ac3: false, eac3: false, dts: false };
const remuxOr = () => (detectFfmpeg() ? 'remux' : 'direct');

test('F1: an MP4/M4V/WebM named with AC3-family, DTS or TrueHD audio is not sent direct to a browser', () => {
  for (const name of [
    'Some.Show.S01E02.1080p.WEB-DL.DDP5.1.H.265-GRP.mp4',
    'Some.Show.S01E02.1080p.WEB-DL.DD+5.1.H.264-GRP.mp4',
    'Some.Film.2020.1080p.BluRay.AC3.x264.m4v',
    'Some.Film.2020.2160p.WEB-DL.EAC3.Atmos.H.265.mp4',
    'Some.Film.2020.1080p.BluRay.DD5.1.x264.mp4',
    'Some.Film.2020.1080p.BluRay.DTS.x264.mp4',
    'Some.Film.2020.2160p.BluRay.TrueHD.Atmos.mp4',
    'Some.Film.2020.1080p.WEB.E-AC-3.webm',
  ]) {
    assert.equal(decidePlayback(name, WEB).method, remuxOr(), name);
  }
});

test('F1: AAC (or unnamed audio) MP4s stay direct in a browser, and Dolby-capable clients keep direct', () => {
  assert.equal(decidePlayback('Some.Film.2020.1080p.WEB-DL.AAC2.0.H.264.mp4', WEB).method, 'direct');
  assert.equal(decidePlayback('Movie.mp4', WEB).method, 'direct');
  assert.equal(decidePlayback('Movie.webm', WEB).method, 'direct');
  assert.equal(decidePlayback('Some.Show.S01E02.1080p.WEB-DL.DDP5.1.H.265-GRP.mp4',
    { ...WEB, ac3: true, eac3: true }).method, 'direct', 'a client that decodes E-AC3 plays it direct');
  assert.equal(decidePlayback('Some.Film.2020.1080p.BluRay.DTS.x264.mp4',
    { ...WEB, dts: true }).method, 'direct', 'a client that decodes DTS plays it direct');
  assert.equal(decidePlayback('Some.Film.2020.2160p.BluRay.TrueHD.Atmos.mp4',
    { ...WEB, native: true, passthrough: true, truehd: true, ac3: true, eac3: true }).method, 'direct');
});
