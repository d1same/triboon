'use strict';
// Adversarial title-collision battery: franchises, spin-offs, remakes, short names.
// Each case is a catalog query (what Play sends) plus scene names that MUST / MUST NOT match.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { parseWantedTitle, releaseMatches, catalogIdentityMatches, shortTitleQuery } = require('../server/pipeline');

const CASES = [
  {
    id: 'office-us',
    q: 'the office s01e01',
    good: [
      'The.Office.S01E01.1080p.WEB-DL-NTb',
      'The.Office.US.S01E01.1080p.WEB-DL-NTb',
    ],
    bad: [
      'The.Office.AU.S01E01.1080p.WEB-DL-NTb',
      'The.Office.UK.S01E01.1080p.WEB-DL-NTb',
      'The.Office.NZ.S01E01.1080p.WEB-DL-NTb',
    ],
  },
  {
    id: 'office-uk',
    q: 'the office uk s01e01',
    good: ['The.Office.UK.S01E01.1080p.WEB-DL-NTb'],
    bad: ['The.Office.AU.S01E01.1080p.WEB-DL-NTb', 'The.Office.US.S01E01.1080p.WEB-DL-NTb'],
  },
  {
    id: 'office-us-2005',
    q: 'the office 2005 s01e01',
    good: [
      'The.Office.S01E01.1080p.WEB-DL-NTb',
      'The.Office.US.S01E01.1080p.WEB-DL-NTb',
      'The.Office.2005.S01E01.1080p.WEB-DL-NTb',
    ],
    bad: [
      'The.Office.2024.S01E01.2160p.AMZN.WEB-DL.H265.HDR10-HONE',
      'The Office (2024) S01E01 (1080p AMZN WEB-DL H265 SDR DDP 5.1 English - HONE)',
      'The.Office.AU.S01E01.1080p.WEB-DL-NTb',
    ],
  },
  {
    id: 'mutiny-2026',
    q: 'mutiny 2026',
    good: [
      'Mutiny.2026.2160p.WEB-DL.H.265-FLUX',
      'The.Mutiny.2026.1080p.WEB-DL-NTb',
    ],
    bad: [
      'Mutiny.on.the.Bounty.1962.1080p.BluRay-x',
      'Mutiny.2019.1080p.WEB-DL-x',
      'The.Mutiny.S01E01.1080p.WEB-DL-x',
    ],
  },
  {
    id: 'from',
    q: 'from s01e01',
    good: ['FROM.S01E01.Long.Days.Journey.Into.Night.1080p.AMZN.WEB-DL.DDP5.1.H.264-FLUX'],
    bad: [
      'Stranger.Things.Tales.From.85.S01E01.2160p.WEBRip-x',
      'From.Dusk.Till.Dawn.S01E01.1080p.WEB-DL-NTb',
    ],
  },
  {
    id: 'it-2017',
    q: 'it 2017',
    good: ['It.2017.1080p.BluRay.REMUX.AVC.DTS-HD.MA-FGT'],
    bad: ['It.Chapter.Two.2019.2160p.UHD.BluRay.x265-TERMiNAL', 'Power.Rangers.2017.2160p.UHD.BDRip-x'],
  },
  {
    id: 'lioness',
    q: 'special ops: lioness s02e01',
    good: [
      'Lioness.S02E01.Beware.the.Old.Soldier.2160p.AMZN.WEB-DL.DDP5.1.H.265-FLUX',
      'Special.Ops.Lioness.S02E01.1080p.WEB-DL-NTb',
    ],
    bad: [
      'The.Lion.King.S02E01.1080p.WEB-DL-GRP',
      'American.Lioness.S02E01.1080p.WEB-DL-GRP',
      'FROM.S02E01.1080p.AMZN.WEB-DL-FLUX',
    ],
  },
  {
    id: 'lotr-fellowship',
    q: 'the lord of the rings: the fellowship of the ring 2001',
    good: [
      'The.Lord.of.the.Rings.The.Fellowship.of.the.Ring.2001.EXTENDED.1080p.BluRay-x',
      'Fellowship.of.the.Ring.2001.EXTENDED.1080p.BluRay-x',
    ],
    bad: [
      'The.Lord.of.the.Rings.The.Two.Towers.2002.EXTENDED.1080p.BluRay-x',
      'The.Lord.of.the.Rings.The.Return.of.the.King.2003.EXTENDED.1080p.BluRay-x',
      'The.Hobbit.An.Unexpected.Journey.2012.2160p.UHD-x',
      'The.Lord.of.the.Rings.The.Rings.of.Power.S01E01.1080p.WEB-DL-x',
      'Two.Towers.2002.EXTENDED.1080p.BluRay-x',
    ],
  },
  {
    id: 'house-md',
    q: 'house s01e01',
    good: ['House.S01E01.1080p.WEB-DL.H.264-NTb'],
    bad: [
      'House.of.Cards.S01E01.1080p.WEB-DL-NTb',
      'House.of.the.Dragon.S01E01.1080p.WEB-DL-NTb',
      'Full.House.S01E01.1080p.WEB-DL-x',
    ],
  },
  {
    id: 'house-of-the-dragon',
    q: 'house of the dragon s01e01',
    good: ['House.of.the.Dragon.S01E01.1080p.HMAX.WEB-DL-NTb'],
    bad: ['House.S01E01.1080p.WEB-DL-NTb', 'House.of.Cards.S01E01.1080p.WEB-DL-NTb', 'Dragon.S01E01.1080p.WEB-DL-NTb', 'Game.of.Thrones.S01E01.1080p.WEB-DL-NTb'],
  },
  {
    id: 'walking-dead',
    q: 'the walking dead s01e01',
    good: ['The.Walking.Dead.S01E01.Days.Gone.Bye.2010.BluRay.1080p-x'],
    bad: [
      'The.Walking.Dead.Daryl.Dixon.S01E01.1080p.AMZN.WEB-DL-x',
      'The.Walking.Dead.Dead.City.S01E01.2023.1080p.NF.WEB-DL-x',
      'Fear.the.Walking.Dead.S01E01.1080p.WEB-DL-x',
      'Tales.of.the.Walking.Dead.S01E01.1080p.AMZN.WEB-DL-x',
    ],
  },
  {
    id: 'law-and-order',
    q: 'law & order s01e01',
    good: ['Law.and.Order.S01E01.1080p.AMZN.WEB-DL-NTb', 'Law.Order.S01E01.720p.HDTV.x264-GRP'],
    bad: [
      'Law.and.Order.Special.Victims.Unit.S01E01.1080p.WEB-DL-GRP',
      'Law.and.Order.Criminal.Intent.S01E01.1080p.WEB-DL-GRP',
      'Law.and.Order.Organized.Crime.S01E01.1080p.WEB-DL-GRP',
    ],
  },
  {
    id: 'csi-miami',
    q: 'csi: miami s01e01',
    good: ['CSI.Miami.S01E01.1080p.WEB-DL-NTb'],
    bad: ['CSI.S01E01.1080p.WEB-DL-NTb', 'CSI.NY.S01E01.1080p.WEB-DL-NTb', 'CSI.Vegas.S01E01.1080p.WEB-DL-NTb'],
  },
  {
    id: 'spider-man-nwh',
    q: 'spider-man: no way home 2021',
    good: ['Spider.Man.No.Way.Home.2021.2160p.WEB-DL-GRP', 'No.Way.Home.2021.2160p.WEB-DL-GRP'],
    bad: [
      'Spider.Man.Homecoming.2017.2160p.WEB-DL-GRP',
      'Spider.Man.Far.From.Home.2019.2160p.WEB-DL-GRP',
      'Spider.Man.Across.the.Spider.Verse.2023.2160p.WEB-DL-GRP',
    ],
  },
  {
    id: 'mission-impossible-fallout',
    q: 'mission: impossible - fallout 2018',
    good: ['Mission.Impossible.Fallout.2018.2160p.UHD.BluRay-x'],
    bad: [
      'Mission.Impossible.1996.1080p.BluRay-x',
      'Mission.Impossible.Ghost.Protocol.2011.1080p.BluRay-x',
      'Mission.Impossible.Dead.Reckoning.2023.2160p.WEB-DL-x',
      'Impossible.2018.1080p.BluRay-x',
    ],
  },
  {
    id: 'dune-part-two',
    q: 'dune: part two 2024',
    good: ['Dune.Part.Two.2024.2160p.WEB-DL-NTb'],
    bad: ['Dune.2021.2160p.WEB-DL-NTb', 'Dune.Prophecy.S01E01.1080p.HBO.WEB-DL-NTb', 'Part.Two.2024.1080p.WEB-DL-x'],
  },
  {
    id: 'avatar-way-of-water',
    q: 'avatar: the way of water 2022',
    good: ['Avatar.The.Way.of.Water.2022.2160p.WEB-DL-NTb', 'The.Way.of.Water.2022.2160p.WEB-DL-NTb'],
    bad: ['Avatar.2009.2160p.UHD.BluRay-x', 'Avatar.The.Last.Airbender.S01E01.1080p.NF.WEB-DL-x', 'The.Last.Airbender.2010.1080p.BluRay-x'],
  },
  {
    id: 'john-wick-4',
    q: 'john wick: chapter 4 2023',
    good: ['John.Wick.Chapter.4.2023.2160p.WEB-DL-NTb'],
    bad: ['John.Wick.2014.1080p.BluRay-x', 'John.Wick.Chapter.3.Parabellum.2019.2160p.WEB-DL-x', 'Chapter.4.2023.2160p.WEB-DL-x'],
  },
  {
    id: 'top-gun-maverick',
    q: 'top gun: maverick 2022',
    good: ['Top.Gun.Maverick.2022.2160p.WEB-DL-NTb'],
    bad: ['Top.Gun.1986.1080p.BluRay-x'],
  },
  {
    id: 'gladiator-ii',
    q: 'gladiator ii 2024',
    good: ['Gladiator.II.2024.2160p.WEB-DL-NTb'],
    bad: ['Gladiator.2000.2160p.UHD.BluRay-x'],
  },
  {
    id: 'matrix-resurrections',
    q: 'the matrix resurrections 2021',
    good: ['The.Matrix.Resurrections.2021.2160p.WEB-DL-NTb'],
    bad: ['The.Matrix.1999.2160p.UHD.BluRay-x', 'The.Matrix.Reloaded.2003.1080p.BluRay-x', 'The.Matrix.Revolutions.2003.1080p.BluRay-x'],
  },
  {
    id: 'alien-romulus',
    q: 'alien: romulus 2024',
    good: ['Alien.Romulus.2024.2160p.WEB-DL-NTb'],
    bad: ['Alien.1979.2160p.UHD.BluRay-x', 'Aliens.1986.2160p.UHD.BluRay-x', 'Alien.Covenant.2017.2160p.WEB-DL-x', 'Romulus.2024.1080p.WEB-DL-x'],
  },
  {
    id: 'daredevil-born-again',
    q: "daredevil: born again s01e01",
    good: ['Daredevil.Born.Again.S01E01.1080p.DSNP.WEB-DL-NTb', 'Born.Again.S01E01.1080p.WEB-DL-x'],
    bad: ['Daredevil.S01E01.1080p.NF.WEB-DL-NTb', 'The.Punisher.S01E01.1080p.NF.WEB-DL-x'],
  },
  {
    id: 'reacher-vs-ryan',
    q: "tom clancy's jack ryan s01e01",
    good: ['Jack.Ryan.S01E01.1080p.AMZN.WEB-DL-NTb', 'Tom.Clancys.Jack.Ryan.S01E01.1080p.AMZN.WEB-DL-NTb'],
    bad: ['Reacher.S01E01.1080p.AMZN.WEB-DL-NTb', 'Jack.Reacher.2012.1080p.BluRay-x', 'Jack.Reacher.Never.Go.Back.2016.1080p.BluRay-x'],
  },
  {
    id: 'breaking-bad-family',
    q: 'breaking bad s01e01',
    good: ['Breaking.Bad.S01E01.1080p.AMZN.WEB-DL-NTb'],
    bad: ['Better.Call.Saul.S01E01.1080p.AMZN.WEB-DL-NTb', 'El.Camino.A.Breaking.Bad.Movie.2019.2160p.NF.WEB-DL-x'],
  },
  {
    id: 'el-camino',
    q: 'el camino: a breaking bad movie 2019',
    good: ['El.Camino.A.Breaking.Bad.Movie.2019.2160p.NF.WEB-DL-x'],
    bad: ['Breaking.Bad.S01E01.1080p.AMZN.WEB-DL-NTb', 'Better.Call.Saul.S01E01.1080p.AMZN.WEB-DL-NTb'],
  },
  {
    id: 'casino-royale-years',
    q: 'casino royale 2006',
    good: ['Casino.Royale.2006.2160p.UHD.BluRay-x'],
    bad: ['Casino.Royale.1967.1080p.BluRay-x'],
  },
  {
    id: 'shogun-2024',
    q: 'shogun 2024 s01e01',
    good: ['Shogun.2024.S01E01.2160p.FX.WEB-DL-NTb'],
    bad: ['Shogun.1980.S01E01.1080p.WEB-DL-x', 'Shogun.2024.S01E02.2160p.FX.WEB-DL-NTb'],
  },
  {
    id: 'fargo-movie',
    q: 'fargo 1996',
    good: ['Fargo.1996.1080p.BluRay-x'],
    bad: ['Fargo.S01E01.1080p.FX.WEB-DL-NTb'],
  },
  {
    id: 'the-batman-2022',
    q: 'the batman 2022',
    good: ['The.Batman.2022.2160p.WEB-DL-NTb'],
    bad: ['Batman.Begins.2005.2160p.UHD.BluRay-x', 'The.Dark.Knight.2008.2160p.UHD.BluRay-x', 'The.Batman.S01E01.1080p.WEB-DL-x'],
  },
  {
    id: 'star-wars-empire',
    q: 'star wars: episode v - the empire strikes back 1980',
    good: [
      'Star.Wars.Episode.V.The.Empire.Strikes.Back.1980.2160p.UHD-x',
      'The.Empire.Strikes.Back.1980.2160p.UHD-x',
    ],
    bad: [
      'Star.Wars.Episode.IV.A.New.Hope.1977.2160p.UHD-x',
      'Star.Wars.Episode.VI.Return.of.the.Jedi.1983.2160p.UHD-x',
      'The.Mandalorian.S01E01.1080p.DSNP.WEB-DL-x',
    ],
  },
  {
    id: 'greys-anatomy',
    q: "grey's anatomy s01e01",
    good: ['Greys.Anatomy.S01E01.1080p.WEB-DL-NTb'],
    bad: ['Anatomy.S01E01.1080p.WEB-DL-NTb', 'Greys.Anatomy.Station.19.S01E01.1080p.WEB-DL-x'],
  },
  {
    id: 'queens-gambit',
    q: "the queen's gambit s01e01",
    good: ['The.Queens.Gambit.S01E01.1080p.NF.WEB-DL-NTb'],
    bad: ['Gambit.S01E01.1080p.WEB-DL-NTb', 'X.Men.Gambit.2016.1080p.BluRay-x'],
  },
  {
    id: 'marvels-daredevil',
    q: "marvel's daredevil s01e01",
    good: ['Daredevil.S01E01.1080p.NF.WEB-DL-NTb', 'Marvels.Daredevil.S01E01.1080p.NF.WEB-DL-NTb'],
    bad: ['Daredevil.Born.Again.S01E01.1080p.DSNP.WEB-DL-NTb', 'The.Punisher.S01E01.1080p.NF.WEB-DL-x'],
  },
  {
    id: 'its-always-sunny',
    q: "it's always sunny in philadelphia s01e01",
    good: ['Its.Always.Sunny.in.Philadelphia.S01E01.1080p.WEB-DL-NTb'],
    bad: ['It.S01E01.1080p.WEB-DL-NTb', 'Always.Sunny.S01E01.1080p.WEB-DL-x'],
  },
  {
    id: 'year-show-1923',
    q: '1923 s01e01',
    good: ['1923.S01E01.1080p.Paramount.WEB-DL-NTb'],
    bad: [
      'Yellowstone.S01E01.1080p.WEB-DL-NTb',
      '1883.S01E01.1080p.WEB-DL-NTb',
      'The.Boys.S01E01.1080p.AMZN.WEB-DL-NTb',
    ],
  },
  {
    id: 'year-show-1883',
    q: '1883 s01e01',
    good: ['1883.S01E01.1080p.Paramount.WEB-DL-NTb'],
    bad: ['Yellowstone.S01E01.1080p.WEB-DL-NTb', '1923.S01E01.1080p.Paramount.WEB-DL-NTb'],
  },
  {
    id: 'yellowstone',
    q: 'yellowstone s01e01',
    good: ['Yellowstone.S01E01.1080p.WEB-DL-NTb'],
    bad: ['1883.S01E01.1080p.Paramount.WEB-DL-NTb', '1923.S01E01.1080p.Paramount.WEB-DL-NTb'],
  },
  {
    id: 'lost',
    q: 'lost s01e01',
    good: ['Lost.S01E01.1080p.WEB-DL-NTb'],
    bad: ['Lost.in.Space.S01E01.1080p.NF.WEB-DL-NTb', 'Lost.Girl.S01E01.1080p.WEB-DL-x'],
  },
  {
    id: 'dark',
    q: 'dark s01e01',
    good: ['Dark.S01E01.1080p.NF.WEB-DL-NTb'],
    bad: ['Dark.Matter.S01E01.1080p.WEB-DL-NTb', 'His.Dark.Materials.S01E01.1080p.WEB-DL-NTb'],
  },
  {
    id: 'ted-lasso',
    q: 'ted lasso s01e01',
    good: ['Ted.Lasso.S01E01.1080p.ATVP.WEB-DL-NTb'],
    bad: ['Ted.2012.1080p.BluRay-x', 'Ted.2.2015.1080p.BluRay-x'],
  },
  {
    id: 'ted-movie',
    q: 'ted 2012',
    good: ['Ted.2012.1080p.BluRay-x'],
    bad: ['Ted.Lasso.S01E01.1080p.ATVP.WEB-DL-NTb', 'Ted.2.2015.1080p.BluRay-x'],
  },
  {
    id: 'doctor-who',
    q: 'doctor who s01e01',
    good: ['Doctor.Who.S01E01.1080p.WEB-DL-NTb'],
    bad: ['Doctor.Strange.2016.2160p.WEB-DL-NTb', 'Doctor.Who.The.Movie.1996.1080p.BluRay-x'],
  },
  {
    id: 'night-agent',
    q: 'the night agent s01e01',
    good: ['The.Night.Agent.S01E01.1080p.NF.WEB-DL-NTb'],
    bad: ['The.Night.Manager.S01E01.1080p.WEB-DL-NTb', 'Night.Agent.Confidential.S01E01.1080p.WEB-DL-x'],
  },
  {
    id: 'ncis',
    q: 'ncis s01e01',
    good: ['NCIS.S01E01.1080p.WEB-DL-NTb'],
    bad: [
      'NCIS.Los.Angeles.S01E01.1080p.WEB-DL-NTb',
      'NCIS.Hawaii.S01E01.1080p.WEB-DL-NTb',
      'NCIS.Origins.S01E01.1080p.WEB-DL-NTb',
    ],
  },
  {
    id: 'ncis-los-angeles',
    q: 'ncis: los angeles s01e01',
    good: ['NCIS.Los.Angeles.S01E01.1080p.WEB-DL-NTb'],
    bad: ['NCIS.S01E01.1080p.WEB-DL-NTb', 'NCIS.Hawaii.S01E01.1080p.WEB-DL-NTb', 'NCIS.Origins.S01E01.1080p.WEB-DL-NTb'],
  },
  {
    id: 'fbi-most-wanted',
    q: 'fbi: most wanted s01e01',
    good: ['FBI.Most.Wanted.S01E01.1080p.WEB-DL-NTb'],
    bad: ['FBI.S01E01.1080p.WEB-DL-NTb', 'FBI.International.S01E01.1080p.WEB-DL-NTb'],
  },
  {
    id: 'nine-one-one',
    q: '9-1-1 s01e01',
    good: ['9-1-1.S01E01.1080p.WEB-DL-NTb'],
    bad: ['9-1-1.Lone.Star.S01E01.1080p.WEB-DL-NTb', '9-1-1.Nashville.S01E01.1080p.WEB-DL-x'],
  },
  {
    id: 'nine-one-one-lone-star',
    q: '9-1-1: lone star s01e01',
    good: ['9-1-1.Lone.Star.S01E01.1080p.WEB-DL-NTb'],
    bad: ['9-1-1.S01E01.1080p.WEB-DL-NTb', '9-1-1.Nashville.S01E01.1080p.WEB-DL-x'],
  },
  {
    id: 'chicago-fire',
    q: 'chicago fire s01e01',
    good: ['Chicago.Fire.S01E01.1080p.WEB-DL-NTb'],
    bad: ['Chicago.PD.S01E01.1080p.WEB-DL-NTb', 'Chicago.Med.S01E01.1080p.WEB-DL-NTb'],
  },
  {
    id: 'the-boys',
    q: 'the boys s01e01',
    good: ['The.Boys.S01E01.1080p.AMZN.WEB-DL-NTb'],
    bad: [
      'Gen.V.S01E01.1080p.AMZN.WEB-DL-NTb',
      'The.Boys.Presents.Diabolical.S01E01.1080p.AMZN.WEB-DL-x',
    ],
  },
  {
    id: 'mandalorian',
    q: 'the mandalorian s01e01',
    good: ['The.Mandalorian.S01E01.1080p.DSNP.WEB-DL-NTb'],
    bad: [
      'The.Book.of.Boba.Fett.S01E01.1080p.DSNP.WEB-DL-NTb',
      'Ahsoka.S01E01.1080p.DSNP.WEB-DL-NTb',
      'Andor.S01E01.1080p.DSNP.WEB-DL-NTb',
    ],
  },
  {
    id: 'ahsoka',
    q: 'star wars: ahsoka s01e01',
    good: ['Ahsoka.S01E01.1080p.DSNP.WEB-DL-NTb', 'Star.Wars.Ahsoka.S01E01.1080p.DSNP.WEB-DL-NTb'],
    bad: [
      'The.Mandalorian.S01E01.1080p.DSNP.WEB-DL-NTb',
      'Star.Wars.Rebels.S01E01.1080p.WEB-DL-x',
      'Star.Wars.The.Clone.Wars.S01E01.1080p.WEB-DL-x',
    ],
  },
  {
    id: 'andor',
    q: 'andor s01e01',
    good: ['Andor.S01E01.1080p.DSNP.WEB-DL-NTb'],
    bad: ['Rogue.One.A.Star.Wars.Story.2016.2160p.WEB-DL-NTb', 'The.Mandalorian.S01E01.1080p.DSNP.WEB-DL-NTb'],
  },
  {
    id: 'rings-of-power',
    q: 'the lord of the rings: the rings of power s01e01',
    good: [
      'The.Lord.of.the.Rings.The.Rings.of.Power.S01E01.1080p.WEB-DL-NTb',
      'The.Rings.of.Power.S01E01.1080p.WEB-DL-NTb',
    ],
    bad: [
      'The.Lord.of.the.Rings.The.Fellowship.of.the.Ring.2001.EXTENDED.1080p.BluRay-x',
      'The.Hobbit.An.Unexpected.Journey.2012.2160p.UHD-x',
    ],
  },
  {
    id: 'hp-sorcerers-stone',
    q: "harry potter and the sorcerer's stone 2001",
    good: [
      'Harry.Potter.and.the.Sorcerers.Stone.2001.2160p.UHD-x',
      'Harry.Potter.and.the.Philosophers.Stone.2001.1080p.BluRay-x',
    ],
    bad: [
      'Harry.Potter.and.the.Chamber.of.Secrets.2002.2160p.UHD-x',
      'Fantastic.Beasts.and.Where.to.Find.Them.2016.2160p.WEB-DL-x',
    ],
  },
  {
    id: 'twilight',
    q: 'twilight 2008',
    good: ['Twilight.2008.1080p.BluRay-x'],
    bad: [
      'The.Twilight.Saga.New.Moon.2009.1080p.BluRay-x',
      'The.Twilight.Saga.Breaking.Dawn.Part.1.2011.1080p.BluRay-x',
      'The.Twilight.Zone.S01E01.1080p.WEB-DL-NTb',
    ],
  },
  {
    id: 'twilight-zone',
    q: 'the twilight zone s01e01',
    good: ['The.Twilight.Zone.S01E01.1080p.WEB-DL-NTb'],
    bad: ['Twilight.2008.1080p.BluRay-x', 'The.Twilight.Saga.New.Moon.2009.1080p.BluRay-x'],
  },
  {
    id: 'prey',
    q: 'prey 2022',
    good: ['Prey.2022.2160p.HULU.WEB-DL-NTb'],
    bad: ['Predator.1987.2160p.UHD.BluRay-x', 'Predators.2010.1080p.BluRay-x', 'Prey.S01E01.1080p.WEB-DL-x'],
  },
  {
    id: 'terminator-2',
    q: 'terminator 2: judgment day 1991',
    good: ['Terminator.2.Judgment.Day.1991.2160p.UHD-x'],
    bad: [
      'The.Terminator.1984.2160p.UHD.BluRay-x',
      'Terminator.3.Rise.of.the.Machines.2003.1080p.BluRay-x',
      'Terminator.Dark.Fate.2019.2160p.WEB-DL-x',
    ],
  },
  {
    id: 'ghostbusters-1984',
    q: 'ghostbusters 1984',
    good: ['Ghostbusters.1984.2160p.UHD.BluRay-x'],
    bad: [
      'Ghostbusters.2016.2160p.WEB-DL-NTb',
      'Ghostbusters.Afterlife.2021.2160p.WEB-DL-NTb',
      'Ghostbusters.Frozen.Empire.2024.2160p.WEB-DL-x',
    ],
  },
  {
    id: 'dune-1984',
    q: 'dune 1984',
    good: ['Dune.1984.2160p.UHD.BluRay-x'],
    bad: ['Dune.2021.2160p.WEB-DL-NTb', 'Dune.Part.Two.2024.2160p.WEB-DL-NTb'],
  },
  {
    id: 'dune-2021',
    q: 'dune 2021',
    good: ['Dune.2021.2160p.WEB-DL-NTb'],
    bad: ['Dune.1984.2160p.UHD.BluRay-x', 'Dune.Part.Two.2024.2160p.WEB-DL-NTb'],
  },
  {
    id: 'battlestar-2004',
    q: 'battlestar galactica 2004 s01e01',
    good: ['Battlestar.Galactica.2004.S01E01.1080p.WEB-DL-NTb'],
    bad: ['Battlestar.Galactica.1978.S01E01.1080p.WEB-DL-x', 'Battlestar.Galactica.2004.S01E02.1080p.WEB-DL-NTb'],
  },
  {
    id: 'wicked',
    q: 'wicked 2024',
    good: ['Wicked.2024.2160p.WEB-DL-NTb'],
    bad: ['Wicked.For.Good.2025.2160p.WEB-DL-NTb', 'The.Wizard.of.Oz.1939.1080p.BluRay-x'],
  },
  {
    id: 'furiosa',
    q: 'furiosa: a mad max saga 2024',
    good: ['Furiosa.A.Mad.Max.Saga.2024.2160p.WEB-DL-NTb'],
    bad: ['Mad.Max.Fury.Road.2015.2160p.UHD.BluRay-x', 'Mad.Max.1979.1080p.BluRay-x'],
  },
  {
    id: 'penguin',
    q: 'the penguin s01e01',
    good: ['The.Penguin.S01E01.1080p.HBO.WEB-DL-NTb'],
    bad: ['The.Batman.2022.2160p.WEB-DL-NTb', 'Gotham.S01E01.1080p.WEB-DL-NTb'],
  },
  {
    id: 'mr-mrs-smith-tv',
    q: 'mr. & mrs. smith s01e01',
    good: ['Mr.and.Mrs.Smith.S01E01.1080p.PRIME.WEB-DL-NTb'],
    bad: ['Mr.and.Mrs.Smith.2005.1080p.BluRay-x'],
  },
  {
    id: 'mr-mrs-smith-movie',
    q: 'mr. & mrs. smith 2005',
    good: ['Mr.and.Mrs.Smith.2005.1080p.BluRay-x'],
    bad: ['Mr.and.Mrs.Smith.S01E01.1080p.PRIME.WEB-DL-NTb'],
  },
  {
    id: 'reacher',
    q: 'reacher s01e01',
    good: ['Reacher.S01E01.1080p.AMZN.WEB-DL-NTb'],
    bad: [
      'Jack.Reacher.2012.1080p.BluRay-x',
      'Jack.Reacher.Never.Go.Back.2016.1080p.BluRay-x',
      'Jack.Ryan.S01E01.1080p.AMZN.WEB-DL-NTb',
    ],
  },
  {
    id: 'himym',
    q: 'how i met your mother s01e01',
    good: ['How.I.Met.Your.Mother.S01E01.1080p.WEB-DL-NTb'],
    bad: ['How.I.Met.Your.Father.S01E01.1080p.HULU.WEB-DL-NTb'],
  },
  {
    id: 'bbt',
    q: 'the big bang theory s01e01',
    good: ['The.Big.Bang.Theory.S01E01.1080p.WEB-DL-NTb'],
    bad: ['Young.Sheldon.S01E01.1080p.WEB-DL-NTb', 'Georgie.and.Mandys.First.Marriage.S01E01.1080p.WEB-DL-x'],
  },
  {
    id: 'friends',
    q: 'friends s01e01',
    good: ['Friends.S01E01.1080p.WEB-DL-NTb'],
    bad: ['Joey.S01E01.1080p.WEB-DL-NTb', 'Friends.The.Reunion.2021.1080p.HBO.WEB-DL-x'],
  },
  {
    id: 'scream-1996',
    q: 'scream 1996',
    good: ['Scream.1996.1080p.BluRay-x'],
    bad: ['Scream.VI.2023.2160p.WEB-DL-NTb', 'Scream.2022.2160p.WEB-DL-NTb', 'Scream.Queens.S01E01.1080p.WEB-DL-x'],
  },
  {
    id: 'halloween-1978',
    q: 'halloween 1978',
    good: ['Halloween.1978.1080p.BluRay-x'],
    bad: [
      'Halloween.2018.2160p.WEB-DL-NTb',
      'Halloween.Kills.2021.2160p.WEB-DL-NTb',
      'Halloween.Ends.2022.2160p.WEB-DL-x',
    ],
  },
  {
    id: 'blade-runner-2049',
    q: 'blade runner 2049 2017',
    good: ['Blade.Runner.2049.2017.2160p.UHD.BluRay-x'],
    bad: ['Blade.Runner.1982.2160p.UHD.BluRay-x', 'Blade.Runner.Black.Lotus.S01E01.1080p.WEB-DL-x'],
  },
  {
    id: 'oceans-eleven-2001',
    q: "ocean's eleven 2001",
    good: ['Oceans.Eleven.2001.1080p.BluRay-x'],
    bad: ['Oceans.Eleven.1960.1080p.BluRay-x', 'Oceans.8.2018.2160p.WEB-DL-NTb', 'Oceans.Twelve.2004.1080p.BluRay-x'],
  },
  {
    id: 'witcher',
    q: 'the witcher s01e01',
    good: ['The.Witcher.S01E01.1080p.NF.WEB-DL-NTb'],
    bad: [
      'The.Witcher.Blood.Origin.S01E01.1080p.NF.WEB-DL-NTb',
      'The.Witcher.Nightmare.of.the.Wolf.2021.2160p.NF.WEB-DL-x',
    ],
  },
  {
    id: 'narcos',
    q: 'narcos s01e01',
    good: ['Narcos.S01E01.1080p.NF.WEB-DL-NTb'],
    bad: ['Narcos.Mexico.S01E01.1080p.NF.WEB-DL-NTb'],
  },
  {
    id: 'hunger-games-catching-fire',
    q: 'the hunger games: catching fire 2013',
    good: ['The.Hunger.Games.Catching.Fire.2013.2160p.UHD-x', 'Catching.Fire.2013.2160p.UHD-x'],
    bad: [
      'The.Hunger.Games.2012.2160p.UHD-x',
      'The.Hunger.Games.Mockingjay.Part.1.2014.2160p.UHD-x',
      'The.Hunger.Games.The.Ballad.of.Songbirds.and.Snakes.2023.2160p.WEB-DL-x',
    ],
  },
  {
    id: 'wakanda-forever',
    q: 'black panther: wakanda forever 2022',
    good: ['Black.Panther.Wakanda.Forever.2022.2160p.WEB-DL-NTb', 'Wakanda.Forever.2022.2160p.WEB-DL-NTb'],
    bad: ['Black.Panther.2018.2160p.WEB-DL-NTb'],
  },
  {
    id: 'winter-soldier',
    q: 'captain america: the winter soldier 2014',
    good: ['Captain.America.The.Winter.Soldier.2014.2160p.WEB-DL-NTb', 'The.Winter.Soldier.2014.2160p.WEB-DL-NTb'],
    bad: [
      'Captain.America.The.First.Avenger.2011.2160p.WEB-DL-x',
      'Captain.America.Civil.War.2016.2160p.WEB-DL-x',
      'Captain.America.Brave.New.World.2025.2160p.WEB-DL-x',
    ],
  },
  {
    id: 'joker-2019',
    q: 'joker 2019',
    good: ['Joker.2019.2160p.WEB-DL-NTb'],
    bad: ['Joker.Folie.a.Deux.2024.2160p.WEB-DL-NTb', 'The.Batman.2022.2160p.WEB-DL-NTb'],
  },
  {
    id: 'deadpool-wolverine',
    q: 'deadpool & wolverine 2024',
    good: ['Deadpool.and.Wolverine.2024.2160p.WEB-DL-NTb'],
    bad: ['Deadpool.2016.2160p.WEB-DL-NTb', 'Deadpool.2.2018.2160p.WEB-DL-NTb', 'Logan.2017.2160p.WEB-DL-x'],
  },
];

