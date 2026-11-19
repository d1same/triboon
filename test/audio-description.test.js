'use strict';
// Audio Description (a narrator describing the picture) is never picked by default (brief 121).
// Part 1: release scoring. Every title, group and file here is made up.

const { test } = require('node:test');
const assert = require('node:assert');
const { rankReleases, scoreRelease, isAudioDescriptionRelease } = require('../server/scoring');

const GB = 1e9;
const rel = (name, extra = {}) => ({ name, sizeBytes: 4 * GB, ...extra });

test('scoring: an Audio Description release loses to a normal release of the same quality', () => {
  const ad = rel('Prairie.Days.2026.with.Audio.Description.1080p.NF.WEB-DL.DDP5.1.H.264-Kettle');
  const plain = rel('Prairie.Days.2026.1080p.NF.WEB-DL.DDP5.1.H.264-SPWEB');
  const ranked = rankReleases([ad, plain], { maxResolutionRank: 4 });
  assert.strictEqual(ranked[0].name, plain.name);
  assert.ok(ranked.find((c) => c.name === ad.name).reasons.some((r) => /audio-description/.test(r)));
});

test('scoring: a normal release wins even against a higher-resolution or preferred Audio Description release', () => {
  const ad4k = rel('Winter.Paws.2026.Audio.Description.2160p.AMZN.WEB-DL.DDP5.1.H.265-Kettle', { sizeBytes: 12 * GB });
  const plain720 = rel('Winter.Paws.2026.720p.AMZN.WEB-DL.DDP5.1.H.264-NTb', { sizeBytes: 2 * GB });
  const ranked = rankReleases([ad4k, plain720], { maxResolutionRank: 4, preferResolutionRank: 4 });
  assert.strictEqual(ranked[0].name, plain720.name);
});

test('scoring: an Audio Description release still plays when it is the only one', () => {
  const ad = rel('Quiet.Harbor.2026.with.Audio.Description.1080p.NF.WEB-DL.DDP5.1.H.264-Kettle');
  const { score } = scoreRelease(ad, { maxResolutionRank: 4 });
  assert.ok(score > -5000, `still auto-playable (score ${score})`);
});

test('scoring: the usual Audio Description spellings are caught', () => {
  for (const name of [
    'Quiet.Harbor.2026.with.Audio.Description.1080p.WEB-DL.H.264-Kettle',
    'Quiet.Harbor.2026.Audio.Description.1080p.WEB-DL.H.264-Kettle',
    'Quiet.Harbor.2026.AudioDescription.1080p.WEB-DL.H.264-Kettle',
    'Quiet Harbor 2026 Audio Described 1080p WEB-DL H 264-Kettle',
    'Quiet_Harbor_2026_Audio_Description_1080p_WEB-DL-Kettle',
    'Quiet.Harbor.2026.1080p.WEB-DL.with.AD.DDP5.1.H.264-Kettle',
    'Quiet.Harbor.2026.Descriptive.Audio.1080p.WEB-DL.H.264-Kettle',
    'Quiet.Harbor.2026.Described.Video.1080p.WEB-DL.H.264-Kettle',
    'Quiet.Harbor.2026.1080p.WEB-DL.DVS.DDP5.1.H.264-Kettle',
    'quiet.harbor.2026.1080p.web-dl.with.audio.description.h264-kettle',
  ]) assert.strictEqual(isAudioDescriptionRelease(name), true, name);
});

test('scoring: no false positives on titles, groups or words that only contain AD', () => {
  for (const name of [
    'Ad.Astra.2019.1080p.BluRay.x264-SPARKS',
    'A.D.Kingdom.and.Empire.S01E01.1080p.WEB-DL.H.264-NTb',
    'The.Bad.Guys.2022.1080p.WEB-DL.DDP5.1.H.264-FLUX',
    'Headless.2026.1080p.WEB-DL.DDP5.1.H.264-FLUX',
    'Sudden.Departure.2026.1080p.WEB-DL.ADD.H.264-NTb',
    'Ready.Player.2026.1080p.WEB-DL.DDP5.1.H.264-ADWeb',
    'Quiet.Harbor.2026.1080p.WEB-DL.H.264-AD',
    'Quiet.Harbor.2026.1080p.WEB-DL.H.264-DVS',
    'Quiet.Harbor.2026.1080p.WEB-DL.DV.HDR.H.265-FLUX',
    'The.Description.2026.1080p.WEB-DL.H.264-FLUX',
    'Audio.2026.1080p.WEB-DL.H.264-FLUX',
    'Made.With.Love.2026.1080p.WEB-DL.H.264-FLUX',
  ]) assert.strictEqual(isAudioDescriptionRelease(name), false, name);
});
