#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const DEVCENTER_RESOURCE = 'https://manage.devcenter.microsoft.com';
const API_BASE = `${DEVCENTER_RESOURCE}/v1.0/my/applications`;

const ACTIVE_CERT_STATES = new Set([
  'CommitStarted',
  'CommitFailed',
  'PreProcessing',
  'Certification',
  'Release',
  'Publishing',
  'Published',
]);

function isActiveCertificationState(status) {
  return ACTIVE_CERT_STATES.has(String(status || '').trim());
}

function buildTokenParams({ clientId, clientSecret, resource = DEVCENTER_RESOURCE }) {
  if (!clientId || !clientSecret) {
    throw new Error('MS_STORE_CLIENT_ID and MS_STORE_CLIENT_SECRET are required');
  }
  return new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
    resource,
  });
}

function prepareSubmissionPayload(submission, msixFileName) {
  const clone = JSON.parse(JSON.stringify(submission || {}));
  const existing = Array.isArray(clone.applicationPackages) ? clone.applicationPackages : [];
  const nextPackages = existing.map((pkg) => ({
    ...pkg,
    fileStatus: 'PendingDelete',
  }));
  nextPackages.push({
    fileName: msixFileName,
    fileStatus: 'PendingUpload',
  });
  clone.applicationPackages = nextPackages;
  return clone;
}

function parseArgs(argv) {
  const out = {
    appId: process.env.MS_STORE_APP_ID || '9N12LTV21B88',
    tenantId: process.env.MS_STORE_TENANT_ID || '',
    clientId: process.env.MS_STORE_CLIENT_ID || '',
    clientSecret: process.env.MS_STORE_CLIENT_SECRET || '',
    msixPath: '',
    commit: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i] || '';
    if (a === '--app-id') out.appId = next();
    else if (a === '--tenant-id') out.tenantId = next();
    else if (a === '--client-id') out.clientId = next();
    else if (a === '--client-secret') out.clientSecret = next();
    else if (a === '--msix') out.msixPath = next();
    else if (a === '--draft-only') out.commit = false;
  }
  return out;
}

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, opts);
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  return { ok: res.ok, status: res.status, text, json };
}

async function getAccessToken({ tenantId, clientId, clientSecret }) {
  if (!tenantId) throw new Error('MS_STORE_TENANT_ID is required');
  const url = `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/token`;
  const res = await fetchJson(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: buildTokenParams({ clientId, clientSecret }).toString(),
  });
  if (!res.ok || !res.json || !res.json.access_token) {
    throw new Error(`Microsoft Entra token exchange failed (${res.status}): ${res.text}`);
  }
  return res.json.access_token;
}

function createSubmissionZip(msixPath) {
  const absMsix = path.resolve(msixPath);
  const dir = path.dirname(absMsix);
  const base = path.basename(absMsix);
  const zipPath = path.join(dir, `${base}.submission.zip`);
  if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
  if (process.platform === 'win32') {
    execFileSync('pwsh', [
      '-NoProfile',
      '-Command',
      `Compress-Archive -LiteralPath '${absMsix.replace(/'/g, "''")}' -DestinationPath '${zipPath.replace(/'/g, "''")}' -Force`,
    ], { stdio: 'inherit' });
  } else {
    execFileSync('zip', ['-j', zipPath, absMsix], { stdio: 'inherit' });
  }
  if (!fs.existsSync(zipPath)) throw new Error(`Failed to create submission zip: ${zipPath}`);
  return zipPath;
}

