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
    .replace(/([?&](?:t|token|access_token)=)[^&\s]+/gi, '$1***')
    .replace(/((?:pass|password|apikey|api[_-]?key|secret|osApiKey)\s*[:=]\s*)[^\s,]+/gi, '$1***');
}

function log(scope, msg) {
  if (!enabled()) return;
  const tag = String(scope || 'server').replace(/[^\w:-]/g, '').slice(0, 24) || 'server';
  console.log(`[debug:${tag}] ${redact(msg)}`);
}

module.exports = { bindSettings, envForced, enabled, log, redact };
