import { mkdir } from "node:fs/promises";
import path from "node:path";

import { expect, test } from "@playwright/test";

import manifest from "../../marketing/screenshots.json" with { type: "json" };

test("capture every landing-page product screenshot", async ({ browser }) => {
  const outputRoot = process.env.AGENT_OUTBOX_MARKETING_OUTPUT_DIR;
  if (!outputRoot) {
    throw new Error("AGENT_OUTBOX_MARKETING_OUTPUT_DIR is required.");
  }

  for (const asset of manifest.assets) {
    const page = await browser.newPage({
      viewport: { width: asset.width, height: asset.height }
    });
    await page.goto(asset.route);
    await expect(page.getByTestId("workspace-hydrated")).toHaveText("hydrated");
    if (new URL(asset.route, "http://127.0.0.1").searchParams.has("item")) {
      const detail = page.locator("dialog.detail-modal[open] .detail-pane");
      await expect(detail).toBeVisible();
      await expect(detail.locator(".detail-title")).toBeVisible();
      await expect(
        detail.getByRole("button", { name: "Approve to send" })
      ).toBeVisible();
    } else {
      await expect(
        page.getByRole("heading", { name: "Needs review" })
      ).toBeVisible();
    }
    await page.evaluate(async () => document.fonts.ready);

    const outputPath = path.join(outputRoot, asset.file);
    await mkdir(path.dirname(outputPath), { recursive: true });
    await page.screenshot({
      path: outputPath,
      animations: "disabled",
      fullPage: false
    });
    await page.close();
  }
});
