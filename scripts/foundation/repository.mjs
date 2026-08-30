import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { ROOT } from "../repo-root.mjs";

/**
 * @param {string} relativePath
 * @returns {unknown}
 */
export function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(ROOT, relativePath), "utf8"));
}

/**
 * @param {string} relativePath
 * @returns {string}
 */
export function readText(relativePath) {
  return readFileSync(path.join(ROOT, relativePath), "utf8");
}

/**
 * @param {string[]} relativePaths
 * @returns {Record<string, string>}
 */
export function readPathContents(relativePaths) {
  /** @type {Record<string, string>} */
  const contents = {};
  for (const relativePath of relativePaths) {
    contents[relativePath] = readText(relativePath);
  }
  return contents;
}

/**
 * @param {string} relativeDir
 * @returns {string[]}
 */
export function listSourceFiles(relativeDir) {
  const absoluteDir = path.join(ROOT, relativeDir);
  const entries = readdirSync(absoluteDir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const relativePath = path.join(relativeDir, entry.name);
    if (entry.isDirectory()) {
      return listSourceFiles(relativePath);
    }

    if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(entry.name)) {
      return [relativePath];
    }

    return [];
  });
}
