import { stat } from "node:fs/promises";

import sharp from "sharp";

export const DEFAULT_THRESHOLDS = {
  // Small anti-aliasing and rasterizer drift is not a substantive product
  // change. These defaults leave headroom over the observed capture jitter.
  maxChannelDelta: 5,
  maxDiffRatio: 0.001
};

/** @typedef {{ width: number, height: number, totalPixels: number, differingPixels: number, diffRatio: number, maxChannelDelta: number, bbox: { x0: number, y0: number, x1: number, y1: number } | null }} DiffSummary */
/** @typedef {{ verdict: "identical", summary: DiffSummary } | { verdict: "within-threshold", summary: DiffSummary } | { verdict: "above-threshold", summary: DiffSummary } | { verdict: "size-mismatch", baseline: { width: number, height: number }, candidate: { width: number, height: number } } | { verdict: "missing-baseline" }} CompareResult */

/** @param {string} file */
async function fileExists(file) {
  try {
    const result = await stat(file);
    return result.isFile();
  } catch {
    return false;
  }
}

/** @param {string} file */
async function loadRaw(file) {
  const { data, info } = await sharp(file)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    data,
    width: info.width,
    height: info.height,
    channels: info.channels
  };
}

/**
 * Compare decoded pixels instead of PNG bytes so insignificant encoding or
 * rasterizer drift does not create a release-file diff. A candidate is
 * substantive when either its largest channel delta or changed-pixel ratio
 * exceeds the supplied threshold.
 *
 * @param {string} baselinePath
 * @param {string} candidatePath
 * @param {{ maxChannelDelta: number, maxDiffRatio: number }} thresholds
 * @param {{ writeOverlayTo?: string }} [options]
 * @returns {Promise<CompareResult>}
 */
export async function comparePng(
  baselinePath,
  candidatePath,
  thresholds,
  options = {}
) {
  if (!(await fileExists(baselinePath))) {
    return { verdict: "missing-baseline" };
  }

  const [baseline, candidate] = await Promise.all([
    loadRaw(baselinePath),
    loadRaw(candidatePath)
  ]);

  if (
    baseline.width !== candidate.width ||
    baseline.height !== candidate.height
  ) {
    if (options.writeOverlayTo) {
      await sharp(candidatePath).png().toFile(options.writeOverlayTo);
    }
    return {
      verdict: "size-mismatch",
      baseline: { width: baseline.width, height: baseline.height },
      candidate: { width: candidate.width, height: candidate.height }
    };
  }

  const { width, height, channels, data: a } = baseline;
  const { data: b } = candidate;
  const totalPixels = width * height;
  let differingPixels = 0;
  let maxChannelDelta = 0;
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  const overlay = options.writeOverlayTo ? Buffer.alloc(totalPixels * 4) : null;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * channels;
      const pixelMax = Math.max(
        Math.abs(a[index] - b[index]),
        Math.abs(a[index + 1] - b[index + 1]),
        Math.abs(a[index + 2] - b[index + 2]),
        channels === 4 ? Math.abs(a[index + 3] - b[index + 3]) : 0
      );

      if (pixelMax > 0) {
        differingPixels += 1;
        maxChannelDelta = Math.max(maxChannelDelta, pixelMax);
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
        if (overlay) {
          const overlayIndex = (y * width + x) * 4;
          overlay[overlayIndex] = 255;
          overlay[overlayIndex + 1] = 0;
          overlay[overlayIndex + 2] = 0;
          overlay[overlayIndex + 3] = 255;
        }
      } else if (overlay) {
        const overlayIndex = (y * width + x) * 4;
        const gray = Math.round(
          0.299 * a[index] + 0.587 * a[index + 1] + 0.114 * a[index + 2]
        );
        overlay[overlayIndex] = gray;
        overlay[overlayIndex + 1] = gray;
        overlay[overlayIndex + 2] = gray;
        overlay[overlayIndex + 3] = 64;
      }
    }
  }

  const summary = {
    width,
    height,
    totalPixels,
    differingPixels,
    diffRatio: differingPixels / totalPixels,
    maxChannelDelta,
    bbox: differingPixels > 0 ? { x0, y0, x1, y1 } : null
  };

  if (differingPixels === 0) {
    return { verdict: "identical", summary };
  }

  const withinThreshold =
    maxChannelDelta <= thresholds.maxChannelDelta &&
    summary.diffRatio <= thresholds.maxDiffRatio;
  if (withinThreshold) {
    return { verdict: "within-threshold", summary };
  }

  if (overlay && options.writeOverlayTo) {
    await sharp(overlay, { raw: { width, height, channels: 4 } })
      .png()
      .toFile(options.writeOverlayTo);
  }
  return { verdict: "above-threshold", summary };
}

/** @param {DiffSummary} summary */
export function describeSummary(summary) {
  const percentage = (summary.diffRatio * 100).toFixed(4);
  return `${summary.differingPixels}px / ${summary.totalPixels} (${percentage}%), maxΔ=${summary.maxChannelDelta}`;
}
