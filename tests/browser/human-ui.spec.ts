import { expect, test } from "@playwright/test";

test.beforeEach(({ page }) => {
  page.on("pageerror", (error) => {
    throw error;
  });
});

test("first-time self-serve signup fixture lands on a provisioned human account", async ({
  page
}) => {
  await page.goto("/human");
  await expect(
    page.getByRole("heading", { name: "Review queue" })
  ).toBeVisible();
  const existingAccountId = await page
    .getByTestId("fixture-account-id")
    .textContent();
  const existingOwnerMembership = await page
    .getByTestId("owner-membership")
    .locator("strong")
    .textContent();
  await expect(page.getByTestId("provisioned-account")).toHaveText("no");

  await page.goto("/sign-up");

  await expect(
    page.getByRole("heading", { name: "Browser fixture signup" })
  ).toBeVisible();
  const signupLink = page.getByRole("link", { name: "Create test account" });
  const signupHref = await signupLink.getAttribute("href");
  expect(signupHref).not.toBeNull();
  const providerSubject = new URL(
    signupHref ?? "",
    "http://browser-fixture.test"
  ).searchParams.get("fixture_provider_subject");
  expect(providerSubject).toBeTruthy();
  await signupLink.click();

  await expect(page).toHaveURL(/\/human/);
  await expect(
    page.getByRole("heading", { name: "Review queue" })
  ).toBeVisible();
  await expect(page.getByTestId("provisioned-account")).toHaveText("yes");
  await expect(page.getByTestId("fixture-account-id")).not.toHaveText(
    existingAccountId ?? ""
  );
  await expect(
    page.getByTestId("owner-membership").locator("strong")
  ).not.toHaveText(existingOwnerMembership?.trim() ?? "");
  await expect(page.getByLabel("Account status")).toContainText(
    providerSubject ?? ""
  );
});

test("authenticated review workspace renders content actions and preserves controls across detail navigation", async ({
  page
}) => {
  await page.goto("/human");

  await expect(
    page.getByRole("heading", { name: "Review queue" })
  ).toBeVisible();
  await expect(page.getByTestId("workspace-hydrated")).toHaveText("hydrated");
  await expect(
    page.getByRole("link", { name: /Review neighborhood permit brief/ })
  ).toBeVisible();
  const detail = page.getByRole("region", { name: "Review detail" });
  await expect(detail.getByText("Confidence")).toBeVisible();
  await expect(detail.getByText("82%")).toBeVisible();
  await expect(detail).toContainText(
    "No source-system action is performed here."
  );
  await expect(
    page.getByRole("link", { name: "Open context" })
  ).toHaveAttribute("href", "https://example.com/context/steward-brief-101");
  await expect(page.getByRole("button", { name: "Approve" })).toBeEnabled();
  await expect(page.getByText("free text")).toBeVisible();
  await expect(page.getByText("single select")).toBeVisible();

  await page.getByRole("combobox", { name: "Sort" }).selectOption("updated_at");
  await expect(
    page.getByRole("list", { name: "Review queue" }).getByRole("link").first()
  ).toContainText("Review neighborhood permit brief");
  await page.getByRole("combobox", { name: "Sort" }).selectOption("priority");

  await page.getByRole("button", { name: "Skip" }).first().click();
  await expect(
    page.getByRole("list", { name: "Review queue" }).getByRole("link").first()
  ).toContainText("Choose follow-up window");
  await page.getByRole("link", { name: /Choose follow-up window/ }).click();
  await expect(page).toHaveURL(/item=00000000-0000-4000-8000-000000000512/);
  await expect(page.getByTestId("workspace-hydrated")).toHaveText("hydrated");
  await expect(
    page.getByRole("list", { name: "Review queue" }).getByRole("link").first()
  ).toContainText("Choose follow-up window");
  await expect(
    page.locator("article.review-row", {
      has: page.getByRole("link", {
        name: /Review neighborhood permit brief/
      })
    })
  ).toContainText("skipped");
  await expect(page.getByText("Displayed timezone: UTC")).toHaveCount(2);

  await page.getByLabel("Search").fill("follow-up");
  await expect(page.getByLabel("Search")).toHaveValue("follow-up");
  await expect(
    page.getByRole("link", { name: /Choose follow-up window/ })
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: /Review neighborhood permit brief/ })
  ).toHaveCount(0);

  await page.getByLabel("Search").fill("");
  await page.getByRole("combobox", { name: "Status" }).selectOption("answered");
  await expect(
    page.getByRole("link", { name: /Answered summary verification/ })
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: /Review neighborhood permit brief/ })
  ).toHaveCount(0);
  await page
    .getByRole("link", { name: /Answered summary verification/ })
    .click();
  await expect(page).toHaveURL(/item=00000000-0000-4000-8000-000000000513/);
  await expect(page.getByTestId("workspace-hydrated")).toHaveText("hydrated");
  await expect(page.getByRole("combobox", { name: "Status" })).toHaveValue(
    "answered"
  );
  await expect(
    page.getByRole("link", { name: /Answered summary verification/ })
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: /Review neighborhood permit brief/ })
  ).toHaveCount(0);
});

