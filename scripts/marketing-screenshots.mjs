import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  STABLE_RELEASE_VERSION,
  verifyRepositoryReleaseTarget
} from "./release-version.mjs";
import {
  comparePng,
  DEFAULT_THRESHOLDS,
  describeSummary
} from "./marketing-asset-gate.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST_PATH = path.join(ROOT, "marketing", "screenshots.json");
const CAPTURE_ROOT = path.join(
  ROOT,
  ".agent-layer",
  "tmp",
  "marketing-capture"
);
const SHA256 = /^[0-9a-f]{64}$/;

/** @param {Buffer | string} content */
export function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Validate the release attestation and every committed screenshot without
 * launching a browser. Production uses this fail-fast precondition; pixel
 * verification remains a non-mutating release-check job.
 *
 * @param {unknown} rawManifest
 * @param {{ version?: unknown }} packageJson
 * @param {(file: string) => Buffer} readAsset
 */
export function verifyMarketingReleaseFiles(
  rawManifest,
  packageJson,
  readAsset
) {
  if (!rawManifest || typeof rawManifest !== "object") {
    throw new Error("marketing screenshot manifest must be an object");
  }
  const manifest = /** @type {Record<string, unknown>} */ (rawManifest);
  if (manifest.schemaVersion !== 1) {
    throw new Error("marketing screenshot manifest schemaVersion must be 1");
  }
  if (
    typeof packageJson.version !== "string" ||
    !STABLE_RELEASE_VERSION.test(packageJson.version)
  ) {
    throw new Error("package version must be a stable X.Y.Z release");
  }
  if (manifest.releaseVersion !== packageJson.version) {
    throw new Error(
      `marketing screenshots attest ${String(manifest.releaseVersion)}; expected package version ${packageJson.version}`
    );
  }
  if (!Array.isArray(manifest.assets) || manifest.assets.length === 0) {
    throw new Error(
      "marketing screenshot manifest must list at least one asset"
    );
  }

  const ids = new Set();
  const files = new Set();
  const publicPaths = new Set();
  for (const rawAsset of manifest.assets) {
    if (!rawAsset || typeof rawAsset !== "object") {
      throw new Error("marketing screenshot entries must be objects");
    }
    const asset = /** @type {Record<string, unknown>} */ (rawAsset);
    if (typeof asset.id !== "string" || !/^[a-z][A-Za-z0-9]*$/.test(asset.id)) {
      throw new Error(
        "marketing screenshot id must be lower-camel alphanumeric"
      );
    }
    if (ids.has(asset.id)) {
      throw new Error(`duplicate marketing screenshot id ${asset.id}`);
    }
    ids.add(asset.id);

    if (
      typeof asset.file !== "string" ||
      !/^public\/[a-z0-9][a-z0-9-]*\.png$/.test(asset.file)
    ) {
      throw new Error(`marketing screenshot ${asset.id} has an invalid file`);
    }
    if (files.has(asset.file)) {
      throw new Error(`duplicate marketing screenshot file ${asset.file}`);
    }
    files.add(asset.file);

    const expectedPublicPath = `/${path.posix.basename(asset.file)}`;
    if (asset.publicPath !== expectedPublicPath) {
      throw new Error(
        `marketing screenshot ${asset.id} publicPath must be ${expectedPublicPath}`
      );
    }
    if (publicPaths.has(asset.publicPath)) {
      throw new Error(
        `duplicate marketing screenshot publicPath ${String(asset.publicPath)}`
      );
    }
    publicPaths.add(asset.publicPath);

    if (
      typeof asset.route !== "string" ||
      !asset.route.startsWith("/human") ||
      typeof asset.width !== "number" ||
      !Number.isInteger(asset.width) ||
      asset.width <= 0 ||
      typeof asset.height !== "number" ||
      !Number.isInteger(asset.height) ||
      asset.height <= 0
    ) {
      throw new Error(
        `marketing screenshot ${asset.id} must have a /human route and positive integer dimensions`
      );
    }
    if (typeof asset.sha256 !== "string" || !SHA256.test(asset.sha256)) {
      throw new Error(`marketing screenshot ${asset.id} has an invalid sha256`);
    }

    let content;
    try {
      content = readAsset(asset.file);
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      throw new Error(
        `marketing screenshot ${asset.file} is missing: ${cause}`
      );
    }
    const actual = sha256(content);
    if (actual !== asset.sha256) {
      throw new Error(
        `marketing screenshot ${asset.file} hash is ${actual}; expected ${asset.sha256}`
      );
    }
  }

  return /** @type {Array<Record<string, unknown>>} */ (manifest.assets);
}

export function verifyCommittedMarketingReleaseFiles() {
  const manifest = readJson(MANIFEST_PATH);
  const packageJson = readJson(path.join(ROOT, "package.json"));
  return verifyMarketingReleaseFiles(manifest, packageJson, (file) =>
    readFileSync(path.join(ROOT, file))
  );
}

/**
 * @param {"capture" | "verify"} mode
 * @param {string} outputDir
 */
