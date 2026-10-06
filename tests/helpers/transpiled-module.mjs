import { readFileSync } from "node:fs";
import vm from "node:vm";

import ts from "typescript";

const REPO_ROOT = new URL("../../", import.meta.url);

/**
 * Transpiles a repo-root-relative TS/TSX/MJS module to CommonJS.
 *
 * @param {string} relativePath
 * @param {string} [source]
 * @returns {string}
 */
export function transpileForTest(relativePath, source) {
  return ts.transpileModule(
    source ?? readFileSync(new URL(relativePath, REPO_ROOT), "utf8"),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2024,
        esModuleInterop: true,
        jsx: ts.JsxEmit.ReactJSX
      },
      // TypeScript preserves ESM for .mjs even with module: CommonJS.
      fileName: relativePath.replace(/\.mjs$/, ".js")
    }
  ).outputText;
}

/**
 * Runs a repo-root-relative module in a fresh VM context. The context gets only
 * the given `globals` (none by default), and `require` returns `stubs` entries,
 * then defers to `fallbackRequire`; without it, unstubbed imports throw.
 * Pass host `Error`/`AggregateError` in `globals` when cross-realm instanceof
 * checks require the host constructors.
 *
 * @param {string} relativePath
 * @param {{ stubs?: Record<string, unknown>, globals?: Record<string, unknown>, fallbackRequire?: (specifier: string) => unknown }} [options]
 * @returns {Record<string, unknown>}
 */
export function loadModuleForTest(
  relativePath,
  { stubs = {}, globals = {}, fallbackRequire } = {}
) {
  const exports = /** @type {Record<string, unknown>} */ ({});
  const module = { exports };
  vm.runInNewContext(
    transpileForTest(relativePath),
    {
      ...globals,
      exports,
      module,
      /** @param {string} specifier */
      require(specifier) {
        if (Object.hasOwn(stubs, specifier)) return stubs[specifier];
        if (fallbackRequire) return fallbackRequire(specifier);
        throw new Error(
          `Unexpected test import ${specifier} from ${relativePath}`
        );
      }
    },
    { filename: relativePath }
  );
  return module.exports;
}
