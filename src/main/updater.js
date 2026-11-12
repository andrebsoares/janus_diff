'use strict';
// Update check and download against the project's GitHub releases, kept free
// of Electron so it can be unit tested (fetch is passed in).
const crypto = require('crypto');
const fs = require('fs');

// Where releases are published. A copy of build.publish in package.json (a
// test keeps them equal): electron-builder strips the "build" field from the
// package.json it packages, so the app cannot read it at run time.
const PUBLISH = { provider: 'github', owner: 'andrebsoares', repo: 'janus_diff' };

function releaseApiUrl(publish) {
  return `https://api.github.com/repos/${publish.owner}/${publish.repo}/releases/latest`;
}

// "1.2.3" style versions, with an optional "v" and "-pre.1" suffix. A version
// with a pre-release suffix sorts before the same version without one.
function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(v || '').trim());
  if (!m) return null;
  return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : [] };
}

// Negative when a < b, positive when a > b, 0 when equal or not comparable.
function compareVersions(a, b) {
  const x = parseVersion(a), y = parseVersion(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) if (x.nums[i] !== y.nums[i]) return x.nums[i] - y.nums[i];
  if (!x.pre.length || !y.pre.length) return y.pre.length - x.pre.length;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i], q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p), qn = /^\d+$/.test(q);
    if (pn && qn && Number(p) !== Number(q)) return Number(p) - Number(q);
    if (pn !== qn) return pn ? -1 : 1;
    if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}

// How this copy of the app was installed, which decides what an update
// downloads: 'installer' (NSIS setup), 'portable' (the single executable,
// whose launcher sets PORTABLE_EXECUTABLE_FILE) or 'none' (running from
// source or on another platform: only the release page is offered).
function installKind({ packaged, platform, env }) {
  if (!packaged || platform !== 'win32') return 'none';
  return env.PORTABLE_EXECUTABLE_FILE ? 'portable' : 'installer';
}

// The release file for an install kind: "Janus.Diff.Setup.X.exe" for the
// installer, "Janus.Diff.X.exe" for the portable version.
function pickAsset(assets, kind) {
  const exes = (assets || []).filter((a) => /\.exe$/i.test(a.name));
  const setup = (a) => /setup/i.test(a.name);
  if (kind === 'installer') return exes.find(setup) || null;
  if (kind === 'portable') return exes.find((a) => !setup(a)) || null;
  return null;
}

// What the renderer needs to know about the latest release.
function updateInfo(release, current, kind) {
  const version = String(release.tag_name || '').replace(/^v/, '');
  const asset = pickAsset(release.assets, kind);
  const digest = asset && /^sha256:([0-9a-f]{64})$/i.exec(asset.digest || '');
  return {
    current,
    version,
    available: compareVersions(version, current) > 0,
    notes: release.body || '',
    page: release.html_url || '',
    published: release.published_at || '',
    kind,
    asset: asset ? { name: asset.name, url: asset.browser_download_url, size: asset.size, sha256: digest ? digest[1].toLowerCase() : null } : null,
  };
}

async function checkLatest(fetch, publish, current, kind) {
  const res = await fetch(releaseApiUrl(publish), { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Janus-Diff' } });
  // GitHub also answers 404 for a private repository.
  if (res.status === 404) throw new Error(`No public release was found at github.com/${publish.owner}/${publish.repo}.`);
  if (!res.ok) throw new Error(`The update server answered ${res.status} ${res.statusText || ''}`.trim());
  return updateInfo(await res.json(), current, kind);
}

// Downloads asset.url into dest, reporting { received, total } as it goes,
// and checks its size and SHA-256 before keeping it. signal: { cancelled }.
async function download(fetch, asset, dest, onProgress, signal) {
  const res = await fetch(asset.url, { headers: { 'User-Agent': 'Janus-Diff' } });
  if (!res.ok || !res.body) throw new Error(`Download failed: ${res.status} ${res.statusText || ''}`.trim());
  const total = Number(res.headers.get('content-length')) || asset.size || 0;
  const part = dest + '.part';
  const hash = crypto.createHash('sha256');
  const out = fs.createWriteStream(part);
  let received = 0;
  try {
    const reader = res.body.getReader();
    for (;;) {
      if (signal && signal.cancelled) throw new Error('Download cancelled');
      const { done, value } = await reader.read();
      if (done) break;
      hash.update(value);
      received += value.length;
      if (!out.write(value)) await new Promise((resolve) => out.once('drain', resolve));
      if (onProgress) onProgress({ received, total });
    }
    await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
    if (asset.size && received !== asset.size) throw new Error(`Download incomplete: ${received} of ${asset.size} bytes`);
    if (asset.sha256 && hash.digest('hex') !== asset.sha256) throw new Error('The downloaded file does not match its published checksum');
    await fs.promises.rename(part, dest);
  } catch (err) {
    out.destroy();
    await fs.promises.rm(part, { force: true });
    throw err;
  }
  return dest;
}

module.exports = { PUBLISH, releaseApiUrl, parseVersion, compareVersions, installKind, pickAsset, updateInfo, checkLatest, download };
