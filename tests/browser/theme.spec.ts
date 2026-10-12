import { openPrimaryNavigation } from "./navigation";
import { expect, test } from "@playwright/test";

test("review theme switches by keyboard and persists across history and reloads", async ({
  page
}) => {
  const pageErrors: Error[] = [];
  page.on("pageerror", (error) => {
    pageErrors.push(error);
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

  await openPrimaryNavigation(page);
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
  expect(pageErrors).toEqual([]);
});

test("theme changes synchronize between tabs and storage failures remain actionable", async ({
  page,
  context
}) => {
  await page.goto("/human");
  await expect(page.getByTestId("workspace-hydrated")).toHaveText("hydrated");
  const other = await context.newPage();
  await other.goto("/human");
  await expect(other.getByTestId("workspace-hydrated")).toHaveText("hydrated");
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

test("theme header controls stay visible with Undo at phone and tablet widths", async ({
  page,
  isMobile
}) => {
  test.skip(isMobile, "One desktop browser covers explicit viewport changes");
  await page.goto("/human");
  await expect(page.getByTestId("workspace-hydrated")).toHaveText("hydrated");
  await page
    .getByRole("button", { name: "Approve permit brief", exact: true })
    .click();
  await expect(page.getByTestId("last-answer-undo")).toBeVisible();

  for (const dark of [false, true]) {
    if (dark)
      await page
        .getByRole("button", { name: "Dark mode", exact: true })
        .click();
    for (const width of [320, 520, 521, 600, 768, 800, 801, 1024]) {
      await page.setViewportSize({ width, height: 900 });
      const controls = await page
        .locator(
          ".app-brand, .app-location a, .theme-toggle, .account-banner > summary, .navigation-overflow > summary, .last-undo-button"
        )
        .evaluateAll((elements) =>
          elements
            .filter((element) => element.checkVisibility())
            .map((element) => {
              const { left, right, top, bottom } =
                element.getBoundingClientRect();
              return {
                label:
                  element.textContent || element.getAttribute("aria-label"),
                left,
                right,
                top,
                bottom
              };
            })
        );
      for (const [index, control] of controls.entries()) {
        expect(
          control.left,
          `${control.label} at ${width}px`
        ).toBeGreaterThanOrEqual(0);
        expect(
          control.right,
          `${control.label} at ${width}px`
        ).toBeLessThanOrEqual(width);
        for (const other of controls.slice(index + 1)) {
          const overlaps =
            Math.min(control.right, other.right) >
              Math.max(control.left, other.left) &&
            Math.min(control.bottom, other.bottom) >
              Math.max(control.top, other.top);
          expect(
            overlaps,
            `${control.label} overlaps ${other.label} at ${width}px`
          ).toBe(false);
        }
      }
      if (width <= 800) {
        expect(
          (await page.locator(".app-bar").boundingBox())!.height
        ).toBeLessThanOrEqual(64);
        const centers = await page
          .locator(".account-banner > summary")
          .evaluate((trigger) => {
            const outer = trigger.getBoundingClientRect();
            const inner = trigger
              .querySelector(".account-avatar")!
              .getBoundingClientRect();
            return {
              x: (inner.left + inner.right - outer.left - outer.right) / 2,
              y: (inner.top + inner.bottom - outer.top - outer.bottom) / 2
            };
          });
        expect(Math.abs(centers.x)).toBeLessThan(0.5);
        expect(Math.abs(centers.y)).toBeLessThan(0.5);
      }
    }
  }
});

test("compact navigation opens, dismisses and switches views without a second header row", async ({
  page
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/human");
  await expect(page.getByTestId("workspace-hydrated")).toHaveText("hydrated");
  const trigger = page.getByLabel("Navigation menu", { exact: true });
  const menu = page.locator("details.navigation-overflow");
  const primary = page.getByRole("navigation", { name: "Primary" });
  await expect(primary).not.toBeVisible();
  await trigger.focus();
  await page.keyboard.press("Enter");
  await expect(primary).toBeVisible();
  const lightMenuBackground = await primary.evaluate(
    (element) => getComputedStyle(element).backgroundColor
  );
  await expect(
    primary.getByRole("link", { name: "Review queue", exact: true })
  ).toHaveAttribute("aria-current", "page");
  await page.keyboard.press("Escape");
  await expect(menu).not.toHaveAttribute("open", "");
  await expect(trigger).toBeFocused();
  await trigger.click();
  await page
    .getByRole("heading", { name: "Needs review" })
    .click({ position: { x: 5, y: 5 } });
  await expect(menu).not.toHaveAttribute("open", "");
  await trigger.click();
  await primary.getByRole("link", { name: "History", exact: true }).click();
  await expect(page).toHaveURL(/status=answered/);
  await expect(menu).not.toHaveAttribute("open", "");
  await expect(
    page.getByRole("heading", { name: "Answered reviews" })
  ).toBeVisible();
  await trigger.click();
  await expect(
    primary.getByRole("link", { name: "History", exact: true })
  ).toHaveAttribute("aria-current", "page");
  await primary
    .getByRole("link", { name: "Review queue", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Needs review" })
  ).toBeVisible();
  await expect(menu).not.toHaveAttribute("open", "");
  await page.getByRole("button", { name: "Dark mode", exact: true }).click();
  await trigger.click();
  expect(
    await primary.evaluate(
      (element) => getComputedStyle(element).backgroundColor
    )
  ).not.toBe(lightMenuBackground);
  await page.getByLabel("Account status").locator("summary").click();
  await expect(menu).not.toHaveAttribute("open", "");
});
