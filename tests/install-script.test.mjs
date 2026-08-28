import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const repositoryRoot = new URL("..", import.meta.url).pathname;
const installerPath = join(repositoryRoot, "public", "install.sh");

test("direct installer verifies and installs the matching release asset", () => {
  const fixture = createInstallerFixture();
  const installDir = join(fixture.root, "install");

  execFileSync("sh", [installerPath], {
    env: {
      ...process.env,
      AGENT_OUTBOX_VERSION: fixture.version,
      AGENT_OUTBOX_INSTALL_DIR: installDir,
      AGENT_OUTBOX_INSTALL_FIXTURE: fixture.root,
      PATH: `${fixture.binDir}:${process.env.PATH}`
    },
    stdio: "pipe"
  });

  const installed = join(installDir, "agent-outbox");
  assert.equal(readFileSync(installed, "utf8"), fixture.binaryContents);
});

test("direct installer refuses a release with the wrong checksum", () => {
  const fixture = createInstallerFixture();
  const installDir = join(fixture.root, "install");
  writeFileSync(fixture.checksumPath, `${"0".repeat(64)}  ${fixture.asset}\n`);

  assert.throws(() =>
    execFileSync("sh", [installerPath], {
      env: {
        ...process.env,
        AGENT_OUTBOX_VERSION: fixture.version,
        AGENT_OUTBOX_INSTALL_DIR: installDir,
        AGENT_OUTBOX_INSTALL_FIXTURE: fixture.root,
        PATH: `${fixture.binDir}:${process.env.PATH}`
      },
      stdio: "pipe"
    })
  );
  assert.equal(existsSync(join(installDir, "agent-outbox")), false);
});

function createInstallerFixture() {
  const root = mkdtempSync(join(tmpdir(), "agent-outbox-installer-test-"));
  const archiveRoot = join(root, "archive");
  const binDir = join(root, "bin");
  execFileSync("mkdir", ["-p", archiveRoot, binDir]);

  const version = "v9.8.7";
  const targetOS = process.platform === "darwin" ? "darwin" : "linux";
  const targetArch = process.arch === "arm64" ? "arm64" : "amd64";
  const asset = `agent-outbox_9.8.7_${targetOS}_${targetArch}.tar.gz`;
  const binaryContents = "#!/bin/sh\necho fixture-agent-outbox\n";
  const binaryPath = join(archiveRoot, "agent-outbox");
  writeFileSync(binaryPath, binaryContents);
  chmodSync(binaryPath, 0o755);
  execFileSync("tar", [
    "-czf",
    join(root, asset),
    "-C",
    archiveRoot,
    "agent-outbox"
  ]);

  const checksum = createHash("sha256")
    .update(readFileSync(join(root, asset)))
    .digest("hex");
  const checksumPath = join(root, "checksums.txt");
  writeFileSync(checksumPath, `${checksum}  ${asset}\n`);

  const fakeCurl = join(binDir, "curl");
  writeFileSync(
    fakeCurl,
    `#!/bin/sh
set -eu
output=""
url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) output="$2"; shift 2 ;;
    *) url="$1"; shift ;;
  esac
done
case "$url" in
  */checksums.txt) cp "$AGENT_OUTBOX_INSTALL_FIXTURE/checksums.txt" "$output" ;;
  *.tar.gz) cp "$AGENT_OUTBOX_INSTALL_FIXTURE/\${url##*/}" "$output" ;;
  *) exit 1 ;;
esac
`
  );
  chmodSync(fakeCurl, 0o755);

  return { root, binDir, version, asset, checksumPath, binaryContents };
}
