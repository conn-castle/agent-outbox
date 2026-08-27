import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import sharp from "sharp";

import {
  comparePng,
  DEFAULT_THRESHOLDS,
  describeSummary
} from "../scripts/marketing-asset-gate.mjs";

/**
 * @param {string} file
 * @param {number} width
 * @param {number} height
 * @param {(data: Buffer, width: number, height: number) => void} [mutate]
 */
async function writePng(file, width, height, mutate) {
  const data = Buffer.alloc(width * height * 4, 0);
  for (let index = 3; index < data.length; index += 4) {
    data[index] = 255;
  }
  mutate?.(data, width, height);
  await sharp(data, { raw: { width, height, channels: 4 } })
    .png()
    .toFile(file);
}

/** @param {(directory: string) => Promise<void>} callback */
async function withTempDir(callback) {
  const directory = await mkdtemp(
    path.join(process.env.TMPDIR ?? "/tmp", "marketing-asset-gate-")
  );
  try {
    await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("classifies identical PNGs as unchanged", async () => {
  await withTempDir(async (directory) => {
    const baseline = path.join(directory, "baseline.png");
    const candidate = path.join(directory, "candidate.png");
    await writePng(baseline, 8, 8);
    await writePng(candidate, 8, 8);

    const result = await comparePng(baseline, candidate, DEFAULT_THRESHOLDS);

    assert.equal(result.verdict, "identical");
  });
});

test("discards a small pixel difference within tolerance", async () => {
  await withTempDir(async (directory) => {
    const baseline = path.join(directory, "baseline.png");
    const candidate = path.join(directory, "candidate.png");
    await writePng(baseline, 100, 100);
    await writePng(candidate, 100, 100, (data) => {
      data[0] = 1;
    });

    const result = await comparePng(baseline, candidate, DEFAULT_THRESHOLDS);

    assert.equal(result.verdict, "within-threshold");
    assert.equal(
      describeSummary(result.summary),
      "1px / 10000 (0.0100%), maxΔ=1"
    );
  });
});

test("retains a broad or high-contrast difference for review", async () => {
  await withTempDir(async (directory) => {
    const baseline = path.join(directory, "baseline.png");
    const candidate = path.join(directory, "candidate.png");
    const overlay = path.join(directory, "candidate.diff.png");
    await writePng(baseline, 100, 100);
    await writePng(candidate, 100, 100, (data) => {
      for (let pixel = 0; pixel < 30; pixel += 1) {
        data[pixel * 4] = 1;
      }
    });

    const result = await comparePng(baseline, candidate, DEFAULT_THRESHOLDS, {
      writeOverlayTo: overlay
    });

    assert.equal(result.verdict, "above-threshold");
    assert.equal(result.summary.differingPixels, 30);
    assert.ok((await readFile(overlay)).length > 0);
  });
});

test("treats a changed image size as substantive", async () => {
  await withTempDir(async (directory) => {
    const baseline = path.join(directory, "baseline.png");
    const candidate = path.join(directory, "candidate.png");
    await writePng(baseline, 4, 4);
    await writePng(candidate, 5, 5);

    const result = await comparePng(baseline, candidate, DEFAULT_THRESHOLDS);

    assert.equal(result.verdict, "size-mismatch");
  });
});
