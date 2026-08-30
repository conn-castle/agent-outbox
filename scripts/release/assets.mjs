import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { ROOT } from "../repo-root.mjs";

/**
 * @param {string} distDir
 * @returns {{ name: string, path: string, bytes: Buffer }[]}
 */
export function certifiedReleaseAssets(distDir = path.join(ROOT, "dist")) {
  const names = readdirSync(distDir)
    .filter((name) => name.endsWith(".tar.gz") || name === "checksums.txt")
    .sort();
  const archives = names.filter((name) => name.endsWith(".tar.gz"));
  if (archives.length !== 4 || !names.includes("checksums.txt")) {
    throw new Error("certified CLI asset set is incomplete");
  }
  return names.map((name) => {
    const filePath = path.join(distDir, name);
    return {
      name,
      path: filePath,
      bytes: readFileSync(filePath)
    };
  });
}
