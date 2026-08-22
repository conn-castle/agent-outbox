import assert from "node:assert/strict";
import test from "node:test";

import {
  sha256,
  verifyMarketingReleaseFiles
} from "../scripts/marketing-screenshots.mjs";

const image = Buffer.from("deterministic-png-fixture");

function validManifest() {
  return {
    schemaVersion: 1,
    releaseVersion: "1.2.3",
    assets: [
      {
        id: "queueDesktop",
        file: "public/product-review-queue.png",
        publicPath: "/product-review-queue.png",
        route: "/human?status=all",
        width: 1440,
        height: 960,
        sha256: sha256(image)
      }
    ]
  };
}

test("marketing release attestation accepts the complete current asset set", () => {
  assert.deepEqual(
    verifyMarketingReleaseFiles(validManifest(), { version: "1.2.3" }, () =>
      Buffer.from(image)
    ).map((asset) => asset.id),
    ["queueDesktop"]
  );
});

test("marketing release attestation rejects a stale release version", () => {
  assert.throws(
    () =>
      verifyMarketingReleaseFiles(validManifest(), { version: "1.2.4" }, () =>
        Buffer.from(image)
      ),
    /attest 1\.2\.3; expected package version 1\.2\.4/
  );
});

test("marketing release attestation rejects missing and modified screenshots", () => {
  assert.throws(
    () =>
      verifyMarketingReleaseFiles(validManifest(), { version: "1.2.3" }, () => {
        throw new Error("ENOENT");
      }),
    /product-review-queue\.png is missing/
  );
  assert.throws(
    () =>
      verifyMarketingReleaseFiles(validManifest(), { version: "1.2.3" }, () =>
        Buffer.from("different pixels")
      ),
    /hash is .*; expected/
  );
});

test("marketing release attestation rejects duplicate and unsafe asset entries", () => {
  const duplicate = validManifest();
  duplicate.assets.push({ ...duplicate.assets[0] });
  assert.throws(
    () =>
      verifyMarketingReleaseFiles(duplicate, { version: "1.2.3" }, () =>
        Buffer.from(image)
      ),
    /duplicate marketing screenshot id/
  );

  const unsafe = validManifest();
  unsafe.assets[0].file = "../outside.png";
  assert.throws(
    () =>
      verifyMarketingReleaseFiles(unsafe, { version: "1.2.3" }, () =>
        Buffer.from(image)
      ),
    /invalid file/
  );
});
