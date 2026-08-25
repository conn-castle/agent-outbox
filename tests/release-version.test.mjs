import assert from "node:assert/strict";
import test from "node:test";

import {
  compareStableVersions,
  verifyReleaseTarget
} from "../scripts/release-version.mjs";

test("release version preflight accepts a target newer than package, main, and tags", () => {
  assert.deepEqual(
    verifyReleaseTarget("0.2.1", "0.2.0", ["v0.1.2", "v0.2.0"], "0.2.0"),
    {
      currentVersion: "0.2.0",
      mainVersion: "0.2.0",
      latestTag: "v0.2.0",
      targetVersion: "0.2.1"
    }
  );
  assert.equal(compareStableVersions("0.10.0", "0.9.9"), 1);
  assert.equal(
    compareStableVersions("9007199254740993.0.0", "9007199254740992.0.0"),
    1
  );
});

test("release version preflight accepts an unpublished prepared version", () => {
  assert.deepEqual(verifyReleaseTarget("0.2.2", "0.2.2", ["v0.2.1"], "0.2.2"), {
    currentVersion: "0.2.2",
    mainVersion: "0.2.2",
    latestTag: "v0.2.1",
    targetVersion: "0.2.2"
  });
});

test("release version preflight rejects a target older than the package version", () => {
  assert.throws(
    () => verifyReleaseTarget("0.1.9", "0.2.0", ["v0.1.2"], "0.1.2"),
    /is older than current package version 0\.2\.0/
  );
});

test("release version preflight accepts the unpublished version prepared on main", () => {
  assert.deepEqual(verifyReleaseTarget("0.2.1", "0.2.0", ["v0.2.0"], "0.2.1"), {
    currentVersion: "0.2.0",
    mainVersion: "0.2.1",
    latestTag: "v0.2.0",
    targetVersion: "0.2.1"
  });
});

test("release version preflight rejects a target older than the version on main", () => {
  assert.throws(
    () => verifyReleaseTarget("0.2.1", "0.2.0", ["v0.2.0"], "0.3.0"),
    /is older than origin\/main package version 0\.3\.0/
  );
});

test("release version preflight rejects an existing target tag", () => {
  assert.throws(
    () => verifyReleaseTarget("0.2.0", "0.1.2", ["v0.2.0"], "0.1.2"),
    /already has tag v0\.2\.0/
  );
});

test("release version preflight rejects a target behind the latest tag", () => {
  assert.throws(
    () => verifyReleaseTarget("0.2.1", "0.2.0", ["v0.2.2"], "0.2.0"),
    /must be newer than latest tag v0\.2\.2/
  );
});

test("release version preflight rejects malformed or prerelease versions", () => {
  assert.throws(
    () => verifyReleaseTarget("v0.2.1", "0.2.0", [], "0.2.0"),
    /must be stable X\.Y\.Z/
  );
  assert.throws(
    () => verifyReleaseTarget("0.2.1-beta.1", "0.2.0", [], "0.2.0"),
    /must be stable X\.Y\.Z/
  );
  assert.throws(
    () => verifyReleaseTarget("0.2.1", "0.2.0", [], "0.2.0-rc.1"),
    /origin\/main package version 0\.2\.0-rc\.1 is not stable X\.Y\.Z/
  );
});
