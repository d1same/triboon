(function triboonWindowsPlayerUi() {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const state = {
    token: 0,
    mode: 'vod',
    title: 'Triboon',
    episodeLabel: '',
    source: '',
    qualityLabel: '',
    backdropUrl: '',
    playback: 'loading',
    playing: false,
    buffering: false,
    position: 0,
    duration: 0,
    buffered: 0,
    volume: 100,
    muted: false,
    hasNext: false,
    qualityChoices: false,
    favorite: false,
    subtitleRel: '',
    subtitleLabel: '',
    subtitleChoices: [],
    episodeChoices: [],
    episodeFocusIndex: 0,
    audioTracks: [],
    audioId: '',
    stats: {},
    upNext: null,
    liveEpg: [],
  };

  let invoke;
  let currentWindow;
  let hideTimer;
  let toastTimer;
  let loadingTimer;
  let timelinePreview = null;
  let lastVolume = 100;
  let pendingSeekDelta = 0;
  let pendingSeekTimer = null;

  function nativeInvoke(command, args) {
    if (!invoke) return Promise.reject(new Error('native transport unavailable'));
    return Promise.resolve(invoke(command, args || {}));
  }

  function send(action, payload) {
    const body = payload && typeof payload === 'object' ? { ...payload } : {};
    if (!Object.prototype.hasOwnProperty.call(body, 'playbackToken')) body.playbackToken = state.token || 0;
    return nativeInvoke('windows_player_control', { action, payload: body }).catch(() => {
      showToast('The player could not complete that action.');
    });
  }

  function decode(value) {
    if (typeof value !== 'string') return value;
    try { return JSON.parse(value); } catch { return value; }
  }

  function finite(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : (fallback || 0);
  }

  function bool(value, fallback) {
    return value === undefined || value === null ? !!fallback : !!value;
  }

  function text(value, max) {
    return String(value == null ? '' : value).slice(0, max || 500);
  }

  function safeMessage(value) {
    return text(value || 'The stream could not be played.', 240)
      .replace(/https?:\/\/\S+/gi, 'the media stream')
      .replace(/([?&](?:token|auth|key|password|username)=)[^&\s]+/gi, '$1[hidden]');
  }

  function safeArtwork(value) {
    if (!value) return '';
    try {
      const url = new URL(String(value));
      return /^https?:$/.test(url.protocol) ? url.href : '';
    } catch { return ''; }
  }

  function setArtwork(url) {
    const safe = safeArtwork(url);
    if (safe === state._renderedArtwork) return;
    state._renderedArtwork = safe;
    $('art').style.backgroundImage = safe ? `url(${JSON.stringify(safe)})` : '';
  }

  function formatTime(raw) {
    const seconds = Math.max(0, Math.floor(finite(raw)));
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
  }

  function formatBytes(value) {
    const bytes = finite(value);
    if (!bytes) return '';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const rank = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
    return `${(bytes / (1024 ** rank)).toFixed(rank > 1 ? 1 : 0)} ${units[rank]}`;
  }

  function formatRate(value) {
    const raw = finite(value);
    if (!raw) return '';
    const bps = raw > 100000 ? raw : raw * 1000;
    return `${(bps / 1000000).toFixed(1)} Mbps`;
  }

  function showToast(message) {
    const toast = $('toast');
    toast.textContent = text(message, 180);
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 2300);
  }

  function announce(message) {
    $('srStatus').textContent = '';
    requestAnimationFrame(() => { $('srStatus').textContent = message; });
  }

  function beginLoadingStages() {
    clearInterval(loadingTimer);
    const stages = ['Preparing the player...', 'Opening the stream...', 'Filling the playback buffer...', 'Waiting for the first video frame...'];
    let index = 0;
    $('loadingStage').textContent = stages[0];
    loadingTimer = setInterval(() => {
      index = Math.min(index + 1, stages.length - 1);
      $('loadingStage').textContent = stages[index];
      if (index === stages.length - 1) clearInterval(loadingTimer);
    }, 1100);
  }

  function setPlayback(value) {
    state.playback = value;
    state.playing = value === 'playing';
    state.buffering = value === 'buffering';
    document.body.dataset.state = value;
    if (value !== 'loading' && value !== 'buffering') clearInterval(loadingTimer);
    const paused = value === 'paused';
    const icon = paused || value === 'ready' ? '#i-play' : '#i-pause';
    $('playPauseIcon').setAttribute('href', icon);
    $('centerPlayIcon').setAttribute('href', '#i-play');
    $('playPause').setAttribute('aria-label', paused || value === 'ready' ? 'Play' : 'Pause');
    if (!state.playing) showControls(true);
    else scheduleHide();
  }

  function updateTimeline() {
    const duration = Math.max(0, state.duration);
    const position = Math.max(0, timelinePreview == null ? state.position : timelinePreview);
    const ratio = duration > 0 ? Math.min(1, position / duration) : 0;
    const buffered = duration > 0
      ? Math.min(1, state.buffered > 1 ? state.buffered / duration : state.buffered)
      : 0;
    $('timeline').value = Math.round(ratio * 1000);
    $('timeline').style.setProperty('--seek', `${ratio * 100}%`);
    $('timeline').disabled = !duration || state.mode === 'live';
    $('bufferBar').style.width = `${Math.max(ratio, buffered) * 100}%`;
    $('currentTime').textContent = state.mode === 'live' ? 'Live' : formatTime(position);
    $('duration').textContent = state.mode === 'live' ? '' : formatTime(duration);
    $('timeline').setAttribute('aria-valuetext', `${formatTime(position)} of ${formatTime(duration)}`);
  }

  function updateGpu(stats) {
    const badge = $('gpuBadge');
    const decoder = text(stats.hwdec || stats.hwdecCurrent || stats.hardwareDecoder || '', 80);
    const explicit = stats.hwdecActive ?? stats.hardwareDecoding ?? stats.gpuActive;
    const active = explicit === true || (!!decoder && !/^(no|none|false|software)$/i.test(decoder));
    const known = explicit !== undefined || !!decoder;
    badge.classList.toggle('active', active);
    badge.classList.toggle('fallback', known && !active);
    badge.classList.toggle('checking', !known);
    const label = active ? `GPU ${decoder || 'active'}` : (known ? 'CPU fallback' : 'GPU checking');
    badge.querySelector('span').textContent = label;
    badge.title = active
      ? `Hardware video decoding is active${decoder ? ` (${decoder})` : ''}`
      : (known ? 'Hardware decoding is unavailable for this stream; software fallback is active' : 'Hardware decoding has not been measured yet');
  }

  function updateOptionalControls() {
    document.body.classList.toggle('live', state.mode === 'live');
    $('next').hidden = !state.hasNext;
    $('episodes').hidden = !state.episodeChoices.length;
    $('quality').hidden = !state.qualityChoices;
    $('audio').hidden = state.audioTracks.length < 2;
    $('guide').hidden = state.mode !== 'live';
    $('favorite').hidden = state.mode !== 'live';
    $('favorite').classList.toggle('favorite-on', state.favorite);
    $('favorite').setAttribute('aria-label', state.favorite ? 'Remove channel from favorites' : 'Add channel to favorites');
    $('captions').classList.toggle('active', !!state.subtitleRel);
  }

  function render() {
    $('title').textContent = state.title || 'Triboon';
    $('episode').textContent = state.episodeLabel || '';
    $('source').textContent = [state.source, state.qualityLabel].filter(Boolean).join('  -  ');
    $('loadingTitle').textContent = state.title ? `Opening ${state.title}` : 'Opening video';
    setArtwork(state.backdropUrl);
    $('volume').value = state.muted ? 0 : Math.max(0, Math.min(100, state.volume));
    updateTimeline();
    updateGpu(state.stats);
    updateOptionalControls();
    renderUpNext();
    renderLiveEpg();
    if ($('stats').classList.contains('open')) renderStats();
  }

  function copySession(data) {
    const session = data.session && typeof data.session === 'object' ? data.session : data;
    state.token = finite(session.playbackToken ?? session.token, state.token);
    state.mode = bool(session.isLive, session.mode === 'live' || session.kind === 'live') ? 'live' : (session.mode || state.mode);
    state.title = text(session.title || state.title, 300);
    state.episodeLabel = text(session.episodeLabel ?? session.episode ?? state.episodeLabel, 180);
    state.source = text(session.source ?? state.source, 260);
    state.qualityLabel = text(session.qualityLabel ?? state.qualityLabel, 80);
    state.backdropUrl = session.backdropUrl ?? session.backdrop ?? state.backdropUrl;
    state.duration = Math.max(0, finite(session.duration, state.duration));
    state.position = Math.max(0, finite(session.position ?? session.pos ?? session.start, state.position));
    state.hasNext = bool(session.hasNext, state.hasNext);
    state.qualityChoices = bool(session.qualityChoices ?? session.hasQualityChoices, state.qualityChoices);
    if (Array.isArray(session.subtitleChoices)) state.subtitleChoices = session.subtitleChoices;
    if (Array.isArray(session.episodeChoices)) state.episodeChoices = session.episodeChoices;
    if (session.episodeFocusIndex !== undefined) {
      state.episodeFocusIndex = Math.max(0, finite(session.episodeFocusIndex));
    }
    if (session.subtitleRel !== undefined) state.subtitleRel = text(session.subtitleRel, 1000);
    if (session.subtitleLabel !== undefined) state.subtitleLabel = text(session.subtitleLabel, 200);
    if (Array.isArray(session.audioTracks)) state.audioTracks = session.audioTracks;
    if (session.audioId !== undefined) state.audioId = text(session.audioId, 32);
    if (session.upNext !== undefined) {
      state.upNext = session.upNext && typeof session.upNext === 'object' ? session.upNext : null;
    }
    if (session.liveFavorite !== undefined) state.favorite = !!session.liveFavorite;
    if (Array.isArray(session.liveEpg)) state.liveEpg = session.liveEpg;
    const currentEpisode = state.episodeChoices.findIndex((episode) => episode && episode.current);
    if (currentEpisode >= 0) state.episodeFocusIndex = currentEpisode;
    const snapshotStats = { player: 'libmpv' };
    for (const [target, source] of [
      ['hwdec', 'hwdec'], ['videoCodec', 'videoCodec'], ['audioCodec', 'audioCodec'],
      ['width', 'width'], ['height', 'height'], ['fps', 'fps'],
      ['droppedFrames', 'droppedFrames'], ['bitrate', 'bitrate'],
      ['bufferedSeconds', 'buffered'], ['size', 'sourceSize'],
    ]) {
      if (session[source] !== undefined && session[source] !== '' && session[source] !== null) {
        snapshotStats[target] = session[source];
      }
    }
    if (session.hwdec || finite(session.width) > 0) snapshotStats.hwdecActive = !!session.hwdecActive;
    mergeStats(snapshotStats);
    document.body.classList.toggle('guide-pip', !!session.guide);
  }

  function mergeStats(data) {
    const raw = decode(data.stats ?? data);
    if (!raw || typeof raw !== 'object') return;
    state.stats = { ...state.stats, ...raw };
    const pos = raw.position ?? raw.pos ?? raw.timePos;
    const duration = raw.duration;
    if (Number.isFinite(Number(pos))) state.position = Math.max(0, finite(pos));
    if (Number.isFinite(Number(duration))) state.duration = Math.max(0, finite(duration));
    const cache = raw.buffered ?? raw.bufferedSeconds ?? raw.cacheDuration ?? raw.demuxerCacheDuration;
    if (Number.isFinite(Number(cache))) {
      const seconds = Math.max(0, finite(cache));
      state.buffered = state.duration > 0 ? Math.min(state.duration, state.position + seconds) : seconds;
    }
  }

  function applyUpdate(kind, data) {
    if (kind === 'subtitle_choices') {
      state.subtitleChoices = Array.isArray(data.choices) ? data.choices : [];
    } else if (kind === 'active_subtitle') {
      state.subtitleRel = text(data.subtitleRel ?? data.rel, 1000);
      state.subtitleLabel = text(data.subtitleLabel ?? data.label, 200);
    } else if (kind === 'duration') {
      state.duration = Math.max(0, finite(data.seconds ?? data.duration, state.duration));
    } else if (kind === 'episode_choices') {
      state.episodeChoices = Array.isArray(data.episodes) ? data.episodes : [];
      state.episodeFocusIndex = Math.max(0, finite(data.focusIndex));
    } else if (kind === 'audio_tracks') {
      state.audioTracks = Array.isArray(data.tracks) ? data.tracks : [];
      state.audioId = data.activeId ?? data.id ?? state.audioId;
    } else if (kind === 'up_next') {
      state.upNext = data.hidden ? null : data;
    } else if (kind === 'live_favorite') {
      state.favorite = !!data.on;
    } else if (kind === 'live_epg') {
      state.liveEpg = Array.isArray(data.programs) ? data.programs : [];
    } else if (kind === 'stats') {
      mergeStats(data);
    }
  }

  function normalizeEvent(raw) {
    let event = decode(raw);
    if (!event || typeof event !== 'object') return null;
    if (event.detail && typeof event.detail === 'object') event = event.detail;
    const payload = decode(event.payload);
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) event = { ...event, ...payload };
    if (event.state && typeof event.state === 'object') event = { ...event, ...event.state };
    return event;
  }

  function applyEvent(raw) {
    const event = normalizeEvent(raw);
    if (!event) return;
    const type = text(event.type || event.event || event.kind || '', 80).toLowerCase().replace(/-/g, '_');
    const data = event.data && typeof event.data === 'object' ? { ...event, ...event.data } : event;
    if (type === 'update') applyUpdate(text(event.kind || data.updateKind, 80), decode(event.value || event.payload || event.data) || {});
    else if (['subtitle_choices', 'active_subtitle', 'duration', 'episode_choices', 'audio_tracks', 'up_next', 'live_favorite', 'live_epg'].includes(type)) applyUpdate(type, data);

    if (['loading', 'session', 'state_snapshot', 'ready', 'playing', 'paused', 'buffering', 'progress', 'stats'].includes(type)) copySession(data);
    if (Number.isFinite(Number(data.position ?? data.pos ?? data.timePos))) state.position = Math.max(0, finite(data.position ?? data.pos ?? data.timePos));
    if (Number.isFinite(Number(data.duration))) state.duration = Math.max(0, finite(data.duration));
    if (Number.isFinite(Number(data.volume))) state.volume = Math.max(0, Math.min(100, finite(data.volume)));
    if (data.muted !== undefined) state.muted = !!data.muted;
    if (Array.isArray(data.audioTracks)) state.audioTracks = data.audioTracks;
    if (data.audioId !== undefined) state.audioId = data.audioId;

    switch (type) {
      case 'loading':
      case 'session':
        setPlayback('loading');
        beginLoadingStages();
        break;
      case 'state_snapshot':
        if (data.buffering) setPlayback('buffering');
        else if (data.playing) setPlayback('playing');
        else setPlayback('paused');
        break;
      case 'surface_ready':
        break;
      case 'ready':
        setPlayback(data.playing === false || data.paused ? 'paused' : 'ready');
        announce('Video ready');
        break;
      case 'playing':
        setPlayback('playing');
        announce('Playing');
        break;
      case 'paused':
        setPlayback('paused');
        announce('Paused');
        break;
      case 'buffering':
        setPlayback('buffering');
        $('loadingStage').textContent = 'Buffering...';
        break;
      case 'progress':
        if (state.playback === 'ready' && data.playing !== false) setPlayback('playing');
        break;
      case 'stats':
        mergeStats(data);
        break;
      case 'error':
        setPlayback('error');
        $('errorText').textContent = safeMessage(data.message || data.error);
        announce('Playback stopped');
        break;
      case 'closed':
        setPlayback('loading');
        break;
      case 'live':
      case 'live_ready':
        state.mode = 'live';
        copySession(data);
        setPlayback('playing');
        break;
      default:
        break;
    }
    render();
  }

  function renderUpNext() {
    const next = state.upNext;
    const el = $('upNext');
    if (!next || next.hidden) { el.classList.remove('show'); return; }
    el.classList.add('show');
    $('upNextTitle').textContent = text(next.title || 'Next episode', 180);
    $('upNextSub').textContent = text(next.sub || '', 180);
    const seconds = Math.max(0, Math.ceil(finite(next.seconds)));
    $('upNextSeconds').textContent = next.autoplay && seconds ? `- ${seconds}s` : '';
    const total = Math.max(seconds, finite(next.totalSeconds, 10));
    $('upNextProgress').style.width = next.autoplay ? `${Math.max(0, Math.min(100, (1 - seconds / total) * 100))}%` : '0';
  }

  function renderLiveEpg() {
    const strip = $('liveEpg');
    if (state.mode !== 'live') { strip.replaceChildren(); return; }
    const now = Date.now();
    const programs = (state.liveEpg || []).filter((program) => program && finite(program.stop) > now).slice(0, 4);
    strip.replaceChildren(...programs.map((program) => {
      const cell = document.createElement('span');
      const current = finite(program.start) <= now && finite(program.stop) > now;
      if (current) cell.className = 'now';
      const when = document.createElement('b');
      when.textContent = current ? 'NOW' : new Date(finite(program.start)).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      cell.append(when, document.createTextNode(text(program.title || 'Programme', 140)));
      return cell;
    }));
  }

  function showControls(forceFocus) {
    document.body.classList.remove('controls-hidden');
    scheduleHide();
    if (forceFocus && !isPanelOpen()) setTimeout(() => $('playPause').focus({ preventScroll: true }), 0);
  }

  function scheduleHide() {
    clearTimeout(hideTimer);
    if (!state.playing || isPanelOpen()) return;
    hideTimer = setTimeout(() => {
      if (!isPanelOpen() && state.playing) document.body.classList.add('controls-hidden');
    }, 3600);
  }

  function isPanelOpen() {
    return $('menu').classList.contains('open') || $('stats').classList.contains('open');
  }

  function closePanels() {
    const open = isPanelOpen();
    $('menu').classList.remove('open');
    $('menu').setAttribute('aria-hidden', 'true');
    $('stats').classList.remove('open');
    $('stats').setAttribute('aria-hidden', 'true');
    if (open) { showControls(false); $('playPause').focus({ preventScroll: true }); }
    return open;
  }

  function menuItem(label, options, activate) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'menu-item';
    button.setAttribute('role', 'menuitem');
    if (options && options.selected) button.classList.add('selected');
    if (options && options.disabled) button.disabled = true;
    const menuArtwork = options && options.art ? safeArtwork(options.art) : '';
    if (menuArtwork) {
      const image = document.createElement('img');
      image.className = 'episode-art';
      image.alt = '';
      image.src = menuArtwork;
      button.appendChild(image);
    }
    const box = document.createElement('span');
    const strong = document.createElement('strong');
    strong.textContent = text(label || 'Option', 220);
    box.appendChild(strong);
    if (options && options.sub) {
      const small = document.createElement('small');
      small.textContent = text(options.sub, 180);
      box.appendChild(small);
    }
    button.appendChild(box);
    button.addEventListener('click', () => { if (!button.disabled) activate(); });
    return button;
  }

  function openMenu(title, kicker, items) {
    closePanels();
    $('menuTitle').textContent = title;
    $('menuKicker').textContent = kicker || 'PLAYER';
    const list = $('menuList');
    list.replaceChildren(...items);
    $('menu').classList.add('open');
    $('menu').setAttribute('aria-hidden', 'false');
    showControls(false);
    requestAnimationFrame(() => {
      const selected = list.querySelector('.selected:not([disabled])');
      const first = list.querySelector('button:not([disabled])');
      (selected || first || $('menuClose')).focus({ preventScroll: true });
    });
  }

  function openSubtitleMenu() {
    const items = [menuItem('Off', { selected: !state.subtitleRel }, () => {
      closePanels(); send('subtitle', { rel: '' });
    })];
    state.subtitleChoices.forEach((choice) => {
      if (!choice || typeof choice !== 'object') return;
      const disabled = choice.action === 'missing';
      items.push(menuItem(choice.label || 'Subtitle', {
        selected: !!choice.rel && choice.rel === state.subtitleRel,
        disabled,
        sub: choice.lang ? String(choice.lang).toUpperCase() : '',
      }, () => {
        closePanels();
        if (choice.action === 'local_all') send('subtitle_show_all');
        else if (choice.action === 'versions') send('subtitle_versions', { lang: choice.lang || '' });
        else send('subtitle', {
          rel: choice.rel || '', url: choice.url || '', lang: choice.lang || '',
          label: choice.label || 'Triboon subtitles', shift: finite(choice.shift),
          size: choice.size || 'M',
        });
      }));
    });
    openMenu('Subtitles', state.subtitleLabel || 'CLOSED CAPTIONS', items);
  }

  function openAudioMenu() {
    const items = state.audioTracks.map((track, index) => menuItem(
      track.label || track.title || track.lang || `Audio ${index + 1}`,
      { selected: String(track.id ?? track.rel ?? index) === String(state.audioId), sub: track.codec || track.channels || '' },
      () => { closePanels(); send('audio', { id: track.id ?? track.rel ?? index }); },
    ));
    if (items.length) openMenu('Audio track', 'SOUND', items);
  }

  function openQualityMenu() {
    const values = [
      { value: 'orig', label: 'Original quality', sub: 'Direct play when possible' },
      { value: 2160, label: '4K', sub: 'Up to 2160p' },
      { value: 1080, label: '1080p', sub: 'Full HD' },
      { value: 720, label: '720p', sub: 'Lower bandwidth' },
      { value: 480, label: '480p', sub: 'Data saver' },
    ];
    const items = values.map((item) => menuItem(item.label, {
      selected: state.qualityLabel && item.label.toLowerCase() === state.qualityLabel.toLowerCase(),
      sub: item.sub,
    }, () => { closePanels(); send('quality', { quality: item.value }); }));
    openMenu('Video quality', 'PLAYBACK', items);
  }

  function openEpisodeMenu() {
    const items = state.episodeChoices.map((episode, index) => menuItem(
      [episode.tag, episode.name].filter(Boolean).join(' - ') || `Episode ${index + 1}`,
      {
        selected: !!episode.current || index === state.episodeFocusIndex,
        disabled: !!episode.upcoming,
        art: episode.still,
        sub: episode.watched ? 'Watched' : (episode.upcoming ? 'Upcoming' : ''),
      },
      () => { closePanels(); send('episode', { index: finite(episode.index, index) }); },
    ));
    if (items.length) openMenu('Episodes', 'KEEP WATCHING', items);
  }

  function renderStats() {
    const stats = state.stats || {};
    const decoder = text(stats.hwdec || stats.hwdecCurrent || stats.hardwareDecoder || '', 100);
    const active = stats.hwdecActive === true || (!!decoder && !/^(no|none|software)$/i.test(decoder));
    const width = finite(stats.width || stats.videoWidth);
    const height = finite(stats.height || stats.videoHeight);
    const rows = [
      ['Decoder', active ? `GPU - ${decoder || 'hardware'}` : (decoder ? 'CPU fallback' : 'Checking')],
      ['Video', [text(stats.videoCodec || stats.vcodec, 50), width && height ? `${width}x${height}` : ''].filter(Boolean).join(' - ') || 'Unknown'],
      ['Audio', [text(stats.audioCodec || stats.acodec, 50), text(stats.audioChannels || stats.channels, 40)].filter(Boolean).join(' - ') || 'Unknown'],
      ['Frame rate', stats.fps ? `${finite(stats.fps).toFixed(2)} fps` : 'Unknown'],
      ['Dropped frames', String(Math.max(0, finite(stats.droppedFrames || stats.frameDropCount)))],
      ['Bitrate', formatRate(stats.bitrate || stats.videoBitrate) || 'Unknown'],
      ['Buffer ahead', `${Math.max(0, finite(stats.bufferedSeconds || stats.cacheDuration || stats.demuxerCacheDuration)).toFixed(1)} s`],
      ['Source size', formatBytes(stats.size || stats.fileSize) || 'Unknown'],
      ['Player', text(stats.player || 'libmpv', 80)],
    ];
    const list = $('statsList');
    list.replaceChildren(...rows.map(([label, value]) => {
      const row = document.createElement('div');
      const dt = document.createElement('dt'); dt.textContent = label;
      const dd = document.createElement('dd'); dd.textContent = value;
      row.append(dt, dd); return row;
    }));
  }

  function openStats() {
    closePanels();
    renderStats();
    $('stats').classList.add('open');
    $('stats').setAttribute('aria-hidden', 'false');
    showControls(false);
    requestAnimationFrame(() => $('statsClose').focus({ preventScroll: true }));
  }

  function togglePlayback() { send('toggle'); }
  function seekRelative(seconds) {
    if (state.mode === 'live') return;
    pendingSeekDelta += finite(seconds);
    if (pendingSeekTimer) return;
    pendingSeekTimer = setTimeout(() => {
      const delta = pendingSeekDelta;
      pendingSeekDelta = 0;
      pendingSeekTimer = null;
      if (delta) send('seek_relative', { seconds: delta });
    }, 80);
  }

  async function toggleFullscreen() {
    try {
      if (currentWindow) {
        const full = await currentWindow.isFullscreen();
        await currentWindow.setFullscreen(!full);
        showControls(false);
        return;
      }
    } catch {}
    send('fullscreen');
  }

  function requestClose() { closePanels(); send('close'); }

  function bindControls() {
    $('surface').addEventListener('dblclick', toggleFullscreen);
    $('surface').addEventListener('click', (event) => {
      if (event.target === $('surface')) showControls(false);
    });
    $('centerPlay').addEventListener('click', togglePlayback);
    $('playPause').addEventListener('click', togglePlayback);
    $('back').addEventListener('click', () => seekRelative(-10));
    $('forward').addEventListener('click', () => seekRelative(30));
    $('next').addEventListener('click', () => send('next'));
    $('captions').addEventListener('click', openSubtitleMenu);
    $('audio').addEventListener('click', openAudioMenu);
    $('quality').addEventListener('click', openQualityMenu);
    $('episodes').addEventListener('click', openEpisodeMenu);
    $('details').addEventListener('click', openStats);
    $('guide').addEventListener('click', () => nativeInvoke('windows_player_open_guide', {}).catch(() => showToast('The TV guide could not be opened.')));
    $('favorite').addEventListener('click', () => send('favorite', { on: !state.favorite }));
    $('fullscreen').addEventListener('click', toggleFullscreen);
    $('upNext').addEventListener('click', () => send('next'));
    $('retry').addEventListener('click', () => { setPlayback('loading'); beginLoadingStages(); send('retry'); });
    $('errorClose').addEventListener('click', requestClose);
    $('windowClose').addEventListener('click', requestClose);
    $('menuClose').addEventListener('click', closePanels);
    $('statsClose').addEventListener('click', closePanels);
    $('minimize').addEventListener('click', async () => {
      try { if (currentWindow) await currentWindow.minimize(); else await send('minimize'); } catch { showToast('Could not minimize the player.'); }
    });

    $('timeline').addEventListener('input', (event) => {
      timelinePreview = state.duration * (finite(event.target.value) / 1000);
      updateTimeline(); showControls(false);
    });
    $('timeline').addEventListener('change', () => {
      if (timelinePreview != null) send('seek_absolute', { seconds: timelinePreview });
      timelinePreview = null;
    });

    $('volume').addEventListener('input', (event) => {
      const value = Math.max(0, Math.min(100, finite(event.target.value)));
      state.volume = value; state.muted = value === 0;
      if (value > 0) lastVolume = value;
      send('volume', { volume: value });
    });
    $('mute').addEventListener('click', () => {
      if (!state.muted && state.volume > 0) lastVolume = state.volume;
      const volume = state.muted || state.volume === 0 ? Math.max(1, lastVolume) : 0;
      state.volume = volume; state.muted = volume === 0; render();
      send('volume', { volume });
    });
  }

  function visibleFocusables(root) {
    return [...(root || document).querySelectorAll('button:not([hidden]):not([disabled]),input:not([hidden]):not([disabled])')]
      .filter((el) => el.offsetParent !== null);
  }

  function moveFocus(direction) {
    const root = $('menu').classList.contains('open') ? $('menu') : ($('stats').classList.contains('open') ? $('stats') : $('controls'));
    const focusables = visibleFocusables(root);
    if (!focusables.length) return;
    let index = focusables.indexOf(document.activeElement);
    if (index < 0) index = direction > 0 ? -1 : 0;
    focusables[(index + direction + focusables.length) % focusables.length].focus({ preventScroll: true });
  }

  function handleBack() {
    if (closePanels()) return;
    requestClose();
  }

  function handleKey(event) {
    const tag = document.activeElement && document.activeElement.tagName;
    const rangeFocused = tag === 'INPUT' && document.activeElement.type === 'range';
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (['Shift', 'Control', 'Alt', 'Meta'].includes(event.key)) return;
    showControls(false);

    if (event.key === 'Escape' || event.key === 'Backspace' || event.key === 'BrowserBack') {
      event.preventDefault(); handleBack(); return;
    }
    if (isPanelOpen()) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowRight') { event.preventDefault(); moveFocus(1); }
      else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') { event.preventDefault(); moveFocus(-1); }
      return;
    }
    if (rangeFocused) return;
    const activeControl = document.activeElement && document.activeElement.closest
      ? document.activeElement.closest('#controls') : null;
    if (activeControl && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
      event.preventDefault();
      moveFocus(event.key === 'ArrowRight' ? 1 : -1);
      return;
    }
    const key = event.key.toLowerCase();
    if (event.key === ' ' || key === 'k' || key === 'mediaplaypause') { event.preventDefault(); togglePlayback(); }
    else if (event.key === 'ArrowLeft' || key === 'j' || key === 'mediarewind') { event.preventDefault(); seekRelative(-10); }
    else if (event.key === 'ArrowRight' || key === 'l' || key === 'mediafastforward') { event.preventDefault(); seekRelative(30); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); moveFocus(-1); }
    else if (event.key === 'ArrowDown') { event.preventDefault(); moveFocus(1); }
    else if (event.key === 'Enter' && (document.activeElement === document.body || document.activeElement === $('surface'))) { event.preventDefault(); togglePlayback(); }
    else if (key === 'f') { event.preventDefault(); toggleFullscreen(); }
    else if (key === 'm') { event.preventDefault(); $('mute').click(); }
    else if (key === 'c') { event.preventDefault(); openSubtitleMenu(); }
    else if (key === 'i') { event.preventDefault(); openStats(); }
    else if (key === 'n' && state.hasNext) { event.preventDefault(); send('next'); }
    else if (key === 'g' && state.mode === 'live') { event.preventDefault(); $('guide').click(); }
    else if (state.mode === 'live' && (event.key === 'PageUp' || key === 'mediaprevioustrack')) {
      event.preventDefault(); send('live_zap', { direction: -1 });
    }
    else if (state.mode === 'live' && (event.key === 'PageDown' || key === 'medianexttrack')) {
      event.preventDefault(); send('live_zap', { direction: 1 });
    }
  }

  function setupMediaKeys() {
    if (!('mediaSession' in navigator)) return;
    const handlers = {
      play: () => send('play'),
      pause: () => send('pause'),
      seekbackward: (details) => seekRelative(-(details.seekOffset || 10)),
      seekforward: (details) => seekRelative(details.seekOffset || 30),
      seekto: (details) => send('seek_absolute', { seconds: Math.max(0, finite(details.seekTime)) }),
      nexttrack: () => { if (state.hasNext) send('next'); },
      stop: requestClose,
    };
    Object.entries(handlers).forEach(([name, handler]) => {
      try { navigator.mediaSession.setActionHandler(name, handler); } catch {}
    });
  }

  function setupGamepad() {
    const pressed = new Map();
    function edge(index, button) {
      const key = `${index}:${button}`;
      const pad = navigator.getGamepads && navigator.getGamepads()[index];
      const down = !!(pad && pad.buttons[button] && pad.buttons[button].pressed);
      const previous = pressed.get(key) || false;
      pressed.set(key, down);
      return down && !previous;
    }
    setInterval(() => {
      const pads = navigator.getGamepads ? [...navigator.getGamepads()].filter(Boolean) : [];
      pads.forEach((pad) => {
        const i = pad.index;
        if (edge(i, 0)) {
          const active = document.activeElement;
          if (active && /^(BUTTON|INPUT)$/.test(active.tagName) && active.click) active.click();
          else togglePlayback();
        }
        if (edge(i, 1)) handleBack();
        if (edge(i, 4)) seekRelative(-10);
        if (edge(i, 5)) seekRelative(30);
        if (edge(i, 9)) togglePlayback();
        if (edge(i, 12)) moveFocus(-1);
        if (edge(i, 13)) moveFocus(1);
        if (edge(i, 14)) moveFocus(-1);
        if (edge(i, 15)) moveFocus(1);
      });
    }, 90);
  }

  async function setupNative() {
    const tauri = window.__TAURI__ || {};
    invoke = tauri.core && tauri.core.invoke;
    if (!invoke && window.__TAURI_INTERNALS__) invoke = window.__TAURI_INTERNALS__.invoke;
    try {
      if (tauri.window && tauri.window.getCurrentWindow) currentWindow = tauri.window.getCurrentWindow();
      else if (tauri.webviewWindow && tauri.webviewWindow.getCurrentWebviewWindow) currentWindow = tauri.webviewWindow.getCurrentWebviewWindow();
    } catch {}

    const listen = tauri.event && tauri.event.listen;
    if (typeof listen === 'function') {
      try { await listen('triboon-player-state', (event) => applyEvent(event.payload)); } catch {}
    }
    await send('request_state');
  }

  Object.defineProperty(window, '__triboonWindowsPlayerEvent', {
    configurable: false,
    enumerable: false,
    writable: false,
    value: applyEvent,
  });

  bindControls();
  document.addEventListener('keydown', handleKey);
  document.addEventListener('mousemove', () => showControls(false), { passive: true });
  document.addEventListener('pointerdown', () => showControls(false), { passive: true });
  setupMediaKeys();
  setupGamepad();
  setPlayback('loading');
  beginLoadingStages();
  render();
  setupNative();
})();
