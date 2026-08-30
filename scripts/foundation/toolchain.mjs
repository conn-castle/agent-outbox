import { escapeRegExp } from "../regex.mjs";
import { yamlTopLevelBlockHasScalar } from "../workflow-yaml.mjs";

/**
 * @typedef {{
 *   package?: string | null,
 *   version: string,
 *   dependencyType?: "dependencies" | "devDependencies"
 * }} ToolPin
 *
 * @typedef {ToolPin & { authCheck: string[] }} ProviderCliPin
 *
 * @typedef {{
 *   node: { version: string, npm: string },
 *   go: { version: string },
 *   goTooling?: {
 *     cobra?: { module: string, version: string },
 *     githubActionsSetupGo?: { version: string },
 *     goreleaser?: { module: string, version: string }
 *   },
 *   packageManager: { name: string, version: string },
 *   flyway: { version: string, image: string, source: string },
 *   phase1Tools: Record<string, ToolPin>,
 *   runtimePins: Record<string, ToolPin>,
 *   runtimeDevTools: Record<string, ToolPin>,
 *   providerCli: Record<string, ProviderCliPin>
 * }} Toolchain
 *
 * @typedef {{
 *   packageManager?: string,
 *   devEngines?: {
 *     runtime?: { name?: string, version?: string, onFail?: string },
 *     packageManager?: { name?: string, version?: string, onFail?: string }
 *   },
 *   scripts?: Record<string, string>,
 *   dependencies?: Record<string, string>,
 *   devDependencies?: Record<string, string>
 * }} PackageJson
 */

/**
 * @param {Toolchain} toolchain
 * @param {PackageJson} packageJson
 * @returns {string[]}
 */
export function validateToolchainPackage(toolchain, packageJson) {
  const errors = [];

  if (
    packageJson.packageManager !== `pnpm@${toolchain.packageManager.version}`
  ) {
    errors.push("package.json packageManager does not match toolchain.json");
  }

  if (packageJson.devEngines?.runtime?.name !== "node") {
    errors.push("package.json devEngines.runtime must pin node");
  }

  if (packageJson.devEngines?.runtime?.version !== toolchain.node.version) {
    errors.push(
      "package.json devEngines.runtime does not match toolchain.json"
    );
  }

  if (packageJson.devEngines?.runtime?.onFail !== "download") {
    errors.push(
      "package.json devEngines.runtime must download the pinned runtime"
    );
  }

  if (
    packageJson.devEngines?.packageManager?.name !==
    toolchain.packageManager.name
  ) {
    errors.push("package.json devEngines.packageManager must pin pnpm");
  }

  if (
    packageJson.devEngines?.packageManager?.version !==
    toolchain.packageManager.version
  ) {
    errors.push(
      "package.json devEngines.packageManager does not match toolchain.json"
    );
  }

  const expectedDependencies = new Map();
  const expectedDevDependencies = new Map();
  for (const section of /** @type {const} */ (["phase1Tools", "providerCli"])) {
    for (const tool of Object.values(toolchain[section])) {
      if (tool.package) {
        expectedDevDependencies.set(tool.package, tool.version);
      }
    }
  }

  for (const [name, cli] of Object.entries(toolchain.providerCli)) {
    if (!Array.isArray(cli.authCheck) || cli.authCheck.length === 0) {
      errors.push(`toolchain.json providerCli.${name}.authCheck is required`);
    }
  }

  for (const tool of Object.values(toolchain.runtimeDevTools)) {
    if (tool.package) {
      expectedDevDependencies.set(tool.package, tool.version);
    }
  }

  for (const tool of Object.values(toolchain.runtimePins)) {
    if (!tool.package) {
      continue;
    }

    if (tool.dependencyType === "devDependencies") {
      expectedDevDependencies.set(tool.package, tool.version);
    } else {
      expectedDependencies.set(tool.package, tool.version);
    }
  }

  for (const [dependency, version] of expectedDependencies) {
    if (packageJson.dependencies?.[dependency] !== version) {
      errors.push(`dependency ${dependency} must be pinned to ${version}`);
    }
  }

  for (const [dependency, version] of expectedDevDependencies) {
    if (packageJson.devDependencies?.[dependency] !== version) {
      errors.push(`devDependency ${dependency} must be pinned to ${version}`);
    }
  }

  const nodeTypesVersion = packageJson.devDependencies?.["@types/node"];
  if (nodeTypesVersion) {
    const runtimeMajor = toolchain.node.version.split(".")[0];
    const typesMajor = nodeTypesVersion.split(".")[0];
    if (typesMajor !== runtimeMajor) {
      errors.push(
        `@types/node major ${typesMajor} must match Node major ${runtimeMajor}`
      );
    }
  }

  const allowedDependencies = new Set(expectedDependencies.keys());
  for (const dependency of Object.keys(packageJson.dependencies ?? {})) {
    if (!allowedDependencies.has(dependency)) {
      errors.push(`dependency ${dependency} is not pinned in toolchain.json`);
    }
  }

  const allowedDevDependencies = new Set(expectedDevDependencies.keys());
  for (const dependency of Object.keys(packageJson.devDependencies ?? {})) {
    if (!allowedDevDependencies.has(dependency)) {
      errors.push(
        `devDependency ${dependency} is not pinned in toolchain.json`
      );
    }
  }

  return errors;
}

/**
 * @param {Toolchain} toolchain
 * @param {string} commandsContent
 * @returns {string[]}
 */