test("human actions submit undo and narrow bulk actions through server actions", async ({
  page
}) => {
  await page.goto("/human");

  await page.getByRole("button", { name: "Approve" }).first().click();
  await expect(page.getByRole("status")).toContainText(
    "Answer submitted: approve."
  );

  await page.goto("/human");
  const rows = page.locator(".review-row");
  await rows.nth(0).getByRole("checkbox", { name: "Select review" }).check();
  await expect(rows.nth(2)).toContainText("Renderer boundary probe");
  await rows.nth(2).getByRole("checkbox", { name: "Select review" }).check();
  await expect(page.locator('select[name="bulkActionValue"]')).toBeDisabled();
  await expect(page.getByRole("button", { name: "Apply" })).toBeDisabled();
  await rows.nth(2).getByRole("checkbox", { name: "Select review" }).uncheck();
  await rows.nth(1).getByRole("checkbox", { name: "Select review" }).check();
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page.getByRole("status")).toContainText(
    "Bulk action complete: 2 answered, 0 failed."
  );

  await page.goto("/human?item=00000000-0000-4000-8000-000000000513");
  await expect(page.getByLabel("Answered state")).toContainText(
    "Answered with approve"
  );
  await page.getByRole("button", { name: "Undo answer" }).click();
  await expect(page.getByRole("status")).toContainText(
    "Answer undone before caller read."
  );

  await page.goto("/human?item=00000000-0000-4000-8000-000000000514");
  await expect(
    page.getByRole("button", { name: "Undo unavailable after caller read" })
  ).toBeDisabled();
});

test("bulk actions only submit selected rows visible in the current filter", async ({
  page
}) => {
  await page.goto("/human");

  const rows = page.locator(".review-row");
  await rows.nth(0).getByRole("checkbox", { name: "Select review" }).check();
  await rows.nth(1).getByRole("checkbox", { name: "Select review" }).check();
  await expect(page.locator(".bulk-actions")).toContainText(
    "2 selected pending rows"
  );

  await page.getByLabel("Search").fill("follow-up");
  await expect(page.locator(".bulk-actions")).toContainText(
    "1 selected pending row"
  );
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page.getByRole("status")).toContainText(
    "Bulk action complete: 1 answered, 0 failed."
  );
});

test("popup controls cover typed response kinds", async ({ page }) => {
  await page.goto("/human?item=00000000-0000-4000-8000-000000000511");

  await page.getByLabel("Evidence file").setInputFiles({
    name: "evidence.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("browser fixture file")
  });
  await page.getByRole("button", { name: "Attach evidence" }).click();
  await expect(page.getByRole("status")).toContainText(
    "Answer submitted: attach_evidence."
  );

  await page.goto("/human?item=00000000-0000-4000-8000-000000000511");

  await page
    .getByLabel("Requested change")
    .fill("Tighten the handoff language.");
  await page.getByRole("button", { name: "Request edit" }).click();
  await expect(page.getByRole("status")).toContainText(
    "Answer submitted: request_edit."
  );

  await page.goto("/human?item=00000000-0000-4000-8000-000000000511");
  await page.getByLabel("Operations").check();
  await page.getByRole("button", { name: "Set review lane" }).click();
  await expect(page.getByRole("status")).toContainText(
    "Answer submitted: set_lane."
  );

  await page.goto("/human?item=00000000-0000-4000-8000-000000000512");
  await page.getByLabel("Follow-up date").fill("2026-07-15");
  await page.getByRole("button", { name: "Pick date", exact: true }).click();
  await expect(page.getByRole("status")).toContainText(
    "Answer submitted: pick_date."
  );

  await page.goto("/human?item=00000000-0000-4000-8000-000000000512");
  await page.getByLabel("Follow-up instant").fill("2026-07-16T09:30");
  await page.getByRole("button", { name: "Pick date and time" }).click();
  await expect(page.getByRole("status")).toContainText(
    "Answer submitted: pick_datetime."
  );

  await page.goto("/human?item=00000000-0000-4000-8000-000000000512");
  await page.getByLabel("Facts reviewed").check();
  await page.getByLabel("Tone reviewed").check();
  await page.getByRole("button", { name: "Select checks" }).click();
  await expect(page.getByRole("status")).toContainText(
    "Answer submitted: select_checks."
  );
});

test("security fixture renders hostile caller content inertly", async ({
  page
}) => {
  await page.goto("/human?item=00000000-0000-4000-8000-000000000515");

  const detail = page.getByRole("region", { name: "Review detail" });
  await expect(detail).toContainText("fixtureUnsafeScript()");
  await expect(detail).toContainText("<CallerInjectedWidget />");
  await expect(
    detail.locator('script:has-text("fixtureUnsafeScript")')
  ).toHaveCount(0);
  await expect(detail.locator("foreignObject")).toHaveCount(0);
  await expect(
    detail.locator('video[src="https://example.com/movie.mp4"]')
  ).toHaveCount(0);
  await expect(
    detail.locator('form[action="https://example.com"]')
  ).toHaveCount(0);
  await expect(detail.locator("caller-injected-widget")).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "Blocked javascript link" })
  ).toHaveCount(0);
  await expect(
    detail.getByRole("button", { name: "Attach file" })
  ).toBeDisabled();
  await expect(detail.getByText("file upload", { exact: true })).toBeVisible();

  const securityRow = page.locator("article.review-row", {
    has: page.getByRole("link", { name: /Renderer boundary probe/ })
  });
  await expect(securityRow.locator(".review-accent")).not.toHaveAttribute(
    "style",
    /url\(/i
  );
  await expect(detail.locator(".pill-visual")).not.toHaveAttribute(
    "style",
    /var\(/i
  );
  await expect(page.getByText(/api key|manual key|archive|gmail/i)).toHaveCount(
    0
  );
});
