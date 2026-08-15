import { expect, test } from "@playwright/test";

test("local development contact API uses the simulated email binding", async ({
  isMobile,
  page
}, testInfo) => {
  test.skip(isMobile, "the shared simulated binding is exercised once");
  const contactUrl = new URL("/contact", String(testInfo.project.use.baseURL));
  contactUrl.hostname = "localhost";
  await page.goto(contactUrl.href);
  const result = await page.evaluate(
    async (submission) => {
      const response = await fetch("/api/contact", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(submission)
      });
      return { status: response.status, payload: await response.json() };
    },
    {
      name: "Ada Lovelace",
      email: "ada@example.com",
      topic: "Product question",
      message: "I would like to understand how team review works.",
      company: ""
    }
  );

  expect(result.status, JSON.stringify(result.payload)).toBe(200);
  expect(result.payload).toEqual({ ok: true });
});

test("public legal and contact routes are reachable from the global footer", async ({
  page
}) => {
  await page.goto("/");

  const primaryNav = page.getByRole("navigation", { name: "Primary" });
  await expect(primaryNav.locator('a[href="/#installation"]')).toHaveText(
    "Installation"
  );
  await expect(primaryNav.locator('a[href="/#how-it-works"]')).toHaveText(
    "How it works"
  );
  await expect(primaryNav.locator('a[href="/sign-in"]')).toHaveText("Sign in");
  await expect(
    primaryNav.getByRole("link", { name: "Get started" })
  ).toHaveAttribute("href", "/sign-up");

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
    page.getByText("PolyForm Perimeter License 1.0.1")
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

  await contactLink.click();
  await expect(
    page.getByRole("heading", {
      name: "Talk to the people building Agent Outbox.",
      level: 1
    })
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "How can we help?", level: 2 })
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: /Open a GitHub issue/ })
  ).toHaveAttribute(
    "href",
    "https://github.com/conn-castle/agent-outbox/issues"
  );

  await page.route("**/api/contact", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true })
    });
  });
  await page.getByLabel("Name").fill("Ada Lovelace");
  await page.getByLabel("Email").fill("ada@example.com");
  await page
    .getByLabel("What can we help with?")
    .selectOption("Product question");
  await page
    .getByLabel("Message")
    .fill("I would like to understand how team review works.");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(
    page.getByText("Message sent. We’ll get back to you soon.")
  ).toBeVisible();
  await expect(page.getByRole("contentinfo")).toBeVisible();

  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth
    )
  ).toBe(true);
});

test("contact page exposes the footer in a standard desktop viewport", async ({
  page
}) => {
  await page.setViewportSize({ width: 1728, height: 1000 });
  await page.goto("/contact");

  const footer = page.getByRole("contentinfo");
  await expect(footer).toBeInViewport();
  await expect(footer.getByText("Agent Outbox", { exact: true })).toBeVisible();

  const footerBounds = await footer.boundingBox();
  expect(footerBounds).not.toBeNull();
  expect(footerBounds?.y).toBeLessThan(800);
});

test("signup and billing surfaces disclose the governing legal links", async ({
  page
}) => {
  await page.goto("/sign-up");
  await expect(page.getByText("By continuing, you agree to the")).toBeVisible();
  const signupMain = page.getByRole("main");
  await expect(
    signupMain.getByRole("link", { name: "Terms of Service" })
  ).toHaveAttribute("href", "/terms-of-service");
  await expect(
    signupMain.getByRole("link", { name: "Privacy Policy" })
  ).toHaveAttribute("href", "/privacy-policy");

  await page.goto("/upgrade");
  await expect(
    page.getByText("By starting checkout, you agree to the")
  ).toBeVisible();
  const upgradeMain = page.getByRole("main");
  await expect(
    upgradeMain.getByRole("link", { name: "Terms of Service" })
  ).toBeVisible();
  await expect(
    upgradeMain.getByRole("link", { name: "Privacy Policy" })
  ).toBeVisible();
});