function capture(mode, outputDir) {
  const result = spawnSync(
    "bash",
    [
      path.join(ROOT, "scripts", "marketing-capture-container.sh"),
      mode,
      outputDir
    ],
    { cwd: ROOT, env: process.env, stdio: "inherit" }
  );
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`marketing capture failed with status ${result.status}`);
  }
  return outputDir;
}

async function captureForReview() {
  const manifest = readJson(MANIFEST_PATH);
  const packageJson = readJson(path.join(ROOT, "package.json"));
  const assets = verifyMarketingReleaseFiles(
    manifest,
    packageJson,
    readCommittedFile
  );
  const reviewDir = path.join(CAPTURE_ROOT, "review");
  rmSync(reviewDir, { recursive: true, force: true });
  mkdirSync(path.join(reviewDir, "baseline"), { recursive: true });
  for (const asset of assets) {
    const file = String(asset.file);
    writeFileSync(
      path.join(reviewDir, "baseline", path.basename(file)),
      readCommittedFile(file)
    );
  }
  const generatedDir = path.join(reviewDir, "generated");
  mkdirSync(generatedDir, { recursive: true });
  capture("capture", generatedDir);
  const report = await compareAndWriteReport(
    reviewDir,
    assets,
    generatedDir,
    true
  );

  for (const result of report.results) {
    const destination = path.join(ROOT, String(result.asset.file));
    if (isSubstantive(result.comparison)) {
      copyFileSync(result.generated, destination);
    } else {
      // Keep the committed baseline bytes when capture drift is insignificant.
      // This is the important distinction between a fresh capture and a
      // screenshot change that should enter a PR or release review.
      copyFileSync(result.baselineCopy, destination);
    }
  }

  console.log("Marketing screenshots regenerated in public/ for review.");
  console.log(
    `Review report: ${path.relative(ROOT, path.join(reviewDir, "review.html"))}`
  );
  console.log(
    report.changed.length === 0
      ? "No substantive screenshot changes; insignificant capture drift was discarded."
      : `Substantively changed screenshots: ${report.changed.join(", ")}`
  );
}

/** @param {string} file */
function readCommittedFile(file) {
  const result = spawnSync("git", ["show", `HEAD:${file}`], {
    cwd: ROOT,
    encoding: null,
    maxBuffer: 10 * 1024 * 1024
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `cannot read committed marketing screenshot ${file}: ${result.stderr.toString("utf8").trim()}`
    );
  }
  return result.stdout;
}

async function verifyFreshCapture() {
  const assets = verifyCommittedMarketingReleaseFiles();
  const outputDir = path.join(CAPTURE_ROOT, "verify");
  rmSync(outputDir, { recursive: true, force: true });
  mkdirSync(outputDir, { recursive: true });
  capture("verify", outputDir);
  const report = await compareAndWriteReport(
    outputDir,
    assets,
    outputDir,
    false
  );
  if (report.changed.length > 0) {
    throw new Error(
      `committed marketing screenshots have substantive differences from a fresh capture: ${report.changed.join(", ")}; inspect ${path.relative(ROOT, path.join(outputDir, "review.html"))}`
    );
  }
  console.log(
    "Committed marketing screenshots match a fresh pinned capture within the configured tolerance."
  );
}

/** @param {string} version */
function approveScreenshots(version) {
  const preflight = verifyRepositoryReleaseTarget(version);
  console.log(
    `current=${preflight.currentVersion} main=${preflight.mainVersion} latest_tag=${preflight.latestTag} target=${preflight.targetVersion}`
  );
  const manifest = readJson(MANIFEST_PATH);
  if (!Array.isArray(manifest.assets)) {
    throw new Error("marketing screenshot manifest assets must be an array");
  }
  const manifestWithApprovedHashes = {
    ...manifest,
    releaseVersion: version,
    assets: /** @type {Array<Record<string, unknown>>} */ (manifest.assets).map(
      (asset) => {
        const approvedPath = path.join(ROOT, String(asset.file));
        if (!existsSync(approvedPath)) {
          throw new Error(
            `marketing screenshot ${String(asset.file)} is missing; run make marketing before approval`
          );
        }
        return { ...asset, sha256: sha256(readFileSync(approvedPath)) };
      }
    )
  };
  const approvedAssets = verifyMarketingReleaseFiles(
    manifestWithApprovedHashes,
    { version },
    (file) => readFileSync(path.join(ROOT, file))
  );
  writeFileSync(
    MANIFEST_PATH,
    `${JSON.stringify(
      { ...manifest, releaseVersion: version, assets: approvedAssets },
      null,
      2
    )}\n`,
    "utf8"
  );
  console.log(`Recorded human-approved marketing screenshots for ${version}.`);
}

/**
 * Write a local HTML report with before, after, overlay, and difference views.
 *
 * @param {string} outputDir
 * @param {Array<Record<string, unknown>>} [validatedAssets]
 * @param {string} [generatedRoot]
 * @param {boolean} [baselineReady]
 */