export function validateCommandsVersionPins(toolchain, commandsContent) {
  const errors = [];
  const pinnedNodeVersions = [
    ...commandsContent.matchAll(/(?:CI provisions|pinned) Node `([^`]+)`/g)
  ].map((match) => match[1]);
  const pnpmVersions = [...commandsContent.matchAll(/pnpm `([^`]+)`/g)].map(
    (match) => match[1]
  );
  const flywayVersions = [...commandsContent.matchAll(/Flyway `([^`]+)`/g)].map(
    (match) => match[1]
  );

  if (pinnedNodeVersions.length === 0) {
    errors.push("COMMANDS.md must reference the pinned Node version");
  }
  for (const version of pinnedNodeVersions) {
    if (version !== toolchain.node.version) {
      errors.push(
        `COMMANDS.md pinned Node ${version} must match toolchain.json ${toolchain.node.version}`
      );
    }
  }

  if (pnpmVersions.length === 0) {
    errors.push("COMMANDS.md must reference the pinned pnpm version");
  }
  for (const version of pnpmVersions) {
    if (version !== toolchain.packageManager.version) {
      errors.push(
        `COMMANDS.md pnpm ${version} must match toolchain.json ${toolchain.packageManager.version}`
      );
    }
  }

  if (flywayVersions.length === 0) {
    errors.push("COMMANDS.md must reference the pinned Flyway version");
  }
  for (const version of flywayVersions) {
    if (version !== toolchain.flyway.version) {
      errors.push(
        `COMMANDS.md Flyway ${version} must match toolchain.json ${toolchain.flyway.version}`
      );
    }
  }

  return errors;
}

/**
 * @param {Toolchain} toolchain
 * @param {string} goModContent
 * @returns {string[]}
 */
export function validateGoModuleTooling(toolchain, goModContent) {
  const errors = [];
  const goVersion = toolchain.go.version;

  if (!new RegExp(`^go ${escapeRegExp(goVersion)}$`, "m").test(goModContent)) {
    errors.push(`cli/go.mod go directive must be ${goVersion}`);
  }

  const toolchainMatch = goModContent.match(/^toolchain\s+(\S+)$/m);
  if (toolchainMatch && toolchainMatch[1] !== `go${goVersion}`) {
    errors.push(
      `cli/go.mod toolchain directive must be go${goVersion} when present`
    );
  }

  validateGoModulePin(
    errors,
    goModContent,
    "cobra",
    toolchain.goTooling?.cobra
  );
  return errors;
}

/**
 * @param {Toolchain} toolchain
 * @param {string} makefileContent
 * @param {string} goreleaserContent
 * @returns {string[]}
 */
export function validateGoReleaserTooling(
  toolchain,
  makefileContent,
  goreleaserContent
) {
  const tool = toolchain.goTooling?.goreleaser;
  if (!tool?.module || !tool?.version) {
    return ["toolchain.json goTooling.goreleaser module/version is required"];
  }

  const errors = [];
  const expected = `${tool.module}@v${tool.version}`;
  if (!makefileContent.includes(expected)) {
    errors.push(
      `Makefile package-check must use pinned GoReleaser ${expected}`
    );
  }
  if (
    !makefileContent.includes(
      "go run $(GORELEASER_MODULE) check .goreleaser.yaml"
    )
  ) {
    errors.push("Makefile package-check must validate .goreleaser.yaml");
  }
  if (
    !makefileContent.includes(
      "go run $(GORELEASER_MODULE) release --snapshot --clean"
    )
  ) {
    errors.push("Makefile package-check must build a clean snapshot release");
  }
  if (
    !makefileContent.includes(
      "go run $(GORELEASER_MODULE) release --clean --skip=publish"
    )
  ) {
    errors.push(
      "Makefile cli-release-dist must build a clean tagged release without publishing"
    );
  }
  if (
    !makefileContent.includes(
      'cd cli && go run ./internal/tools/rendercask ../dist/homebrew/Casks/agent-outbox.rb "$(RELEASE_TAG)" ../dist/checksums.txt'
    )
  ) {
    errors.push(
      "Makefile cli-release-dist must render the Homebrew cask from release checksums"
    );
  }
  if (
    !makefileContent.includes("release-check: check go-check package-check")
  ) {
    errors.push(
      "Makefile release-check must run check, go-check, and package-check"
    );
  }
  if (
    !yamlTopLevelBlockHasScalar(goreleaserContent, "release", "disable", "true")
  ) {
    errors.push(".goreleaser.yaml must disable release publishing");
  }
  if (/^homebrew_casks:\s*(?:#.*)?$/m.test(goreleaserContent)) {
    errors.push(
      ".goreleaser.yaml must leave Homebrew cask rendering to the project-owned renderer"
    );
  }
  return errors;
}

/**
 * @param {string[]} errors
 * @param {string} goModContent
 * @param {string} key
 * @param {{ module?: string, version?: string } | undefined} tool
 */
function validateGoModulePin(errors, goModContent, key, tool) {
  if (!tool?.module || !tool?.version) {
    errors.push(`toolchain.json goTooling.${key} module/version is required`);
    return;
  }
  const requirePattern = new RegExp(
    `\\b${escapeRegExp(tool.module)}\\s+v${escapeRegExp(tool.version)}\\b`
  );
  if (!requirePattern.test(goModContent)) {
    errors.push(`cli/go.mod must require ${tool.module} v${tool.version}`);
  }
}
