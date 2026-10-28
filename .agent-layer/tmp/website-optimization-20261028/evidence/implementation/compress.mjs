import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const root = '/home/nicholasjconn/git-repos/conn-castle/agent-outbox/.agent-layer/tmp/website-optimization-20261028/worktree';
const artifacts = path.resolve(root, '../implementation');
const require = createRequire(path.join(root, 'package.json'));
const sharp = require('sharp');
sharp.concurrency(1);
const digest = data => createHash('sha256').update(data).digest('hex');
const baselineManifestBytes = execFileSync('git', ['show', 'HEAD:marketing/screenshots.json'], { cwd: root });
writeFileSync(path.join(artifacts, 'baseline/screenshots.json'), baselineManifestBytes, { flag: 'wx' });
const manifest = JSON.parse(baselineManifestBytes);
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
assert.equal(head, 'e0aebb42f05004babdeb60b07ca2cb356f66cb6b');
const chunks = bytes => {
  const result = [];
  for (let offset = 8; offset < bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    result.push({ type, length, dataSha256: digest(bytes.subarray(offset + 8, offset + 8 + length)) });
    offset += 12 + length;
  }
  return result;
};
const report = { head, versions: sharp.versions, results: [] };
for (const asset of manifest.assets) {
  const basename = path.basename(asset.file);
  const baseline = execFileSync('git', ['show', `HEAD:${asset.file}`], { cwd: root, maxBuffer: 10 * 1024 * 1024 });
  assert.equal(digest(baseline), asset.sha256);
  assert.ok(baseline.equals(readFileSync(path.join(root, asset.file))), `${asset.file} already modified`);
  writeFileSync(path.join(artifacts, 'baseline', basename), baseline, { flag: 'wx' });
  const original = await sharp(baseline).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(original.info.width, asset.width);
  assert.equal(original.info.height, asset.height);
  assert.equal(original.info.channels, 4);
  writeFileSync(path.join(artifacts, 'raw', `${basename}.baseline.rgba`), original.data);
  const metadata = await sharp(baseline).metadata();
  const result = { file: asset.file, baselineBytes: baseline.length, baselineSha256: digest(baseline), baselineChunks: chunks(baseline), metadata, rgbaSha256: digest(original.data), trials: [] };
  for (const adaptiveFiltering of [false, true]) {
    const options = { compressionLevel: 9, adaptiveFiltering, palette: false };
    const candidate = await sharp(baseline).png(options).toBuffer();
    const candidateName = `${basename}.level9-filter-${adaptiveFiltering}.png`;
    writeFileSync(path.join(artifacts, 'candidates', candidateName), candidate);
    const decoded = await sharp(candidate).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    assert.equal(decoded.info.width, original.info.width);
    assert.equal(decoded.info.height, original.info.height);
    assert.equal(decoded.info.channels, 4);
    assert.ok(original.data.equals(decoded.data), `${candidateName} changed RGBA`);
    result.trials.push({ candidateName, options, bytes: candidate.length, sha256: digest(candidate), rgbaSha256: digest(decoded.data), exactRgbaIdentity: true, chunks: chunks(candidate) });
  }
  report.results.push(result);
}
writeFileSync(path.join(artifacts, 'compression-trials.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
