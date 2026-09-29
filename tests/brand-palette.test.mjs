import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  SUPPORTED_COLORS,
  SUPPORTED_COLOR_VALUES
} from "../src/shared/input-schema-rules.ts";

const palettePage = new URL(
  "../docs/brand/agent-outbox-color-palette.html",
  import.meta.url
);

test("the brand palette page lists exactly the supported API colors and values", async () => {
  const html = await readFile(palettePage, "utf8");
  const rootValues = new Map(
    [...html.matchAll(/--app-([a-z]+):\s*(#[0-9a-fA-F]{6});/g)].map(
      ([, name, value]) => [name, value.toLowerCase()]
    )
  );
  const apiSwatches = [
    ...html.matchAll(/<article class="swatch">([\s\S]*?)<\/article>/g)
  ]
    .map(([, body]) => ({
      apiName: body.match(/API name: ([a-z]+)/)?.[1],
      chipVariable: body.match(/var\(--app-([a-z]+)\)/)?.[1],
      copy: body.match(/data-copy="([^"]+)">([^<]+)</)
    }))
    .filter((swatch) => swatch.apiName !== undefined);

  assert.deepEqual(
    apiSwatches.map((swatch) => swatch.apiName),
    [...SUPPORTED_COLORS],
    "palette page API color swatches must match SUPPORTED_COLORS in order"
  );
  SUPPORTED_COLORS.forEach((name, index) => {
    const { chipVariable, copy } = apiSwatches[index];
    const value = SUPPORTED_COLOR_VALUES[name];
    assert.equal(chipVariable, name, `${name} chip variable`);
    assert.equal(rootValues.get(name), value, `--app-${name} value`);
    assert.equal(copy?.[1].toLowerCase(), value, `${name} copy value`);
    assert.equal(copy?.[2].toLowerCase(), value, `${name} copy label`);
  });
});
