import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * Parse a dotenv-style document into a name/value map.
 *
 * @param {string} content
 * @returns {Map<string, string>}
 */
export function parseEnv(content) {
  const values = new Map();

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const equalsIndex = trimmed.indexOf("=");
    if (equalsIndex <= 0) {
      continue;
    }

    values.set(trimmed.slice(0, equalsIndex), trimmed.slice(equalsIndex + 1));
  }

  return values;
}

/**
 * Read an operator env file, defaulting to `<root>/.env`. A missing default
 * file yields an empty map; a missing explicitly named file is an error.
 *
 * @param {string | undefined} explicitPath
 * @param {string} root
 * @param {string} label
 * @returns {Map<string, string>}
 */
export function readOptionalEnvFile(explicitPath, root, label) {
  const envPath =
    explicitPath && explicitPath.trim() !== ""
      ? path.resolve(explicitPath)
      : path.join(root, ".env");
  if (!existsSync(envPath)) {
    if (explicitPath) {
      throw new Error(`${label} env file does not exist: ${envPath}`);
    }
    return new Map();
  }
  return parseEnv(readFileSync(envPath, "utf8"));
}
