import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("nested runner", () => {
  const runner = fileURLToPath(
    new URL("../../../scripts/run-node-tests.sh", import.meta.url)
  );
  const quiet = fileURLToPath(new URL("./quiet.mjs", import.meta.url));
  const root = fileURLToPath(new URL("../../..", import.meta.url));
  const result = spawnSync("bash", [runner, quiet], {
    cwd: root,
    encoding: "utf8"
  });
  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  if (result.status !== 0) {
    throw new Error(`nested runner exited ${result.status}`);
  }
});