describe('title collisions: close names must not play the wrong title', () => {
  for (const c of CASES) {
    test(c.id, () => {
      const wanted = parseWantedTitle(c.q);
      for (const name of c.good) {
        assert.ok(releaseMatches(name, wanted), `${c.id} should ACCEPT ${name}`);
      }
      for (const name of c.bad) {
        assert.ok(!releaseMatches(name, wanted), `${c.id} should REJECT ${name}`);
      }
    });
  }
});

test('office US: catalog year on an episode query rejects the 2024 remake', () => {
  const wanted = parseWantedTitle('the office s01e01');
  assert.equal(wanted.year, null);
  wanted.year = 2005;
  assert.ok(releaseMatches('The.Office.S01E01.1080p.WEB-DL-NTb', wanted));
  assert.ok(releaseMatches('The.Office.US.S01E01.1080p.WEB-DL-NTb', wanted));
  assert.ok(!releaseMatches('The.Office.2024.S01E01.2160p.AMZN.WEB-DL-HONE', wanted));
  assert.ok(!releaseMatches('The Office (2024) S01E01 (1080p AMZN WEB-DL H265)', wanted));
});

test('catalog identity: tagged remake is rejected even when the filename has no year', () => {
  const params = { imdbid: 'tt0386679' };
  assert.ok(catalogIdentityMatches({ name: 'The.Office.S01E01.1080p.WEB-DL-NTb' }, params),
    'untagged NZB still allowed; year/name decide');
  assert.ok(catalogIdentityMatches({ name: 'The.Office.S01E01.1080p.WEB-DL-NTb', imdb: 'tt0386679' }, params));
  assert.ok(catalogIdentityMatches({ name: 'The.Office.S01E01.1080p.WEB-DL-NTb', imdb: '0386679' }, params));
  assert.ok(!catalogIdentityMatches({ name: 'The.Office.S01E01.1080p.WEB-DL-NTb', imdb: 'tt31806028' }, params),
    '2024 remake IMDb must not play for the 2005 show');
  assert.ok(!catalogIdentityMatches({ tvdbid: '999999' }, { tvdbid: '73255' }));
  assert.ok(catalogIdentityMatches({ tvdbid: '73255' }, { tvdbid: '73255' }));
});

test('title collisions: short indexer query never becomes a sibling franchise prefix', () => {
  const fellowship = parseWantedTitle('the lord of the rings: the fellowship of the ring 2001');
  const q = shortTitleQuery('The Lord of the Rings The Fellowship of the Ring 2001', fellowship);
  assert.match(q, /fellowship of the ring 2001/i);
  assert.doesNotMatch(q, /^lord of the rings/i);

  const lioness = parseWantedTitle('special ops: lioness s02e01');
  assert.strictEqual(shortTitleQuery('Special Ops Lioness S02E01', lioness), 'lioness S02E01');

  const dragon = parseWantedTitle('house of the dragon s01e01');
  assert.strictEqual(shortTitleQuery('House of the Dragon S01E01', dragon), '');

  const greys = parseWantedTitle("grey's anatomy s01e01");
  assert.strictEqual(shortTitleQuery("Grey's Anatomy S01E01", greys), '',
    "Grey's Anatomy must not search a fake short title Anatomy");

  const daredevil = parseWantedTitle("marvel's daredevil s01e01");
  assert.strictEqual(shortTitleQuery("Marvel's Daredevil S01E01", daredevil).toLowerCase(), 'daredevil S01E01'.toLowerCase());
});
