// Brief 137 step 5 test support. Runs the web's own subtitle-choice functions (by name, from web/index.html) against a scripted
// player state, so the same scenario table can be run on two commits. Used to pin "admin switch
// off = today's behaviour exactly" for brief 137 step 5.
const fs = require('fs');
function fnSource(ui, name) {
  const re = new RegExp(`\\n(?:async )?function ${name}\\(`);
  const m = re.exec(ui);
  if (!m) return null;
  const start = m.index + 1;
  const rest = ui.slice(start + 1);
  const end = rest.search(/\n(?:async function |function |const |let |var |window\.|\$\(|document\.|\/\/ ---)/);
  return ui.slice(start, start + 1 + (end < 0 ? rest.length : end));
}
const NAMES = [
  'startupSubtitleRelFor', 'subtitleRelPlayable', 'autoSubtitleRelFor', 'bestBuiltInSubtitleRel', 'bestReleaseSubtitleRel',
  'bestEmbeddedSubtitleRel', 'embeddedSubChoices', 'visibleEmbeddedSubChoices', 'releaseSubChoices', 'visibleReleaseSubChoices',
  'embeddedSubForRel', 'embeddedSubIndex', 'embeddedSubRel', 'releaseSubForRel', 'releaseSubRel', 'embeddedSubIsForced', 'embeddedSubIsSdh',
  'concreteSubtitleRel', 'builtInSubtitlesEnabled', 'prefSubtitleMode', 'nativeFileSubtitlesOn', 'fileSubChoices', 'fileSubForRel',
  'fileSubIndex', 'fileSubRel', 'subtitleChoiceMatchesPreferred', 'preferredSubtitleLangCode', 'showAllLocalSubtitles',
  'canAutoSubtitle', 'preferredAutoSubtitleLang', 'osTrackRel', 'osLang', 'osTrackInfo', 'episodeKeyParts', 'subtitleCatalogAvailable',
  'forcedRideAlongRel', 'fileSubtitleIntentRel', 'fileSubIntentFromRel', 'fileSubForIntent', 'nativeStartSubtitlePlan',
  'subtitleIntentFromSaved', 'fileSubPayload', 'audioTrackLangName', 'fileSubLabel', 'sourceSubtitleLabel',
  'bestFileSubtitleRel', 'fileSubIntentRel', 'sameSubLang', 'fileSubMatchesPreferred', 'audioLangKey',
];
function load(uiPath, env) {
  const ui = fs.readFileSync(uiPath, 'utf8');
  const srcs = [];
  for (const n of NAMES) { const s = fnSource(ui, n); if (s) srcs.push(s); }
  const body = `${srcs.join('\n')}\nreturn { ${NAMES.filter((n) => fnSource(ui, n)).join(', ')} };`;
  return new Function('S', 'localStorage', 'clientCaps', 'currentPlayerKind', 'prefLang', 'prefCcStyle', 'langCode', 'langName',
    'subtitleListConfident', 'bestSubtitleVariantRel', 'subtitleMiss', 'LANG_3TO2', 'subChoiceKey', 'loadSubChoice', 'profilePrefKey',
    'prefAudioLang', 'audioLangKey', 'subtitleImdbId', 'loadSubChoiceLabel', 'SERVER_SUBTITLE_EXTRACTION_ROWS', 'LANG_NAMES', 'FORCED_RIDE_MODE', body)(
    env.S, env.localStorage, env.clientCaps, env.currentPlayerKind, env.prefLang, () => env.ccStyle || 'dialogue',
    (l) => String(l || '').toLowerCase(), // like the page: "en" stays "en", "eng" stays "eng"
    (l) => ({ eng: 'English', fra: 'French', jpn: 'Japanese', kor: 'Korean' })[String(l || '').toLowerCase()] || String(l || ''),
    () => true, (l) => `os:${l}:best`, () => '', { eng: 'en', fra: 'fr', fre: 'fr', jpn: 'ja', kor: 'ko', chi: 'zh' }, () => 'k', () => env.saved || '',
    (n) => `triboon.${n}`, () => env.alang || '', null, () => 'tt0000001',
    () => env.label || '', false, { eng: 'English', fre: 'French', jpn: 'Japanese', kor: 'Korean' },
    ((ui.match(/^const FORCED_RIDE_MODE = '([a-z-]+)';$/m) || [])[1] || 'always'));
}
function scenario(uiPath, sc) {
  const store = { 'triboon.subtitleMode': sc.mode === 'always' ? 'always' : 'manual' };
  const p = {
    item: sc.episode ? { type: 'episode', key: 'tmdb:tv:1:1:2', season: 1, episode: 2, tmdbId: 1, imdbId: 'tt0000001' } : { type: 'movie', key: 'tmdb:movie:1', tmdbId: 1, imdbId: 'tt0000001' },
    mountId: 'm', tracksUrl: '/t', tracks: sc.tracks === false ? null : { audio: [{ rel: 0, lang: sc.audioLang || 'eng', codec: 'aac', channels: 2 }], subs: sc.subs || [], releaseSubs: sc.releaseSubs || [] },
    releaseSubs: sc.releaseSubs || [], _subtitleDisabledThisSession: !!sc.disabled, audioTrack: 0,
  };
  const env = {
    S: { playing: p, serverInfo: { builtInSubtitlesEnabled: sc.builtIn, opensubs: true } },
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
    clientCaps: () => sc.caps || {}, currentPlayerKind: () => sc.kind || 'direct', prefLang: (k) => (k === 'slang' ? (sc.slang ?? 'en') : ''),
    saved: sc.saved || '', ccStyle: sc.ccStyle, alang: sc.alang, label: sc.label || '',
  };
  if (sc.gaveUp) p._fileSubProbeGaveUp = true;
  const f = load(uiPath, env);
  const out = {};
  try { out.start = f.startupSubtitleRelFor(p, sc.saved || ''); } catch (e) { out.start = 'ERR ' + e.message; }
  try { out.builtIn = f.bestBuiltInSubtitleRel(); } catch (e) { out.builtIn = 'ERR ' + e.message; }
  try { out.auto = f.autoSubtitleRelFor(p); } catch (e) { out.auto = 'ERR ' + e.message; }
  try { out.emRows = f.embeddedSubChoices().map((x) => x.rel).join(','); } catch (e) { out.emRows = 'ERR ' + e.message; }
  try { out.fileOn = f.nativeFileSubtitlesOn ? f.nativeFileSubtitlesOn(p, sc.caps || {}, sc.kind || 'direct') : 'n/a'; } catch (e) { out.fileOn = 'ERR ' + e.message; }
  try { out.ride = f.forcedRideAlongRel ? f.forcedRideAlongRel(p, sc.saved || '', sc.rideMode) : 'n/a'; } catch (e) { out.ride = 'ERR ' + e.message; }
  try { out.intent = f.fileSubIntentRel ? f.fileSubIntentRel(p.tracks && p.tracks.subs && p.tracks.subs[2]) : 'n/a'; } catch (e) { out.intent = 'ERR ' + e.message; }
  return out;
}

function switchOffTable(ui) {
  const SUBS = [
    { rel: 0, lang: 'eng', codec: 'subrip', text: true, forced: true }, { rel: 1, lang: 'eng', codec: 'subrip', text: true },
    { rel: 2, lang: 'eng', codec: 'subrip', text: true, sdh: true }, { rel: 3, lang: 'jpn', codec: 'ass', text: true },
  ];
  const CAPS = { browser: { mkv: true }, oldApk: { native: true, source: 'exo-mediacodec' }, newApk: { native: true, source: 'exo-mediacodec', fileSubtitles: true }, win: { native: true, source: 'libmpv', fileSubtitles: true } };
  const rows = [];
  for (const builtIn of [false]) for (const mode of ['manual', 'always']) for (const episode of [false, true]) for (const extra of [{}, { slang: 'off' }, { disabled: true }, { ccStyle: 'sdh' }])
    for (const saved of ['', 'off', 'os:en:abc', 'em:1', 'rs:x']) for (const capsName of Object.keys(CAPS)) for (const kind of ['direct', 'remux']) for (const tracks of [true, false]) {
      const sc = { builtIn, mode, episode, saved, caps: CAPS[capsName], kind, subs: SUBS, tracks: tracks ? undefined : false, releaseSubs: [{ id: 'x', lang: 'eng', name: 'a.srt' }], ...extra };
      rows.push({ k: [mode, episode ? 'ep' : 'mv', saved || '-', capsName, kind, tracks ? 'probed' : 'noprobe', JSON.stringify(extra)].join('|'), ...scenario(ui, sc) });
    }
  return rows;
}

module.exports = { scenario, fnSource, NAMES, switchOffTable };
