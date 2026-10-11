import { expect, test } from "@playwright/test";

test("review theme switches by keyboard and persists across history and reloads", async ({
  page
}) => {
  page.on("pageerror", (error) => {
    throw error;
  });
  await page.goto("/human");
  await expect(page.getByTestId("workspace-hydrated")).toHaveText("hydrated");
  const toggle = page.getByRole("button", { name: "Dark mode", exact: true });
  const workspace = page.getByRole("main");
  const lightBackground = await workspace.evaluate(
    (element) => getComputedStyle(element).backgroundColor
  );
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await toggle.focus();
  await page.keyboard.press("Space");
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  const darkBackground = await workspace.evaluate(
    (element) => getComputedStyle(element).backgroundColor
  );
  expect(darkBackground).not.toBe(lightBackground);
  await expect(workspace).toHaveCSS("color-scheme", "dark");

  // Header controls must stay visible without intersecting the wordmark.
  const brand = await page
    .getByRole("link", { name: "Agent Outbox home" })
    .boundingBox();
  const controls = await toggle.boundingBox();
  expect(brand).not.toBeNull();
  expect(controls).not.toBeNull();
  expect(controls!.x).toBeGreaterThanOrEqual(brand!.x + brand!.width);
  expect(controls!.x + controls!.width).toBeLessThanOrEqual(
    page.viewportSize()!.width
  );

  await page.getByRole("link", { name: "History", exact: true }).click();
  await expect(page).toHaveURL(/status=answered/);
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(workspace).toHaveCSS("background-color", darkBackground);
  await page.reload();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(workspace).toHaveCSS("background-color", darkBackground);

  await toggle.focus();
  await page.keyboard.press("Enter");
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(workspace).toHaveCSS("background-color", lightBackground);
  await page.reload();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(workspace).toHaveCSS("background-color", lightBackground);
});

test("theme changes synchronize between tabs and storage failures remain actionable", async ({
  page,
  context
}) => {
  await page.goto("/human");
  const other = await context.newPage();
  await other.goto("/human");
  const toggle = page.getByRole("button", { name: "Dark mode", exact: true });
  const otherToggle = other.getByRole("button", {
    name: "Dark mode",
    exact: true
  });
  await toggle.click();
  await expect(otherToggle).toHaveAttribute("aria-pressed", "true");
  await expect(other.getByRole("main")).toHaveCSS("color-scheme", "dark");
  await other.evaluate(() => localStorage.clear());
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await other.close();

  await page.evaluate(() => {
    Storage.prototype.setItem = () => {
      throw new DOMException("Storage blocked", "SecurityError");
    };
  });
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("main")).toHaveCSS("color-scheme", "dark");
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "Browser storage is unavailable" })
  ).toBeVisible();
});