async function compareAndWriteReport(
  outputDir,
  validatedAssets,
  generatedRoot = outputDir,
  baselineReady = false
) {
  const manifest = readJson(MANIFEST_PATH);
  const assets =
    validatedAssets ??
    /** @type {Array<Record<string, unknown>>} */ (manifest.assets);
  const baselineDir = path.join(outputDir, "baseline");
  const diffDir = path.join(outputDir, "diff");
  mkdirSync(baselineDir, { recursive: true });
  mkdirSync(diffDir, { recursive: true });
  const changed = [];
  const results = [];
  const sections = [];
  for (const asset of assets) {
    const file = String(asset.file);
    const generated = path.join(generatedRoot, file);
    if (!existsSync(generated)) {
      throw new Error(`capture did not produce ${file}`);
    }
    const baseline = path.join(ROOT, file);
    const baselineCopy = path.join(baselineDir, path.basename(file));
    if (!baselineReady) {
      copyFileSync(baseline, baselineCopy);
    }
    const comparison = await comparePng(
      baselineCopy,
      generated,
      DEFAULT_THRESHOLDS,
      {
        writeOverlayTo: path.join(diffDir, `${path.basename(file)}.diff.png`)
      }
    );
    if (isSubstantive(comparison)) {
      changed.push(String(asset.id));
    }
    results.push({ asset, baselineCopy, generated, comparison });
    const status = describeComparison(comparison);
    const before = `baseline/${path.basename(file)}`;
    const after = path.relative(outputDir, generated);
    sections.push(`
      <section>
        <h2>${escapeHtml(String(asset.id))} ${escapeHtml(status.label)}</h2>
        <p><code>${escapeHtml(file)}</code></p>
        <p>${escapeHtml(status.detail)}</p>
        <div class="grid">
          <figure><figcaption>Committed</figcaption><img src="${escapeHtml(before)}" alt="Committed ${escapeHtml(String(asset.id))}"></figure>
          <figure><figcaption>Regenerated</figcaption><img src="${escapeHtml(after)}" alt="Regenerated ${escapeHtml(String(asset.id))}"></figure>
          <figure class="stack"><figcaption>50% overlay</figcaption><img src="${escapeHtml(before)}" alt=""><img class="overlay" src="${escapeHtml(after)}" alt="Overlay ${escapeHtml(String(asset.id))}"></figure>
          <figure class="stack difference"><figcaption>Difference blend</figcaption><img src="${escapeHtml(before)}" alt=""><img class="overlay" src="${escapeHtml(after)}" alt="Difference ${escapeHtml(String(asset.id))}"></figure>
        </div>
      </section>`);
  }
  writeFileSync(
    path.join(outputDir, "review.html"),
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Marketing screenshot review</title><style>body{font:16px system-ui;margin:2rem;background:#f5f2eb;color:#202427}section{margin:3rem 0;padding-top:1rem;border-top:1px solid #bbb}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:1rem}figure{margin:0;overflow:auto}figcaption{font-weight:700;margin-bottom:.5rem}img{display:block;width:100%;height:auto}.stack{display:grid;align-content:start}.stack figcaption{grid-area:1/1}.stack img{grid-area:2/1}.stack .overlay{opacity:.5}.difference .overlay{opacity:1;mix-blend-mode:difference}</style><body><h1>Marketing screenshot review</h1><p>Review substantive screenshot changes; insignificant capture drift is discarded before it reaches <code>public/</code>.</p>${sections.join("\n")}</body></html>`,
    "utf8"
  );
  return { changed, results };
}

/** @param {Awaited<ReturnType<typeof comparePng>>} comparison */
function isSubstantive(comparison) {
  return !["identical", "within-threshold"].includes(comparison.verdict);
}

/** @param {Awaited<ReturnType<typeof comparePng>>} comparison */
function describeComparison(comparison) {
  if (comparison.verdict === "identical") {
    return { label: "(unchanged)", detail: "Byte-identical pixels." };
  }
  if (comparison.verdict === "within-threshold") {
    return {
      label: "(unchanged; within tolerance)",
      detail: `Insignificant capture drift discarded: ${describeSummary(comparison.summary)}.`
    };
  }
  if (comparison.verdict === "size-mismatch") {
    return {
      label: "(changed; size mismatch)",
      detail: `Baseline ${comparison.baseline.width}x${comparison.baseline.height}; candidate ${comparison.candidate.width}x${comparison.candidate.height}.`
    };
  }
  if (comparison.verdict === "missing-baseline") {
    return {
      label: "(changed; missing baseline)",
      detail: "Baseline is missing."
    };
  }
  return {
    label: "(changed)",
    detail: `Substantive pixel difference: ${describeSummary(comparison.summary)}.`
  };
}

/** @param {string} file */
function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

/** @param {string} value */
function escapeHtml(value) {
  return value.replaceAll(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      })[character] ?? character
  );
}

async function main() {
  switch (process.argv[2]) {
    case "capture":
      await captureForReview();
      break;
    case "approve":
      approveScreenshots(process.argv[3] ?? "");
      break;
    case "check":
      verifyCommittedMarketingReleaseFiles();
      console.log("Marketing release attestation is current.");
      break;
    case "verify":
      await verifyFreshCapture();
      break;
    default:
      throw new Error(
        "Usage: node scripts/marketing-screenshots.mjs <capture|approve VERSION|check|verify>"
      );
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
