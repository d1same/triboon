#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const PLAY_SCOPE = 'https://www.googleapis.com/auth/androidpublisher';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API_BASE = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications';
const UPLOAD_BASE = 'https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications';

function base64Url(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'utf8');
  return buf.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function parseServiceAccountJson(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) throw new Error('GOOGLE_PLAY_SERVICE_ACCOUNT_JSON is empty');
  let jsonStr = trimmed;
  if (!trimmed.startsWith('{')) {
    jsonStr = Buffer.from(trimmed.replace(/\s+/g, ''), 'base64').toString('utf8').trim();
  }
  const parsed = JSON.parse(jsonStr);
  if (!parsed.client_email || !parsed.private_key) {
    throw new Error('Service account JSON must contain client_email and private_key');
  }
  return parsed;
}

function buildJwtAssertion(sa, nowSeconds = Math.floor(Date.now() / 1000)) {
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64Url(JSON.stringify({
    iss: sa.client_email,
    scope: PLAY_SCOPE,
    aud: sa.token_uri || TOKEN_URL,
    iat: nowSeconds,
    exp: nowSeconds + 3600,
  }));
  const signingInput = `${header}.${payload}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();
  const signature = base64Url(signer.sign(sa.private_key));
  return `${signingInput}.${signature}`;
}

function isDraftAppError(statusCode, bodyText) {
  if (statusCode !== 400 && statusCode !== 403) return false;
  const text = String(bodyText || '').toLowerCase();
  return text.includes('draft app') || text.includes('only releases with status draft');
}

function buildTrackReleaseBody({ track, versionCode, status, releaseName, notes }) {
  const release = {
    name: releaseName || String(versionCode),
    versionCodes: [String(versionCode)],
    status: status || 'completed',
  };
  if (notes) {
    release.releaseNotes = [{ language: 'en-US', text: String(notes).slice(0, 500) }];
  }
  return { track, releases: [release] };
}

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, opts);
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  return { ok: res.ok, status: res.status, text, json };
}

async function getAccessToken(sa) {
  const assertion = buildJwtAssertion(sa);
  const tokenUri = sa.token_uri || TOKEN_URL;
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion,
  });
  const res = await fetchJson(tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok || !res.json || !res.json.access_token) {
    throw new Error(`Google OAuth token exchange failed (${res.status}): ${res.text}`);
  }
  return res.json.access_token;
}

function parseArgs(argv) {
  const out = {
    packageName: 'app.triboon.tv',
    aabPath: '',
    track: 'internal',
    status: 'completed',
    releaseName: '',
    notes: '',
    keyFile: '',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i] || '';
    if (a === '--package') out.packageName = next();
    else if (a === '--aab') out.aabPath = next();
    else if (a === '--track') out.track = next();
    else if (a === '--status') out.status = next();
    else if (a === '--release-name') out.releaseName = next();
    else if (a === '--notes') out.notes = next();
    else if (a === '--key') out.keyFile = next();
  }
  return out;
}

async function publishAab(opts) {
  const rawKey = opts.keyFile
    ? fs.readFileSync(opts.keyFile, 'utf8')
    : process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON;
  const sa = parseServiceAccountJson(rawKey);
  if (!opts.aabPath || !fs.existsSync(opts.aabPath)) {
    throw new Error(`AAB file not found: ${opts.aabPath}`);
  }
  const aabBytes = fs.readFileSync(opts.aabPath);
  const pkg = encodeURIComponent(opts.packageName);

  console.log(`Authenticating as ${sa.client_email}...`);
  const token = await getAccessToken(sa);
  const authHeader = { Authorization: `Bearer ${token}` };

  // 1. Open edit
  const editRes = await fetchJson(`${API_BASE}/${pkg}/edits`, {
    method: 'POST',
    headers: { ...authHeader, 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (!editRes.ok || !editRes.json || !editRes.json.id) {
    throw new Error(`Create Play edit failed (${editRes.status}): ${editRes.text}`);
  }
  const editId = editRes.json.id;
  console.log(`Opened Play Console edit ${editId} for ${opts.packageName}`);

  // 2. Upload AAB bundle
  console.log(`Uploading ${path.basename(opts.aabPath)} (${(aabBytes.length / 1024 / 1024).toFixed(2)} MB)...`);
  const uploadRes = await fetchJson(`${UPLOAD_BASE}/${pkg}/edits/${editId}/bundles?uploadType=media`, {
    method: 'POST',
    headers: { ...authHeader, 'Content-Type': 'application/octet-stream' },
    body: aabBytes,
  });
  if (!uploadRes.ok || !uploadRes.json || !uploadRes.json.versionCode) {
    throw new Error(`Upload AAB failed (${uploadRes.status}): ${uploadRes.text}`);
  }
  const versionCode = uploadRes.json.versionCode;
  console.log(`Uploaded AAB versionCode=${versionCode}`);

  // 3. Assign bundle to track (auto-fallback to draft if Play Console app is still in Draft state)
  const track = encodeURIComponent(opts.track);
  let effectiveStatus = opts.status || 'completed';
  let trackRes = await fetchJson(`${API_BASE}/${pkg}/edits/${editId}/tracks/${track}`, {
    method: 'PUT',
    headers: { ...authHeader, 'Content-Type': 'application/json' },
    body: JSON.stringify(buildTrackReleaseBody({
      track: opts.track,
      versionCode,
      status: effectiveStatus,
      releaseName: opts.releaseName,
      notes: opts.notes,
    })),
  });
  if (!trackRes.ok && effectiveStatus !== 'draft' && isDraftAppError(trackRes.status, trackRes.text)) {
    console.log('App is still in Draft state on Google Play; retrying track release with status=draft...');
    effectiveStatus = 'draft';
    trackRes = await fetchJson(`${API_BASE}/${pkg}/edits/${editId}/tracks/${track}`, {
      method: 'PUT',
      headers: { ...authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify(buildTrackReleaseBody({
        track: opts.track,
        versionCode,
        status: effectiveStatus,
        releaseName: opts.releaseName,
        notes: opts.notes,
      })),
    });
  }
  if (!trackRes.ok) {
    throw new Error(`Update track "${opts.track}" failed (${trackRes.status}): ${trackRes.text}`);
  }

  // 4. Commit edit
  const commitRes = await fetchJson(`${API_BASE}/${pkg}/edits/${editId}:commit`, {
    method: 'POST',
    headers: authHeader,
  });
  if (!commitRes.ok) {
    throw new Error(`Commit Play edit failed (${commitRes.status}): ${commitRes.text}`);
  }

  console.log(`Published ${opts.packageName} versionCode=${versionCode} to track="${opts.track}" (status=${effectiveStatus})`);
  if (effectiveStatus === 'draft') {
    console.log('NOTE: Because this app is still a Draft app on Google Play, open Play Console -> Testing -> Internal testing to click "Start rollout" once, or submit a Closed testing release for review so future tags roll out live automatically.');
  }
  return { editId, versionCode, track: opts.track, status: effectiveStatus };
}

if (require.main === module) {
  publishAab(parseArgs(process.argv.slice(2))).catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}

module.exports = {
  base64Url,
  parseServiceAccountJson,
  buildJwtAssertion,
  isDraftAppError,
  buildTrackReleaseBody,
  parseArgs,
  publishAab,
};