async function publishMsix(opts) {
  if (!opts.msixPath || !fs.existsSync(opts.msixPath)) {
    throw new Error(`MSIX file not found: ${opts.msixPath}`);
  }
  const appId = encodeURIComponent(opts.appId);
  const msixName = path.basename(opts.msixPath);

  console.log(`Authenticating with Microsoft Entra tenant ${opts.tenantId} for Store app ${opts.appId}...`);
  const token = await getAccessToken(opts);
  const authHeader = { Authorization: `Bearer ${token}` };

  // 1. Inspect current app state & pending submission
  const appRes = await fetchJson(`${API_BASE}/${appId}`, { headers: authHeader });
  if (!appRes.ok || !appRes.json) {
    throw new Error(`Fetch Microsoft Store app failed (${appRes.status}): ${appRes.text}`);
  }
  const pending = appRes.json.pendingApplicationSubmission;
  if (pending && pending.id) {
    const pendSub = await fetchJson(`${API_BASE}/${appId}/submissions/${pending.id}`, { headers: authHeader });
    const st = pendSub.json && pendSub.json.status;
    if (isActiveCertificationState(st)) {
      console.log(`::notice::Microsoft Store submission ${pending.id} is currently in "${st}". Microsoft only allows one active submission at a time; skipping upload until certification finishes.`);
      return { skipped: true, reason: st, submissionId: pending.id };
    }
    console.log(`Deleting existing draft submission ${pending.id} (status=${st || 'PendingCommit'}) before creating fresh clone...`);
    const delRes = await fetchJson(`${API_BASE}/${appId}/submissions/${pending.id}`, {
      method: 'DELETE',
      headers: authHeader,
    });
    if (!delRes.ok) {
      throw new Error(`Delete draft submission ${pending.id} failed (${delRes.status}): ${delRes.text}`);
    }
  }

  // 2. Create new submission cloned from the latest published submission
  const createRes = await fetchJson(`${API_BASE}/${appId}/submissions`, {
    method: 'POST',
    headers: { ...authHeader, 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (!createRes.ok || !createRes.json || !createRes.json.id) {
    throw new Error(`Create Microsoft Store submission failed (${createRes.status}): ${createRes.text}`);
  }
  const sub = createRes.json;
  const subId = sub.id;
  const uploadUrl = sub.fileUploadUrl;
  if (!uploadUrl) {
    throw new Error(`Submission ${subId} did not return a fileUploadUrl`);
  }
  console.log(`Created Partner Center submission ${subId}`);

  // 3. Update submission metadata to replace previous MSIX packages with the new one
  const updatedPayload = prepareSubmissionPayload(sub, msixName);
  const putRes = await fetchJson(`${API_BASE}/${appId}/submissions/${subId}`, {
    method: 'PUT',
    headers: { ...authHeader, 'Content-Type': 'application/json' },
    body: JSON.stringify(updatedPayload),
  });
  if (!putRes.ok) {
    throw new Error(`Update submission ${subId} failed (${putRes.status}): ${putRes.text}`);
  }

  // 4. Zip MSIX and upload to Azure Blob SAS URL
  const zipPath = createSubmissionZip(opts.msixPath);
  try {
    const zipBytes = fs.readFileSync(zipPath);
    console.log(`Uploading ${msixName} zip (${(zipBytes.length / 1024 / 1024).toFixed(2)} MB) to Partner Center blob storage...`);
    const blobRes = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'x-ms-blob-type': 'BlockBlob',
        'Content-Type': 'application/zip',
      },
      body: zipBytes,
    });
    if (!blobRes.ok) {
      throw new Error(`Azure Blob upload failed (${blobRes.status}): ${await blobRes.text()}`);
    }
  } finally {
    if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
  }

  // 5. Commit submission for certification
  if (opts.commit) {
    const commitRes = await fetchJson(`${API_BASE}/${appId}/submissions/${subId}/commit`, {
      method: 'POST',
      headers: authHeader,
    });
    if (!commitRes.ok) {
      throw new Error(`Commit submission ${subId} failed (${commitRes.status}): ${commitRes.text}`);
    }
    console.log(`Committed Microsoft Store submission ${subId} (${msixName}) for certification!`);
  } else {
    console.log(`Saved Microsoft Store draft submission ${subId} (${msixName}) without committing.`);
  }
  return { skipped: false, submissionId: subId, msixName, committed: opts.commit };
}

if (require.main === module) {
  publishMsix(parseArgs(process.argv.slice(2))).catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}

module.exports = {
  DEVCENTER_RESOURCE,
  isActiveCertificationState,
  buildTokenParams,
  prepareSubmissionPayload,
  parseArgs,
  publishMsix,
};
