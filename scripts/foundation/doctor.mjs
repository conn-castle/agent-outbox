import { redactCommandResult, runQuiet, errorCode } from "./commands.mjs";

/**
 * @typedef {{ ok: boolean, message: string }} CheckResult
 */

/**
 * @param {string} projectsJson
 * @param {string} expectedProjectRef
 * @returns {boolean}
 */
export function supabaseProjectsIncludeRef(projectsJson, expectedProjectRef) {
  const parsed = JSON.parse(projectsJson);
  const projects = Array.isArray(parsed) ? parsed : parsed.projects;
  if (!Array.isArray(projects)) {
    return false;
  }

  return projects.some((project) => {
    if (!project || typeof project !== "object") {
      return false;
    }

    const values = Object.values(project);
    return values.some((value) => value === expectedProjectRef);
  });
}

/** @param {string} output */
export function firstVersionToken(output) {
  return output.split(/\s+/)[0] ?? "";
}

/** @param {string} output */
export function goVersionFromOutput(output) {
  return output.match(/go\d+\.\d+\.\d+/)?.[0] ?? "";
}

/** @param {string} output */
export function semanticVersionFromOutput(output) {
  return output.match(/\d+\.\d+\.\d+/)?.[0] ?? "";
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {string} expected
 * @param {(output: string) => string} parser
 * @returns {CheckResult}
 */
export function versionResult(command, args, expected, parser) {
  const result = runQuiet(command, args);
  if (errorCode(result.error) === "ENOENT") {
    return { ok: false, message: `${command} is not installed` };
  }

  if (result.status !== 0) {
    return {
      ok: false,
      message: `${command} version check failed (${JSON.stringify(
        redactCommandResult(result)
      )})`
    };
  }

  const output = `${result.stdout}${result.stderr}`.trim();
  const actual = parser(output);
  if (actual !== expected) {
    return {
      ok: false,
      message: `${command} version ${actual || "unknown"} does not match ${expected}`
    };
  }

  return { ok: true, message: `${command} ${expected}` };
}

/**
 * @param {string} command
 * @param {string[]} args
 * @returns {CheckResult}
 */
export function providerAuthResult(command, args) {
  const result = runQuiet(command, args);
  if (errorCode(result.error) === "ENOENT") {
    return { ok: false, message: `${command} is not installed` };
  }

  if (result.status !== 0) {
    return {
      ok: false,
      message: `${command} auth check failed (${JSON.stringify(
        redactCommandResult(result)
      )})`
    };
  }

  return { ok: true, message: `${command} auth check passed` };
}

/**
 * @param {Map<string, string> | null} envValues
 * @returns {CheckResult}
 */
export function supabaseProjectResult(envValues) {
  const projectRef = envValues?.get("SUPABASE_PROJECT_REF");
  if (!projectRef) {
    return {
      ok: false,
      message:
        "SUPABASE_PROJECT_REF is missing; create the dedicated Agent Outbox Supabase project and set it in .env"
    };
  }

  const result = runQuiet("supabase", ["projects", "list", "--output", "json"]);
  if (errorCode(result.error) === "ENOENT") {
    return { ok: false, message: "supabase is not installed" };
  }

  if (result.status !== 0) {
    return {
      ok: false,
      message: `supabase project check failed (${JSON.stringify(
        redactCommandResult(result)
      )})`
    };
  }

  try {
    if (supabaseProjectsIncludeRef(result.stdout, projectRef)) {
      return {
        ok: true,
        message: "supabase authenticated account can see SUPABASE_PROJECT_REF"
      };
    }
  } catch {
    return {
      ok: false,
      message: "supabase project check returned unreadable JSON"
    };
  }

  return {
    ok: false,
    message:
      "supabase authenticated account cannot see SUPABASE_PROJECT_REF; use the dedicated Agent Outbox Supabase account"
  };
}
