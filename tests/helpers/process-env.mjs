/**
 * Temporarily sets `process.env` keys for a callback and restores the previous
 * values afterward. Sync callbacks keep the helper sync; async callbacks return
 * a Promise that restores after settlement.
 *
 * @template TResult
 * @param {Record<string, string | undefined>} values
 * @param {() => TResult | Promise<TResult>} callback
 * @returns {TResult | Promise<TResult>}
 */
export function withProcessEnv(values, callback) {
  const previous = new Map(
    Object.keys(values).map((name) => [name, process.env[name]])
  );

  const restore = () => {
    for (const [name, value] of previous) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  };

  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }

  try {
    const result = callback();
    if (
      result !== null &&
      (typeof result === "object" || typeof result === "function") &&
      typeof (/** @type {{ then?: unknown }} */ (result).then) === "function"
    ) {
      return Promise.resolve(result).finally(restore);
    }
    restore();
    return result;
  } catch (error) {
    restore();
    throw error;
  }
}
