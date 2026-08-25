'use strict';
// Fifteen real-world movie/TV release names. Budget Android TV (Onn, emulator, 4GB
// boxes) must remux DTS/MKV instead of trying to decode a 4K original in RAM.

const { test } = require('node:test');
const assert = require('node:assert');
const { decidePlayback, detectFfmpeg, detectEncoder } = require('../server/transcode');
const HAS_FFMPEG = !!detectFfmpeg();
const HAS_ENCODER = !!detectEncoder();

const SHIELD = { mkv: true, ac3: true, eac3: true, dts: true };
const BUDGET = { mkv: true, ac3: true, eac3: false, dts: false, lowPower: true, hevc: false };
const ONN = { mkv: true, ac3: true, eac3: false, dts: false, lowPower: true, hevc: true };

const CATALOG = [
  { name: 'Dune.Part.Two.2024.2160p.WEB-DL.DDP5.1.Atmos.H.265-NTb.mkv', kind: 'movie', res: '4k' },
  { name: 'Oppenheimer.2023.2160p.BluRay.HEVC.TrueHD.7.1.Atmos-FGT.mkv', kind: 'movie', res: '4k' },
  { name: 'The.Batman.2022.2160p.UHD.BluRay.DTS-HD.MA.7.1.HEVC-IMBT.mkv', kind: 'movie', res: '4k' },
  { name: 'Mad.Max.Fury.Road.2015.2160p.BluRay.REMUX.HEVC.DTS-HD.MA.7.1-FraMeSToR.mkv', kind: 'movie', res: '4k' },
  { name: 'Everything.Everywhere.All.At.Once.2022.1080p.BluRay.DTS.x264-GROUP.mkv', kind: 'movie', res: '1080' },
  { name: 'The.Holdovers.2023.1080p.WEB-DL.DDP5.1.H.264-NTb.mkv', kind: 'movie', res: '1080' },
  { name: 'Past.Lives.2023.1080p.WEBRip.AAC2.0.x264-GROUP.mp4', kind: 'movie', res: '1080' },
  { name: 'Spider-Man.Across.the.Spider-Verse.2023.1080p.WEB-DL.DDP5.1.H.264-FLUX.mkv', kind: 'movie', res: '1080' },
  { name: 'The.Bear.S02E01.2160p.WEB-DL.DDP5.1.H.265-NTb.mkv', kind: 'tv', res: '4k' },
  { name: 'Shogun.S01E05.2160p.WEB-DL.Atmos.H.265-FLUX.mkv', kind: 'tv', res: '4k' },
  { name: 'Succession.S04E10.1080p.WEB-DL.DDP5.1.H.264-NTb.mkv', kind: 'tv', res: '1080' },
  { name: 'The.Last.of.Us.S01E03.1080p.WEB-DL.DDP5.1.H.264-NTb.mkv', kind: 'tv', res: '1080' },
  { name: 'Fallout.S01E01.2160p.WEB-DL.DDP5.1.H.265-NTb.mkv', kind: 'tv', res: '4k' },
  { name: 'Severance.S02E01.1080p.WEB-DL.DDP5.1.H.264-NTb.mkv', kind: 'tv', res: '1080' },
  { name: 'Slow.Horses.S04E02.1080p.WEBRip.x264-GROUP.mkv', kind: 'tv', res: '1080' },
];

test('playback catalog covers fifteen movie and TV releases at 4K and 1080p', () => {
  assert.strictEqual(CATALOG.length, 15);
  assert.strictEqual(CATALOG.filter((x) => x.kind === 'movie').length, 8);
  assert.strictEqual(CATALOG.filter((x) => x.kind === 'tv').length, 7);
  assert.ok(CATALOG.some((x) => x.res === '4k'));
  assert.ok(CATALOG.some((x) => x.res === '1080'));
});

test('budget Android TV remuxes MKV catalog titles instead of eating RAM on 4K originals', () => {
  for (const item of CATALOG) {
    const budget = decidePlayback(item.name, BUDGET);
    const onn = decidePlayback(item.name, ONN);
    const shield = decidePlayback(item.name, SHIELD);
    if (/\.mp4$/i.test(item.name)) {
      assert.strictEqual(budget.method, 'direct', `${item.name} mp4 stays direct on a cheap box`);
      assert.strictEqual(shield.method, 'direct', `${item.name} mp4 stays direct on Shield`);
      continue;
    }
    assert.notStrictEqual(budget.method, undefined, item.name);
    if (item.res === '4k' && HAS_ENCODER) {
      assert.strictEqual(budget.method, 'transcode', `${item.name} 4K without HEVC hardware must transcode`);
      assert.strictEqual(onn.method, 'remux', `${item.name} Onn with HEVC remuxes 4K`);
      continue;
    }
    assert.ok(budget.method === 'remux' || budget.method === 'direct' || budget.method === 'transcode', `${item.name} budget=${budget.method}`);
    if (/\.mkv$/i.test(item.name) && !BUDGET.eac3 && item.res !== '4k') {
      if (HAS_FFMPEG) {
        assert.strictEqual(budget.method, 'remux', `${item.name} must remux on a box without EAC3/DTS`);
      } else {
        assert.ok(budget.method === 'remux' || budget.warning, `${item.name} cannot pretend a cheap box can eat the original`);
      }
    }
    if (SHIELD.dts && /\.mkv$/i.test(item.name) && /DDP5\.1|DDP 5\.1|WEB-DL\.DDP/i.test(item.name) === false) {
      // Shield with full audio hardware can direct-play a clean MKV.
      assert.ok(shield.method === 'direct' || shield.method === 'remux', `${item.name} shield=${shield.method}`);
    }
  }
});
