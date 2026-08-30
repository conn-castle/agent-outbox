import assert from "node:assert/strict";
import test from "node:test";

import {
  validateCommandsVersionPins,
  validateGoModuleTooling,
  validateGoReleaserTooling,
  validateToolchainPackage
} from "../scripts/foundation/toolchain.mjs";

const FLYWAY_TOOLCHAIN_FIXTURE = {
  version: "12.10.0",
  image: "flyway/flyway",
  source: "test"
};

test("validateToolchainPackage accepts runtime dependencies only when toolchain-pinned", () => {
  const toolchain = {
    node: { version: "24.18.0", npm: "11.16.0" },
    go: { version: "1.26.4" },
    packageManager: { name: "pnpm", version: "11.9.0" },
    flyway: FLYWAY_TOOLCHAIN_FIXTURE,
    phase1Tools: {
      prettier: { package: "prettier", version: "3.9.3" }
    },
    runtimePins: {
      next: { package: "next", version: "16.2.9" }
    },
    runtimeDevTools: {
      pgTypes: { package: "@types/pg", version: "8.20.0" }
    },
    providerCli: {}
  };
  const packageJson = {
    packageManager: "pnpm@11.9.0",
    devEngines: {
      runtime: { name: "node", version: "24.18.0", onFail: "download" },
      packageManager: { name: "pnpm", version: "11.9.0", onFail: "download" }
    },
    dependencies: { next: "16.2.9" },
    devDependencies: {
      "@types/pg": "8.20.0",
      prettier: "3.9.3"
    }
  };

  assert.deepEqual(validateToolchainPackage(toolchain, packageJson), []);
});
test("validateToolchainPackage rejects provider CLIs without auth checks", () => {
  const toolchain = /** @type {any} */ ({
    node: { version: "24.18.0", npm: "11.16.0" },
    go: { version: "1.26.4" },
    packageManager: { name: "pnpm", version: "11.9.0" },
    flyway: FLYWAY_TOOLCHAIN_FIXTURE,
    phase1Tools: {},
    runtimePins: {},
    runtimeDevTools: {},
    providerCli: {
      cloudflareOpenNext: {
        package: "@opennextjs/cloudflare",
        version: "1.20.1"
      }
    }
  });
  const packageJson = {
    packageManager: "pnpm@11.9.0",
    devEngines: {
      runtime: { name: "node", version: "24.18.0", onFail: "download" },
      packageManager: { name: "pnpm", version: "11.9.0", onFail: "download" }
    },
    dependencies: {},
    devDependencies: { "@opennextjs/cloudflare": "1.20.1" }
  };

  assert.deepEqual(validateToolchainPackage(toolchain, packageJson), [
    "toolchain.json providerCli.cloudflareOpenNext.authCheck is required"
  ]);
});
test("validateToolchainPackage rejects unpinned runtime dependencies", () => {
  const toolchain = {
    node: { version: "24.18.0", npm: "11.16.0" },
    go: { version: "1.26.4" },
    packageManager: { name: "pnpm", version: "11.9.0" },
    flyway: FLYWAY_TOOLCHAIN_FIXTURE,
    phase1Tools: {
      prettier: { package: "prettier", version: "3.9.3" }
    },
    runtimePins: {
      next: { package: "next", version: "16.2.9" }
    },
    runtimeDevTools: {},
    providerCli: {}
  };
  const packageJson = {
    packageManager: "pnpm@11.9.0",
    devEngines: {
      runtime: { name: "node", version: "24.18.0", onFail: "download" },
      packageManager: { name: "pnpm", version: "11.9.0", onFail: "download" }
    },
    dependencies: { next: "16.2.9", lodash: "4.17.21" },
    devDependencies: { prettier: "3.9.3" }
  };

  assert.deepEqual(validateToolchainPackage(toolchain, packageJson), [
    "dependency lodash is not pinned in toolchain.json"
  ]);
});
test("validateToolchainPackage treats npm as Node runtime metadata, not a devDependency", () => {
  const toolchain = {
    node: { version: "24.18.0", npm: "11.16.0" },
    go: { version: "1.26.4" },
    packageManager: { name: "pnpm", version: "11.9.0" },
    flyway: FLYWAY_TOOLCHAIN_FIXTURE,
    phase1Tools: {},
    runtimePins: {},
    runtimeDevTools: {},
    providerCli: {}
  };
  const packageJson = {
    packageManager: "pnpm@11.9.0",
    devEngines: {
      runtime: { name: "node", version: "24.18.0", onFail: "download" },
      packageManager: { name: "pnpm", version: "11.9.0", onFail: "download" }
    },
    devDependencies: {}
  };

  assert.deepEqual(validateToolchainPackage(toolchain, packageJson), []);
});
test("validateToolchainPackage rejects Node types from a newer runtime major", () => {
  const toolchain = {
    node: { version: "24.18.0", npm: "11.16.0" },
    go: { version: "1.26.4" },
    packageManager: { name: "pnpm", version: "11.9.0" },
    flyway: FLYWAY_TOOLCHAIN_FIXTURE,
    phase1Tools: {
      nodeTypes: { package: "@types/node", version: "26.0.1" }
    },
    runtimePins: {},
    runtimeDevTools: {},
    providerCli: {}
  };
  const packageJson = {
    packageManager: "pnpm@11.9.0",
    devEngines: {
      runtime: { name: "node", version: "24.18.0", onFail: "download" },
      packageManager: { name: "pnpm", version: "11.9.0", onFail: "download" }
    },
    devDependencies: { "@types/node": "26.0.1" }
  };

  assert.deepEqual(validateToolchainPackage(toolchain, packageJson), [
    "@types/node major 26 must match Node major 24"
  ]);
});
test("validateCommandsVersionPins rejects stale pinned documentation versions", () => {
  const failures = validateCommandsVersionPins(
    {
      node: { version: "24.18.0", npm: "11.16.0" },
      go: { version: "1.26.4" },
      packageManager: { name: "pnpm", version: "11.9.0" },
      flyway: FLYWAY_TOOLCHAIN_FIXTURE,
      phase1Tools: {},
      runtimePins: {},
      runtimeDevTools: {},
      providerCli: {}
    },
    "Run from: repo root Prerequisites: Node `22.13.0` or newer. CI provisions Node `26.0.0`. Uses pnpm `12.0.0`. Runs Flyway `12.0.0`."
  );

  assert.deepEqual(failures, [
    "COMMANDS.md pinned Node 26.0.0 must match toolchain.json 24.18.0",
    "COMMANDS.md pnpm 12.0.0 must match toolchain.json 11.9.0",
    "COMMANDS.md Flyway 12.0.0 must match toolchain.json 12.10.0"
  ]);
});
test("validateCommandsVersionPins allows lower-bound Node prerequisites", () => {
  const failures = validateCommandsVersionPins(
    {
      node: { version: "24.18.0", npm: "11.16.0" },
      go: { version: "1.26.4" },
      packageManager: { name: "pnpm", version: "11.9.0" },
      flyway: FLYWAY_TOOLCHAIN_FIXTURE,
      phase1Tools: {},
      runtimePins: {},
      runtimeDevTools: {},
      providerCli: {}
    },
    "Run from: repo root Prerequisites: Node `22.13.0` or newer. CI provisions Node `24.18.0`. Uses pnpm `11.9.0`. Project scripts run on pinned Node `24.18.0`. Runs Flyway `12.10.0`."
  );

  assert.deepEqual(failures, []);
});
test("validateGoModuleTooling requires pinned Go module directives and dependencies", () => {
  const toolchain = {
    node: { version: "24.18.0", npm: "11.16.0" },
    go: { version: "1.26.4" },
    goTooling: {
      cobra: { module: "github.com/spf13/cobra", version: "1.10.2" }
    },
    packageManager: { name: "pnpm", version: "11.9.0" },
    flyway: FLYWAY_TOOLCHAIN_FIXTURE,
    phase1Tools: {},
    runtimePins: {},
    runtimeDevTools: {},
    providerCli: {}
  };

  assert.deepEqual(
    validateGoModuleTooling(
      toolchain,
      `
module agent-outbox

go 1.26.4

require (
  github.com/spf13/cobra v1.10.2
)
`
    ),
    []
  );

  assert.deepEqual(
    validateGoModuleTooling(
      toolchain,
      `
module agent-outbox

go 1.25.0

toolchain go1.25.0

require github.com/spf13/cobra v1.10.1
`
    ),
    [
      "cli/go.mod go directive must be 1.26.4",
      "cli/go.mod toolchain directive must be go1.26.4 when present",
      "cli/go.mod must require github.com/spf13/cobra v1.10.2"
    ]
  );

  assert.deepEqual(
    validateGoModuleTooling(
      { ...toolchain, goTooling: {} },
      `
module agent-outbox

go 1.26.4

require (
  github.com/spf13/cobra v1.10.2
)
`
    ),
    ["toolchain.json goTooling.cobra module/version is required"]
  );
});
test("validateGoReleaserTooling requires pinned package verification module", () => {
  const toolchain = {
    node: { version: "24.18.0", npm: "11.16.0" },
    go: { version: "1.26.4" },
    goTooling: {
      goreleaser: {
        module: "github.com/goreleaser/goreleaser/v2",
        version: "2.16.0"
      }
    },
    packageManager: { name: "pnpm", version: "11.9.0" },
    flyway: FLYWAY_TOOLCHAIN_FIXTURE,
    phase1Tools: {},
    runtimePins: {},
    runtimeDevTools: {},
    providerCli: {}
  };
  const makefile = `GORELEASER_MODULE := github.com/goreleaser/goreleaser/v2@v2.16.0

package-check:
\tgo run $(GORELEASER_MODULE) check .goreleaser.yaml
\tgo run $(GORELEASER_MODULE) release --snapshot --clean

cli-release-dist:
\tgo run $(GORELEASER_MODULE) release --clean --skip=publish
\tcd cli && go run ./internal/tools/rendercask ../dist/homebrew/Casks/agent-outbox.rb "$(RELEASE_TAG)" ../dist/checksums.txt

release-check: check go-check package-check
`;
  const goreleaser = `release:
  disable: true
`;

  assert.deepEqual(
    validateGoReleaserTooling(toolchain, makefile, goreleaser),
    []
  );

  const reorderedRelease = `release:
  prerelease: auto
  disable: true
`;
  assert.deepEqual(
    validateGoReleaserTooling(toolchain, makefile, reorderedRelease),
    []
  );

  assert.deepEqual(
    validateGoReleaserTooling({ ...toolchain, goTooling: {} }, "", ""),
    ["toolchain.json goTooling.goreleaser module/version is required"]
  );

  assert.deepEqual(
    validateGoReleaserTooling(
      toolchain,
      "package-check:",
      "homebrew_casks:\nrelease:\n"
    ),
    [
      "Makefile package-check must use pinned GoReleaser github.com/goreleaser/goreleaser/v2@v2.16.0",
      "Makefile package-check must validate .goreleaser.yaml",
      "Makefile package-check must build a clean snapshot release",
      "Makefile cli-release-dist must build a clean tagged release without publishing",
      "Makefile cli-release-dist must render the Homebrew cask from release checksums",
      "Makefile release-check must run check, go-check, and package-check",
      ".goreleaser.yaml must disable release publishing",
      ".goreleaser.yaml must leave Homebrew cask rendering to the project-owned renderer"
    ]
  );

  assert.deepEqual(
    validateGoReleaserTooling(
      toolchain,
      makefile,
      `homebrew_casks:
  - name: agent-outbox

archives:
  - id: agent-outbox
    skip_upload: true

release:
  disable: true
`
    ),
    [
      ".goreleaser.yaml must leave Homebrew cask rendering to the project-owned renderer"
    ]
  );
});
