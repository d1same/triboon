'use strict';
// Opt-in server debug lines. Off by default so Unraid / Windows service logs stay quiet.
// Enable with TRIBOON_DEBUG=1 or Settings → Engine → Debug logging.
// Never log tokens, passwords, or API keys — redact() strips the usual query/assignment forms.

let settingsProbe = null;

function bindSettings(fn) { settingsProbe = typeof fn === 'function' ? fn : null; }

function envForced() {
  return /^(1|true|yes|on)$/i.test(String(process.env.TRIBOON_DEBUG || '').trim());
}

function enabled() {
  if (envForced()) return true;
  try { return !!(settingsProbe && settingsProbe().debugLogging); } catch { return false; }
}

function redact(msg) {
  return String(msg == null ? '' : msg)
    .replace(/([?&](?:t|token|access_token|api_key)=)[^&\s]+/gi, '$1***')
    .replace(/(Token=")[^"]+/gi, '$1***')
    .replace(/((?:pass|password|apikey|api[_-]?key|secret|osApiKey)\s*[:=]\s*)[^\s,]+/gi, '$1***');
}

function tagOf(scope) {
  return String(scope || 'server').replace(/[^\w:-]/g, '').slice(0, 24) || 'server';
}

function log(scope, msg) {
  if (!enabled()) return;
  console.log(`[debug:${tagOf(scope)}] ${redact(msg)}`);
}

// Failures are always written. Debug stays off so a quiet box does not fill
// Unraid with play-by-play lines. The same failure is written once a minute.
const failSeen = new Map();
const FAIL_REPEAT_MS = 60000;

function fail(scope, msg) {
  const text = redact(msg).replace(/\s+/g, ' ').trim().slice(0, 400);
  if (!text) return;
  const tag = tagOf(scope);
  const key = `${tag}|${text}`;
  const now = Date.now();
  const prev = failSeen.get(key);
  if (prev && now - prev.at < FAIL_REPEAT_MS) {
    prev.n += 1;
    return;
  }
  if (failSeen.size > 200) {
    const oldest = failSeen.keys().next().value;
    if (oldest !== undefined) failSeen.delete(oldest);
  }
  const extra = prev && prev.n > 1 ? ` (same failure ${prev.n - 1} more times)` : '';
  failSeen.set(key, { at: now, n: 1 });
  try { console.error(`[fail:${tag}] ${text}${extra}`); } catch {}
}

module.exports = { bindSettings, envForced, enabled, log, fail, redact };
