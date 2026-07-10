import { expect, test } from "@playwright/test";

test("public legal routes and the contact redirect are reachable from the global footer", async ({
  page
}) => {
  await page.goto("/");

  await expect(
    page
      .getByRole("navigation", { name: "Primary" })
      .getByRole("link", { name: "Upgrade" })
  ).toHaveAttribute("href", "/upgrade");

  const footer = page.getByRole("contentinfo");
  await expect(footer.getByRole("link", { name: "Contact" })).toBeVisible();
  await expect(footer.getByRole("link", { name: "Privacy" })).toBeVisible();
  await expect(footer.getByRole("link", { name: "Terms" })).toBeVisible();
  await expect(
    footer.getByRole("link", { name: "Software license" })
  ).toHaveAttribute(
    "href",
    "https://github.com/conn-castle/agent-outbox/blob/main/LICENSE"
  );

  await footer.getByRole("link", { name: "Terms" }).click();
  await expect(
    page.getByRole("heading", { name: "Terms of Service", level: 1 })
  ).toBeVisible();
  await expect(
    page.getByText("PolyForm Noncommercial License 1.0.0")
  ).toBeVisible();
  await expect(page.getByText("Monroe County, New York").first()).toBeVisible();

  await page
    .getByRole("contentinfo")
    .getByRole("link", { name: "Privacy" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Privacy Policy", level: 1 })
  ).toBeVisible();
  await expect(
    page.getByText("Pending items on the hosted free tier")
  ).toBeVisible();
  await expect(page.getByText("Unacknowledged outputs")).toBeVisible();
  await expect(page.getByText("Sentry:")).toBeVisible();

  const contactLink = page
    .getByRole("contentinfo")
    .getByRole("link", { name: "Contact" });
  await expect(contactLink).toHaveAttribute("href", "/contact");

  const contactResponse = await page.request.get("/contact", {
    maxRedirects: 0
  });
  expect(contactResponse.status()).toBe(307);
  expect(contactResponse.headers().location).toBe(
    "https://github.com/conn-castle/agent-outbox/issues"
  );

  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth
    )
  ).toBe(true);
});

test("signup and billing surfaces disclose the governing legal links", async ({
  page
}) => {
  await page.goto("/sign-up");
  await expect(page.getByText("By continuing, you agree to the")).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Terms of Service" })
  ).toHaveAttribute("href", "/terms-of-service");
  await expect(
    page.getByRole("link", { name: "Privacy Policy" })
  ).toHaveAttribute("href", "/privacy-policy");

  await page.goto("/upgrade");
  await expect(
    page.getByText("By starting checkout, you agree to the")
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Terms of Service" })
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Privacy Policy" })
  ).toBeVisible();
});
