import type { Page } from "@playwright/test";

export async function openPrimaryNavigation(page: Page) {
  const trigger = page.getByLabel("Navigation menu", { exact: true });
  if (
    (await trigger.isVisible()) &&
    (await page.locator("details.navigation-overflow").getAttribute("open")) ===
      null
  ) {
    await trigger.click();
  }
}
