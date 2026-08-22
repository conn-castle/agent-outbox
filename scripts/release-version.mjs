import { readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const STABLE_RELEASE_VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/**
 * @param {string} left
 * @param {string} right
 */
export function compareStableVersions(left, right) {
  if (!STABLE_RELEASE_VERSION.test(left)) {
    throw new Error(`current package version ${left} is not stable X.Y.Z`);
  }
  if (!STABLE_RELEASE_VERSION.test(right)) {
    throw new Error(`release target ${right} must be stable X.Y.Z`);
  }
  const leftParts = left.split(".").map(BigInt);
  const rightParts = right.split(".").map(BigInt);
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      return leftParts[index] < rightParts[index] ? -1 : 1;
    }
  }
  return 0;
}

/**
 * @param {string} targetVersion
 * @param {string} currentVersion
 * @param {string[]} tags
 */
export function verifyReleaseTarget(targetVersion, currentVersion, tags) {
  if (!STABLE_RELEASE_VERSION.test(targetVersion)) {
    throw new Error(`release target ${targetVersion} must be stable X.Y.Z`);
  }
  if (!STABLE_RELEASE_VERSION.test(currentVersion)) {
    throw new Error(
      `current package version ${currentVersion} is not stable X.Y.Z`
    );
  }

  const numberedTags = tags
    .filter((tag) => tag.startsWith("v"))
    .map((tag) => ({ tag, version: tag.slice(1) }))
    .filter(({ version }) => STABLE_RELEASE_VERSION.test(version));
  const targetTag = `v${targetVersion}`;
  if (numberedTags.some(({ tag }) => tag === targetTag)) {
    throw new Error(
      `release target ${targetVersion} already has tag ${targetTag}`
    );
  }
  if (compareStableVersions(targetVersion, currentVersion) <= 0) {
    throw new Error(
      `release target ${targetVersion} must be newer than current package version ${currentVersion}`
    );
  }

  const latest = numberedTags.reduce(
    (selected, candidate) =>
      !selected ||
      compareStableVersions(selected.version, candidate.version) < 0
        ? candidate
        : selected,
    /** @type {{ tag: string; version: string } | undefined} */ (undefined)
  );
  if (latest && compareStableVersions(targetVersion, latest.version) <= 0) {
    throw new Error(
      `release target ${targetVersion} must be newer than latest tag ${latest.tag}`
    );
  }

  return {
    currentVersion,
    latestTag: latest?.tag ?? "<none>",
    targetVersion
  };
}

/** @param {string} targetVersion */
export function verifyRepositoryReleaseTarget(targetVersion) {
  runGit(["fetch", "--tags", "origin", "main"]);
  const packageJson = JSON.parse(
    readFileSync(path.join(ROOT, "package.json"), "utf8")
  );
  const tags = runGit(["tag", "--list", "v*"]).split("\n").filter(Boolean);
  return verifyReleaseTarget(targetVersion, packageJson.version, tags);
}

/** @param {string[]} args */
function runGit(args) {
  const result = spawnSync("git", args, {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${result.stderr.trim() || `status ${result.status}`}`
    );
  }
  return result.stdout.trim();
}

function main() {
  const targetVersion = process.argv[2] ?? "";
  const result = verifyRepositoryReleaseTarget(targetVersion);
  console.log(
    `current=${result.currentVersion} latest_tag=${result.latestTag} target=${result.targetVersion}`
  );
  console.log("Release version preflight passed.");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
