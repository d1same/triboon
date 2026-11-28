'use strict';

(function () {
  const STORAGE_KEY = 'triboon.tizen.server';
  const PROBE_TIMEOUT_MS = 5000;
  const helpers = window.TriboonTizenUrl;

  const form = document.getElementById('connectForm');
  const input = document.getElementById('serverInput');
  const connectBtn = document.getElementById('connectBtn');
  const retryBtn = document.getElementById('retryBtn');
  const statusEl = document.getElementById('status');
  const savedRow = document.getElementById('savedRow');
  const savedUrlEl = document.getElementById('savedUrl');

  let busy = false;
  let activeOrigin = '';

  function registerSamsungKeys() {
    try {
      if (!window.tizen || !window.tizen.tvinputdevice) return;
      const keys = ['MediaPlay', 'MediaPause', 'MediaPlayPause', 'MediaStop', 'MediaFastForward', 'MediaRewind', 'ChannelUp', 'ChannelDown'];
      if (typeof window.tizen.tvinputdevice.registerKeyBatch === 'function') {
        window.tizen.tvinputdevice.registerKeyBatch(keys);
      } else if (typeof window.tizen.tvinputdevice.registerKey === 'function') {
        keys.forEach((k) => { try { window.tizen.tvinputdevice.registerKey(k); } catch {} });
      }
    } catch {}
  }

  function exitTizenApp() {
    try {
      if (window.tizen && window.tizen.application && typeof window.tizen.application.getCurrentApplication === 'function') {
        window.tizen.application.getCurrentApplication().exit();
        return;
      }
    } catch {}
    try {
      window.close();
    } catch {}
  }

  function setStatus(message, kind) {
    statusEl.textContent = message || '';
    statusEl.className = 'status' + (kind ? ' ' + kind : '');
  }

  function setBusy(on) {
    busy = !!on;
    connectBtn.disabled = busy;
    retryBtn.disabled = busy;
    input.disabled = busy;
    connectBtn.textContent = busy ? 'Connecting…' : 'Connect';
  }

  function getSavedServer() {
    try {
      return helpers.normalizeServerUrl(window.localStorage.getItem(STORAGE_KEY) || '');
    } catch {
      return '';
    }
  }

  function saveServer(origin) {
    try {
      window.localStorage.setItem(STORAGE_KEY, origin);
    } catch {}
  }

  function probeServer(origin) {
    return new Promise((resolve, reject) => {
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        reject(new Error('Could not reach your Triboon server (timed out). Check that the server is running and on the same network.'));
      }, PROBE_TIMEOUT_MS);

      const finish = (err, data) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve(data);
      };

      try {
        const xhr = new XMLHttpRequest();
        xhr.open('GET', origin + '/api/server', true);
        xhr.timeout = PROBE_TIMEOUT_MS;
        xhr.setRequestHeader('Accept', 'application/json');
        xhr.onreadystatechange = function () {
          if (xhr.readyState !== 4) return;
          if (xhr.status < 200 || xhr.status >= 300) {
            finish(new Error('Server responded with HTTP ' + (xhr.status || 'network error') + '.'));
            return;
          }
          try {
            const parsed = JSON.parse(xhr.responseText || '{}');
            if (!helpers.isValidTriboonServerPayload(parsed)) {
              finish(new Error('This address did not respond as a Triboon server.'));
              return;
            }
            finish(null, parsed);
          } catch {
            finish(new Error('Invalid response from server.'));
          }
        };
        xhr.onerror = function () {
          finish(new Error('Could not connect to ' + origin + '. Check the address and network connection.'));
        };
        xhr.ontimeout = function () {
          finish(new Error('Connection timed out reaching ' + origin + '.'));
        };
        xhr.send();
      } catch (e) {
        finish(new Error((e && e.message) || 'Could not reach server.'));
      }
    });
  }

  function connectTo(rawUrl) {
    if (busy) return;
    const origin = helpers.normalizeServerUrl(rawUrl);
    if (!origin) {
      setStatus('Enter a valid http:// or https:// server address (e.g. http://192.168.1.50:7777).', 'err');
      input.focus();
      return;
    }
    activeOrigin = origin;
    setBusy(true);
    setStatus('Connecting to ' + origin + '…', '');
    probeServer(origin)
      .then((info) => {
        saveServer(origin);
        const launch = helpers.buildServerLaunchUrl(origin);
        setStatus('Connected to Triboon ' + (info.version || '') + '. Opening…', 'ok');
        window.location.assign(launch);
      })
      .catch((err) => {
        setBusy(false);
        retryBtn.hidden = false;
        setStatus((err && err.message) || 'Could not connect to server.', 'err');
        retryBtn.focus();
      });
  }

  registerSamsungKeys();

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    connectTo(input.value);
  });

  retryBtn.addEventListener('click', () => {
    connectTo(activeOrigin || input.value);
  });

  // Samsung TV Smart Remote D-pad navigation + Return key (keyCode 10009) exit compliance.
  document.addEventListener('keydown', (e) => {
    const code = e.keyCode || e.which;
    if (code === 10009 || e.key === 'XF86Back' || e.key === 'GoBack' || e.key === 'Escape') {
      e.preventDefault();
      exitTizenApp();
      return;
    }
    const focusables = [input, connectBtn].concat(retryBtn.hidden ? [] : [retryBtn]);
    const idx = focusables.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' || code === 40) {
      e.preventDefault();
      focusables[Math.min(focusables.length - 1, idx < 0 ? 0 : idx + 1)].focus();
    } else if (e.key === 'ArrowUp' || code === 38) {
      e.preventDefault();
      focusables[Math.max(0, idx < 0 ? 0 : idx - 1)].focus();
    }
  });

  const params = new URLSearchParams(window.location.search || '');
  const forceChange = params.get('change') === '1';
  const saved = getSavedServer();
  if (saved) {
    input.value = saved;
    savedUrlEl.textContent = saved;
    savedRow.hidden = false;
    if (!forceChange) {
      connectTo(saved);
      return;
    }
    setStatus('Enter a new Triboon server address or press Connect to retry.', '');
  }
  input.focus();
})();
