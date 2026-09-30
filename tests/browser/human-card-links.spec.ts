import { expect, test, type Page } from "@playwright/test";

const callerId = "00000000-0000-4000-8000-000000000503";
const cardHref = (id: string, caller = callerId) =>
  `/human?${new URLSearchParams({ caller_id: caller, caller_item_id: id })}`;
const dialog = (page: Page) =>
  page.getByRole("dialog", { name: "Review detail", exact: true });
const rowByTitle = (page: Page, title: string) =>
  page
    .locator("article.review-row")
    .filter({ has: page.locator(".row-title", { hasText: title }) });

test("copy link preserves the copyable ID and opens the card on a fresh visit", async ({
  page
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (value: string) => {
          (window as unknown as { copied: string }).copied = value;
        }
      }
    });
  });
  await page.goto("/human?search=permit");
  const row = rowByTitle(page, "Review neighborhood permit brief");
  await row
    .getByRole("button", { name: "Copy identifier", exact: true })
    .click();
  expect(
    await page.evaluate(() => (window as unknown as { copied: string }).copied)
  ).toBe("steward-brief-101");
  await row
    .getByLabel("More actions for Review neighborhood permit brief")
    .click();
  await row.getByRole("button", { name: "Copy link", exact: true }).click();
  await expect(
    row.getByRole("button", { name: "Link copied", exact: true })
  ).toBeVisible();
  const copied = await page.evaluate(
    () => (window as unknown as { copied: string }).copied
  );
  const url = new URL(copied);
  expect(url.searchParams.get("caller_item_id")).toBe("steward-brief-101");
  expect(url.searchParams.get("caller_id")).toBe(callerId);
  expect(url.searchParams.has("search")).toBe(false);
  await page.goto(copied);
  await expect(dialog(page)).toContainText("Review neighborhood permit brief");
  await page.reload();
  await expect(dialog(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toHaveCount(0);
  await expect(row).toBeInViewport();
  await expect(row.locator(".row-details-link")).toBeFocused();
});

test("linked cards beyond page one stay visible after dismissal and navigation", async ({
  page
}) => {
  await page.goto(
    `${cardHref("fixture-page-101")}&search=no-match&priority=urgent&page=999`
  );
  await expect(dialog(page)).toContainText("Beyond one hundred review");
  await page.getByRole("button", { name: "Close detail", exact: true }).click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(page).toHaveURL(/page=2/);
  const row = rowByTitle(page, "Beyond one hundred review");
  await expect(row).toBeInViewport();
  await expect(row.locator(".row-details-link")).toBeFocused();
  await page.getByRole("button", { name: "Previous 100" }).click();
  await expect(page).not.toHaveURL(/caller_item_id|page=2/);
  await expect(dialog(page)).toHaveCount(0);
});

test("answered card links choose the answered queue", async ({ page }) => {
  await page.goto("/human?status=answered");
  const row = rowByTitle(page, "Confirm the electrician’s arrival window");
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: async (value: string) => {
          (window as unknown as { copied: string }).copied = value;
        }
      }
    });
  });
  await page.reload();
  await row
    .getByLabel("More actions for Confirm the electrician’s arrival window")
    .click();
  await row.getByRole("button", { name: "Copy link", exact: true }).click();
  await page.goto(
    await page.evaluate(() => (window as unknown as { copied: string }).copied)
  );
  await expect(dialog(page)).toContainText(
    "Confirm the electrician’s arrival window"
  );
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(/status=answered/);
  await expect(row).toBeInViewport();
});

test("answering a linked card returns to its resolved queue page", async ({
  page
}) => {
  await page.goto(cardHref("fixture-page-101"));
  await expect(dialog(page)).toContainText("Beyond one hundred review");
  await dialog(page)
    .getByRole("button", { name: "Approve", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Undo “Approve”", exact: true })
  ).toBeVisible();
  await expect(page).toHaveURL(/page=2/);
  await expect(page).not.toHaveURL(/caller_item_id/);
  await expect(dialog(page)).toHaveCount(0);
  await expect(rowByTitle(page, "Beyond one hundred review")).toHaveCount(0);
});

test("missing IDs, wrong callers, and incomplete links show a dismissible unavailable dialog", async ({
  page
}) => {
  for (const href of [
    cardHref("missing-card"),
    cardHref("invalid\0id"),
    cardHref("steward-brief-101", "invalid\0caller"),
    cardHref("steward-brief-101", "not-the-caller"),
    "/human?caller_item_id=steward-brief-101"
  ]) {
    await page.goto(href);
    await expect(
      dialog(page).getByRole("heading", { name: "Review unavailable" })
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Close detail", exact: true })
      .click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(page).not.toHaveURL(/caller_item_id/);
  }
});

test("copy link reports clipboard failures on the control and supports retry", async ({
  page
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async () => {
          throw new Error("Denied");
        }
      }
    });
  });
  await page.goto("/human");
  const row = rowByTitle(page, "Review neighborhood permit brief");
  await row
    .getByLabel("More actions for Review neighborhood permit brief")
    .click();
  await row.getByRole("button", { name: "Copy link", exact: true }).click();
  await expect(row.getByRole("alert")).toHaveText("Copy failed. Try again.");
  await expect(row.getByRole("textbox")).toHaveCount(0);
  await expect(
    row.getByRole("button", { name: "Dismiss", exact: true })
  ).toHaveCount(0);
  await expect(
    row.getByRole("button", {
      name: "Copy failed. Try again.",
      exact: true
    })
  ).toHaveText("Copy failed");
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: () =>
          new Promise<void>((_resolve, reject) => {
            (window as unknown as { failCopy: () => void }).failCopy = () =>
              reject(new Error("Denied again"));
          })
      }
    });
  });
  await row
    .getByRole("button", { name: "Copy failed. Try again.", exact: true })
    .click();
  await expect(row.getByRole("alert")).toHaveCount(0);
  await expect(
    row.getByRole("button", { name: "Copy link", exact: true })
  ).toBeVisible();
  await page.evaluate(() =>
    (window as unknown as { failCopy: () => void }).failCopy()
  );
  await expect(row.getByRole("alert")).toHaveText("Copy failed. Try again.");
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (value: string) => {
          (window as unknown as { copied: string }).copied = value;
        }
      }
    });
  });
  await row
    .getByRole("button", {
      name: "Copy failed. Try again.",
      exact: true
    })
    .click();
  await expect(
    row.getByRole("button", { name: "Link copied", exact: true })
  ).toBeVisible();
  const url = new URL(
    await page.evaluate(() => (window as unknown as { copied: string }).copied)
  );
  expect(url.searchParams.get("caller_item_id")).toBe("steward-brief-101");
  await expect(row.getByRole("alert")).toHaveCount(0);
});

test("copy identifier and copy link write to the browser clipboard in one tap", async ({
  page,
  context
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/human?search=permit");
  const row = rowByTitle(page, "Review neighborhood permit brief");
  await row
    .getByRole("button", { name: "Copy identifier", exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe("steward-brief-101");
  await row
    .getByLabel("More actions for Review neighborhood permit brief")
    .click();
  await row.getByRole("button", { name: "Copy link", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(new URL(cardHref("steward-brief-101"), page.url()).href);
  await expect(
    row.getByRole("button", { name: "Link copied", exact: true })
  ).toBeVisible();
  await expect(row.getByRole("alert")).toHaveCount(0);
  await expect(row.getByRole("textbox")).toHaveCount(0);
});
