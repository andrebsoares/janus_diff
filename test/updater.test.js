'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const U = require('../src/main/updater');

const PUBLISH = { provider: 'github', owner: 'someone', repo: 'janus_diff' };

const RELEASE = {
  tag_name: 'v0.4.0',
  body: '## What is new\n* Faster',
  html_url: 'https://github.com/someone/janus_diff/releases/tag/v0.4.0',
  published_at: '2026-11-20T10:00:00Z',
  assets: [
    { name: 'Janus.Diff.0.4.0.exe', size: 10, digest: 'sha256:' + 'a'.repeat(64), browser_download_url: 'https://example/portable.exe' },
    { name: 'Janus.Diff.Setup.0.4.0.exe', size: 20, digest: 'sha256:' + 'B'.repeat(64), browser_download_url: 'https://example/setup.exe' },
    { name: 'Janus.Diff.Setup.0.4.0.exe.blockmap', size: 1, browser_download_url: 'https://example/setup.exe.blockmap' },
    { name: 'latest.yml', size: 1, browser_download_url: 'https://example/latest.yml' },
  ],
};

test('compareVersions orders release and pre-release versions', () => {
  assert.ok(U.compareVersions('0.4.0', '0.3.0') > 0);
  assert.ok(U.compareVersions('v0.3.0', '0.3.1') < 0);
  assert.ok(U.compareVersions('1.0.0', '0.99.99') > 0);
  assert.ok(U.compareVersions('0.10.0', '0.9.0') > 0);
  assert.strictEqual(U.compareVersions('v1.2.3', '1.2.3'), 0);
  assert.ok(U.compareVersions('1.0.0-beta.1', '1.0.0') < 0);
  assert.ok(U.compareVersions('1.0.0', '1.0.0-beta.1') > 0);
  assert.ok(U.compareVersions('1.0.0-beta.2', '1.0.0-beta.10') < 0);
  assert.ok(U.compareVersions('1.0.0-alpha', '1.0.0-beta') < 0);
  assert.ok(U.compareVersions('1.0.0-beta', '1.0.0-beta.1') < 0);
  assert.strictEqual(U.compareVersions('nightly', '1.0.0'), 0);
});

test('installKind tells installer, portable and source copies apart', () => {
  assert.strictEqual(U.installKind({ packaged: true, platform: 'win32', env: {} }), 'installer');
  assert.strictEqual(U.installKind({ packaged: true, platform: 'win32', env: { PORTABLE_EXECUTABLE_FILE: 'D:\\Tools\\Janus.Diff.0.3.0.exe' } }), 'portable');
  assert.strictEqual(U.installKind({ packaged: false, platform: 'win32', env: {} }), 'none');
  assert.strictEqual(U.installKind({ packaged: true, platform: 'linux', env: {} }), 'none');
});

test('pickAsset chooses the setup or the portable executable', () => {
  assert.strictEqual(U.pickAsset(RELEASE.assets, 'installer').name, 'Janus.Diff.Setup.0.4.0.exe');
  assert.strictEqual(U.pickAsset(RELEASE.assets, 'portable').name, 'Janus.Diff.0.4.0.exe');
  assert.strictEqual(U.pickAsset(RELEASE.assets, 'none'), null);
  assert.strictEqual(U.pickAsset([], 'installer'), null);
});

test('updateInfo reports a newer release with its file and checksum', () => {
  const info = U.updateInfo(RELEASE, '0.3.0', 'installer');
  assert.strictEqual(info.available, true);
  assert.strictEqual(info.version, '0.4.0');
  assert.strictEqual(info.current, '0.3.0');
  assert.strictEqual(info.page, RELEASE.html_url);
  assert.deepStrictEqual(info.asset, { name: 'Janus.Diff.Setup.0.4.0.exe', url: 'https://example/setup.exe', size: 20, sha256: 'b'.repeat(64) });
  assert.strictEqual(U.updateInfo(RELEASE, '0.4.0', 'installer').available, false);
  assert.strictEqual(U.updateInfo(RELEASE, '0.5.0', 'installer').available, false);
  const noDigest = U.updateInfo({ ...RELEASE, assets: [{ ...RELEASE.assets[0], digest: undefined }] }, '0.3.0', 'portable');
  assert.strictEqual(noDigest.asset.sha256, null);
  assert.strictEqual(U.updateInfo(RELEASE, '0.3.0', 'none').asset, null);
});

test('checkLatest asks GitHub for the latest release', async () => {
  let asked;
  const fetch = async (url, opts) => {
    asked = { url, opts };
    return new Response(JSON.stringify(RELEASE), { status: 200 });
  };
  const info = await U.checkLatest(fetch, PUBLISH, '0.3.0', 'portable');
  assert.strictEqual(asked.url, 'https://api.github.com/repos/someone/janus_diff/releases/latest');
  assert.ok(asked.opts.headers['User-Agent']);
  assert.strictEqual(info.asset.name, 'Janus.Diff.0.4.0.exe');

  await assert.rejects(U.checkLatest(async () => new Response('{}', { status: 404 }), PUBLISH, '0.3.0', 'portable'), /No public release/);
  await assert.rejects(U.checkLatest(async () => new Response('{}', { status: 403, statusText: 'Forbidden' }), PUBLISH, '0.3.0', 'portable'), /403 Forbidden/);
});

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jd-update-'));
}

// A response whose body arrives in a few chunks, like a real download.
function chunked(data) {
  const parts = [data.subarray(0, 3), data.subarray(3, 7), data.subarray(7)];
  const body = new ReadableStream({
    start(c) {
      for (const p of parts) c.enqueue(new Uint8Array(p));
      c.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-length': String(data.length) } });
}

test('download saves the file after checking size and checksum', async () => {
  const dir = tmpDir();
  const data = Buffer.from('new version of the app');
  const asset = { url: 'https://example/x.exe', size: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex') };
  const progress = [];
  const dest = path.join(dir, 'x.exe');
  assert.strictEqual(await U.download(async () => chunked(data), asset, dest, (p) => progress.push(p)), dest);
  assert.deepStrictEqual(fs.readFileSync(dest), data);
  assert.ok(progress.length >= 2);
  assert.deepStrictEqual(progress[progress.length - 1], { received: data.length, total: data.length });
  assert.deepStrictEqual(fs.readdirSync(dir), ['x.exe']);
});

test('download keeps nothing when the checksum or size is wrong', async () => {
  const dir = tmpDir();
  const data = Buffer.from('tampered contents');
  const dest = path.join(dir, 'x.exe');
  await assert.rejects(U.download(async () => chunked(data), { url: 'u', size: data.length, sha256: '0'.repeat(64) }, dest), /checksum/);
  await assert.rejects(U.download(async () => chunked(data), { url: 'u', size: data.length + 5, sha256: null }, dest), /incomplete/);
  await assert.rejects(U.download(async () => new Response('', { status: 500 }), { url: 'u', size: 1 }, dest), /Download failed/);
  assert.deepStrictEqual(fs.readdirSync(dir), []);
});

test('download stops when cancelled', async () => {
  const dir = tmpDir();
  const signal = { cancelled: false };
  const data = Buffer.from('0123456789abcdef');
  const p = U.download(async () => chunked(data), { url: 'u', size: data.length }, path.join(dir, 'x.exe'), () => { signal.cancelled = true; }, signal);
  await assert.rejects(p, /cancelled/);
  assert.deepStrictEqual(fs.readdirSync(dir), []);
});
