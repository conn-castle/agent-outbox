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
