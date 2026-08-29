import { mkdir } from "node:fs/promises";
import path from "node:path";

import { expect, test, type Locator, type Page } from "@playwright/test";

import manifest from "../../marketing/screenshots.json" with { type: "json" };

async function waitForFiniteAnimations(locator: Locator) {
  await locator.evaluate(async (root) => {
    const animations = root.getAnimations({ subtree: true });
    await Promise.all(
      animations.map((animation) => {
        const timing = animation.effect?.getComputedTiming();
        if (
          timing &&
          (timing.iterations === Infinity || timing.duration === Infinity)
        ) {
          return undefined;
        }
        return animation.finished.catch(() => undefined);
      })
    );
  });
}

async function waitUntilCaptureReady(page: Page, route: string) {
  await expect(page.getByTestId("workspace-hydrated")).toHaveText("hydrated");
  await page.evaluate(async () => {
    await document.fonts.ready;
  });

  if (new URL(route, "http://127.0.0.1").searchParams.has("item")) {
    const dialog = page.locator("dialog.detail-modal[open]");
    const detail = dialog.locator(".detail-pane");
    await expect(dialog).toBeVisible();
    await waitForFiniteAnimations(dialog);
    await expect(dialog).toHaveCSS("opacity", "1");
    await expect(detail).toBeVisible();
    await expect(detail.locator(".detail-title")).toBeVisible();
    await expect(
      detail.getByRole("button", { name: "Approve to send" })
    ).toBeVisible();
    return;
  }

  const workspace = page.locator(".human-workspace");
  await expect(
    page.getByRole("heading", { name: "Needs review" })
  ).toBeVisible();
  await waitForFiniteAnimations(workspace);
}

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
    await waitUntilCaptureReady(page, asset.route);

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
