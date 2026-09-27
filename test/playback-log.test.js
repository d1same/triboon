'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const story = require('../server/playback-log');

test('playback story keeps one play and hides tokens', () => {
  story._reset();
  story.bindMount('mount1', 'user-a', 'sess1', {
    title: 'The Rookie S08E04',
    file: 'The.Rookie.S08E04.mkv',
    text: 'play why=viewer file=The.Rookie.S08E04.mkv',
  });
  story.note('user-a', 'sess1', 'remount reason="server restart"', { at: '12:04' });
  story.noteMount('mount1', 'read out of range: seg 461 off 330843136 size=900 part=716800');
  story.note('user-a', 'sess1', 'stream url http://x/api/stream/m?t=SECRET&x=1');
  story.noteOpen('login refused — reason: easynews refused a new login');
  const text = story.latestText('user-a');
  assert.match(text, /The Rookie S08E04/);
  assert.match(text, /session sess1/);
  assert.match(text, /why=viewer/);
  assert.match(text, /at 12:04/);
  assert.match(text, /seg 461/);
  assert.match(text, /login refused/);
  assert.doesNotMatch(text, /SECRET/);
  assert.match(text, /t=\*\*\*/);
  story.noteOpen('login refused — reason: easynews refused a new login');
  const again = story.latestText('user-a');
  assert.strictEqual(again.split('login refused').length, 2, 'the same line is kept once');
});

test('a stopped play does not collect the next show\'s provider line', () => {
  story._reset();
  story.note('user-a', 'old', 'play why=viewer');
  story.markStopped('user-a', 'old');
  story.note('user-a', 'new', 'play why=viewer file=episode 4');
  story.noteOpen('account full — reason: easynews is full');
  assert.match(story.textFor('user-a', 'new'), /account full/);
  assert.doesNotMatch(story.textFor('user-a', 'old'), /account full/);
  const both = story.recentText('user-a');
  assert.match(both, /session old/);
  assert.match(both, /episode 4/);
});

test('the bad read names the piece, and the clock ignores a chopped second', () => {
  const vfs = fs.readFileSync(path.join(__dirname, '..', 'server', 'vfs.js'), 'utf8');
  assert.match(vfs, /read out of range: seg \$\{segIdx\} off \$\{offset\} size=\$\{this\.size\} part=\$\{this\.partSize\}/);
  const html = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8');
  assert.match(html, /function wholeSecondChopped\(prev, incoming\)/);
  assert.match(html, /ignored a whole-second report/);
  assert.match(html, /remountBody\.reason =/);
  assert.match(html, /id="copyPlaybackStory"/);
  assert.match(html, /data-tab="logs"[\s\S]+<span>Logs<\/span>/);
  assert.match(html, /why: 'next'/);
  assert.match(html, /skip \$\{delta >= 0 \? 'forward' : 'back'\}/);
  const index = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
  assert.match(index, /recentText\(ctx\.user\.id\)/);
  assert.match(index, /skip: 'skipped'/);
  assert.match(index, /subs: 'subtitle'/);
  const android = fs.readFileSync(path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'java', 'app', 'triboon', 'tv', 'MainActivity.java'), 'utf8');
  assert.match(android, /private String nativeSafePosPrecise\(\)/);
  assert.doesNotMatch(android, /__tvNativeVideo(?:Ended|Next|Error)\("\s*\+\s*nativePosSeconds\(\)/);
  assert.match(android, /nativeSubtitleLoadedKey/);
  assert.match(android, /__tvNativeSubtitleSelect\([\s\S]{0,240}nativePosSecondsPrecise\(\)/);
  assert.doesNotMatch(android, /__tvNativeSubtitleSelect\([\s\S]{0,240}\+\s*nativePosSeconds\(\)/);
});
