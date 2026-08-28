import { expect, test } from "@playwright/test";

test("the Pro plan describes the supported file upload direction", async ({
  page
}) => {
  await page.goto("/#pricing");

  const pricing = page.locator("#pricing");
  await expect(pricing).toContainText("File uploads in human responses");
  await expect(pricing).not.toContainText(
    "File uploads in requests and responses"
  );
});

test("the homepage separates public CLI installation from invite-only caller access", async ({
  page
}) => {
  await page.goto("/");

  const accessSection = page.locator("#installation");
  await expect(
    accessSection.getByRole("heading", {
      name: "Connect once. Then step away."
    })
  ).toBeVisible();
  await expect(accessSection).toContainText("invite-only");
  await expect(accessSection).toContainText(
    "curl -fsSL https://agent-outbox.dev/install.sh | sh"
  );

  const requestAccess = accessSection.getByRole("link", {
    name: "Request caller access"
  });
  await expect(requestAccess).toHaveAttribute("href", "/contact");

  await requestAccess.click();
  await expect(page).toHaveURL(/\/contact$/);
  await expect(
    page.getByRole("heading", {
      name: "Talk to the people building Agent Outbox.",
      level: 1
    })
  ).toBeVisible();
  await expect(page.getByRole("option", { name: "Caller access" })).toHaveCount(
    1
  );
});

test("the homepage stays inside the viewport at tablet and phone widths", async ({
  page
}) => {
  for (const width of [768, 393]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");

    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth
      )
    ).toBe(true);
    await expect(page.locator(".nav-cta")).toBeInViewport();
    await expect(
      page.getByRole("heading", {
        name: "Keep agents moving. Review when it works for you.",
        level: 2
      })
    ).toBeVisible();
  }
});
