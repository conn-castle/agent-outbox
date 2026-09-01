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

test("the homepage presents public installation and caller connection", async ({
  page
}) => {
  await page.goto("/");

  const accessSection = page.locator("#installation");
  await expect(
    accessSection.getByRole("heading", {
      name: "Connect once. Then step away."
    })
  ).toBeVisible();
  await expect(accessSection).toContainText(
    "brew install --cask conn-castle/tap/agent-outbox"
  );
  await expect(accessSection).toContainText(
    "agent-outbox caller connect my-agent"
  );
  await expect(accessSection).toContainText("Approve in browser");
  await expect(accessSection).not.toContainText("invite-only");
  await expect(
    accessSection.getByRole("link", { name: "Request caller access" })
  ).toHaveCount(0);
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
