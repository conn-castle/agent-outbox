import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = '/home/nicholasjconn/git-repos/conn-castle/agent-outbox/.agent-layer/tmp/website-optimization-20261028/worktree';
const artifacts = path.resolve(root, '../implementation');
const require = createRequire(path.join(root, 'package.json'));
const sharp = require('sharp');
sharp.concurrency(1);
const { comparePng } = await import(pathToFileURL(path.join(root, 'scripts/marketing-asset-gate.mjs')));
const digest = data => createHash('sha256').update(data).digest('hex');
function chunks(bytes) {
  const result = [];
  assert.ok(bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));
  for (let offset = 8; offset < bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    const end = offset + 12 + length;
    assert.ok(end <= bytes.length);
    result.push({ type: bytes.toString('ascii', offset + 4, offset + 8), bytes: bytes.subarray(offset, end) });
    offset = end;
  }
  return result;
}
const manifest = JSON.parse(readFileSync(path.join(artifacts, 'baseline/screenshots.json')));
const trials = JSON.parse(readFileSync(path.join(artifacts, 'compression-trials.json')));
const results = [];
for (const asset of manifest.assets) {
  const basename = path.basename(asset.file);
  const before = readFileSync(path.join(artifacts, 'baseline', basename));
  assert.ok(before.equals(execFileSync('git', ['show', `HEAD:${asset.file}`], { cwd: root, maxBuffer: 10 * 1024 * 1024 })));
  assert.ok(before.equals(readFileSync(path.join(root, asset.file))), `${asset.file} changed while preparing`);
  const originalChunks = chunks(before);
  // Chromium originals contain no color, density, animation or other metadata.
  // Keep that property; sharp adds pHYs=72dpi, which is unnecessary here.
  assert.ok(originalChunks.every(c => ['IHDR', 'IDAT', 'IEND'].includes(c.type)));
  const trial = trials.results.find(r => r.file === asset.file).trials.toSorted((a, b) => a.bytes - b.bytes)[0];
  const encoded = readFileSync(path.join(artifacts, 'candidates', trial.candidateName));
  assert.equal(digest(encoded), trial.sha256);
  const encodedChunks = chunks(encoded);
  assert.ok(encodedChunks.every(c => ['IHDR', 'IDAT', 'IEND', 'pHYs'].includes(c.type)));
  const finalChunks = encodedChunks.filter(c => c.type !== 'pHYs');
  assert.ok(finalChunks[0].bytes.equals(originalChunks[0].bytes));
  const after = Buffer.concat([before.subarray(0, 8), ...finalChunks.map(c => c.bytes)]);
  assert.ok(after.length < before.length);
  const original = await sharp(before).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const decoded = await sharp(after).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(decoded.info.width, asset.width);
  assert.equal(decoded.info.height, asset.height);
  assert.equal(decoded.info.channels, 4);
  assert.ok(original.data.equals(decoded.data));
  writeFileSync(path.join(artifacts, 'raw', `${basename}.optimized.rgba`), decoded.data);
  writeFileSync(path.join(root, asset.file), after);
  asset.sha256 = digest(after);
  const comparison = await comparePng(path.join(artifacts, 'baseline', basename), path.join(root, asset.file), { maxChannelDelta: 0, maxDiffRatio: 0 });
  assert.equal(comparison.verdict, 'identical');
  results.push({ file: asset.file, options: trial.options, beforeBytes: before.length, afterBytes: after.length, savedBytes: before.length - after.length, savedPercent: 100 * (1 - after.length / before.length), beforeSha256: digest(before), afterSha256: digest(after), rgbaSha256: digest(decoded.data), ihdrBytesIdentical: true, ancillaryChunksBefore: [], ancillaryChunksAfter: [], comparison });
}
writeFileSync(path.join(root, 'marketing/screenshots.json'), JSON.stringify(manifest, null, 2) + '\n');
const beforeBytes = results.reduce((sum, r) => sum + r.beforeBytes, 0);
const afterBytes = results.reduce((sum, r) => sum + r.afterBytes, 0);
const report = { results, totals: { beforeBytes, afterBytes, savedBytes: beforeBytes - afterBytes, savedPercent: 100 * (1 - afterBytes / beforeBytes) } };
writeFileSync(path.join(artifacts, 'verification.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
