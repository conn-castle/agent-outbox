import {
  expect,
  test,
  type Locator,
  type Page,
  type Request
} from "@playwright/test";

function rethrowPageError(error: Error) {
  throw error;
}

test.beforeEach(({ page }) => {
  page.on("pageerror", rethrowPageError);
});

test("first-time self-serve signup fixture lands on a provisioned human account", async ({
  page
}) => {
  await page.goto("/human");
  await expect(
    page.getByRole("heading", { name: "Needs review" })
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
    page.getByRole("heading", { name: "Needs review" })
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

test("upgrade billing actions submit checkout intervals and preserve portal", async ({
  page
}) => {
  let checkoutHold = deferred();
  let portalHold = deferred();
  const checkoutRequests: unknown[] = [];
  const portalBodies: Array<string | null> = [];

  await page.route("**/api/billing/checkout", async (route) => {
    expect(route.request().headers()["content-type"]).toContain(
      "application/json"
    );
    checkoutRequests.push(postJson(route.request()));
    await checkoutHold.promise;
    await route.fulfill({
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({
        ok: false,
        error: { message: "Fixture checkout stopped." }
      })
    });
  });
  await page.route("**/api/billing/portal", async (route) => {
    portalBodies.push(route.request().postData());
    await portalHold.promise;
    await route.fulfill({
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({
        ok: false,
        error: { message: "Fixture portal stopped." }
      })
    });
  });

  await page.goto("/upgrade");

  await expect(
    page.getByRole("heading", { name: "Upgrade Agent Outbox" })
  ).toBeVisible();
  const monthlyButton = page.getByRole("button", {
    name: "Start $5/mo checkout"
  });
  const yearlyButton = page.getByRole("button", {
    name: "Start $50/year checkout"
  });
  const portalButton = page.getByRole("button", {
    name: "Open billing portal"
  });
  await expect(monthlyButton).toBeVisible();
  await expect(yearlyButton).toBeVisible();
  await expect(portalButton).toBeVisible();

  await monthlyButton.click();
  await expect.poll(() => checkoutRequests.length).toBe(1);
  expect(checkoutRequests[0]).toEqual({ interval: "monthly" });
  await expect(
    page.getByRole("button", { name: "Starting $5/mo..." })
  ).toBeDisabled();
  await expect(yearlyButton).toBeDisabled();
  await expect(portalButton).toBeDisabled();
  checkoutHold.resolve();
  await expect(page.locator(".form-error")).toContainText(
    "Fixture checkout stopped."
  );

  checkoutHold = deferred();
  await yearlyButton.click();
  await expect.poll(() => checkoutRequests.length).toBe(2);
  expect(checkoutRequests[1]).toEqual({ interval: "yearly" });
  await expect(monthlyButton).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Starting $50/year..." })
  ).toBeDisabled();
  await expect(portalButton).toBeDisabled();
  checkoutHold.resolve();
  await expect(page.locator(".form-error")).toContainText(
    "Fixture checkout stopped."
  );

  portalHold = deferred();
  await portalButton.click();
  await expect.poll(() => portalBodies.length).toBe(1);
  expect(portalBodies[0]).toBeNull();
  await expect(monthlyButton).toBeDisabled();
  await expect(yearlyButton).toBeDisabled();
  await expect(page.getByRole("button", { name: "Opening..." })).toBeDisabled();
  portalHold.resolve();
  await expect(page.locator(".form-error")).toContainText(
    "Fixture portal stopped."
  );
});

test("authenticated review workspace renders content actions and preserves controls across detail navigation", async ({
  page,
  isMobile
}) => {
  await page.goto("/human");

  await expect(
    page.getByRole("heading", { name: "Needs review" })
  ).toBeVisible();
  await expect(page.getByTestId("workspace-hydrated")).toHaveText("hydrated");
  await expect(page.getByLabel("Account status")).toBeVisible();
  await expect(
    page.locator(".review-controls .selection-mode-button")
  ).toBeVisible();
  await expect(page.locator(".compact-selection-button")).toBeHidden();
  if (isMobile) {
    const shellGeometry = await page
      .locator(".human-workspace")
      .evaluate(() => {
        const appBar = document
          .querySelector(".app-bar")!
          .getBoundingClientRect();
        const account = document
          .querySelector(".app-account")!
          .getBoundingClientRect();
        const workspace = document
          .querySelector(".workspace-body")!
          .getBoundingClientRect();
        const search = document
          .querySelector(".review-search")!
          .getBoundingClientRect();
        const filters = document
          .querySelector(".filter-controls")!
          .getBoundingClientRect();
        const selection = document
          .querySelector(".selection-mode-button")!
          .getBoundingClientRect();
        return {
          accountBottom: account.bottom,
          appBarBottom: appBar.bottom,
          filterTop: filters.top,
          searchTop: search.top,
          selectionTop: selection.top,
          workspaceCenter: workspace.left + workspace.width / 2,
          viewportCenter: window.innerWidth / 2
        };
      });
    expect(shellGeometry.accountBottom).toBeLessThanOrEqual(
      shellGeometry.appBarBottom
    );
    expect(shellGeometry.workspaceCenter).toBeCloseTo(
      shellGeometry.viewportCenter,
      0
    );
    expect(shellGeometry.filterTop).toBeGreaterThan(shellGeometry.searchTop);
    expect(shellGeometry.selectionTop).toBeGreaterThan(shellGeometry.filterTop);
  }
  await expect(
    reviewLinkByTitle(page, "Review neighborhood permit brief")
  ).toBeVisible();
  await reviewLinkByTitle(page, "Review neighborhood permit brief").click();
  const detail = page.getByRole("region", { name: "Review detail" });
  await expect(detail.getByText("Confidence")).toBeVisible();
  await expect(detail.getByText("82%")).toBeVisible();
  await expect(detail).toContainText(
    "No source-system action is performed here."
  );
  await expect(
    detail.locator(".detail-meta").getByRole("link", { name: "Open context" })
  ).toHaveAttribute("href", "https://example.com/context/steward-brief-101");
  await expect(detail.locator(".link-buttons")).toHaveCount(0);
  const closeBox = await detail
    .getByRole("link", { name: "Close detail" })
    .boundingBox();
  const stepperBox = await detail
    .getByRole("navigation", { name: "Review navigation" })
    .boundingBox();
  expect(closeBox).not.toBeNull();
  expect(stepperBox).not.toBeNull();
  expect(closeBox?.x ?? 0).toBeGreaterThan(stepperBox?.x ?? 0);
  await expect(
    reviewDecisionSurface(
      page,
      isMobile,
      "Review neighborhood permit brief"
    ).getByRole("button", { name: "Approve" })
  ).toBeEnabled();
  await openSecondaryActions(page);
  await expect(
    page.getByRole("button", { name: "Request edit" })
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Set review lane" })
  ).toBeVisible();

  await page.goto("/human");
  await openReviewTools(page);

  await chooseViewOption(page, "Sort", "Recent");
  await expect(
    reviewLinkByTitle(page, "Payments smoke check failed after deploy")
  ).toBeVisible();
  await chooseViewOption(page, "Sort", "Priority");

  await page
    .locator("article.review-row", {
      has: reviewLinkByTitle(page, "Review neighborhood permit brief")
    })
    .getByRole("button", { name: "Skip" })
    .click();
  await expect(
    page.locator("article.review-row", {
      has: reviewLinkByTitle(page, "Review neighborhood permit brief")
    })
  ).toContainText("skipped");
  await reviewLinkByTitle(page, "Choose follow-up window").click();
  await expect(page).toHaveURL(/item=00000000-0000-4000-8000-000000000512/);
  await expect(page.getByTestId("workspace-hydrated")).toHaveText("hydrated");
  await expect(
    page.getByRole("button", { name: "Pick date", exact: true })
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Pick date and time" })
  ).toBeVisible();

  await page.getByRole("link", { name: "Close detail", exact: true }).click();
  await expect(page.getByTestId("workspace-hydrated")).toHaveText("hydrated");

  await openReviewTools(page);
  await page.getByLabel("Search").fill("follow-up");
  await expect(page.getByLabel("Search")).toHaveValue("follow-up");
  await expect(page).toHaveURL(/search=follow-up/);
  await expect(
    reviewLinkByTitle(page, "Choose follow-up window")
  ).toBeVisible();
  await expect(
    reviewLinkByTitle(page, "Review neighborhood permit brief")
  ).toHaveCount(0);

  await page.getByLabel("Search").fill("");
  await chooseViewOption(page, "Status", "Answered");
  await expect(
    reviewLinkByTitle(page, "GitHub security digest for archived repositories")
  ).toBeVisible();
  await expect(
    reviewLinkByTitle(page, "Review neighborhood permit brief")
  ).toHaveCount(0);
  await reviewLinkByTitle(
    page,
    "GitHub security digest for archived repositories"
  ).click();
  await expect(page).toHaveURL(/item=00000000-0000-4000-8000-000000000517/);
  await expect(page.getByTestId("workspace-hydrated")).toHaveText("hydrated");
  if (isMobile) {
    await page.getByRole("link", { name: "Close detail", exact: true }).click();
    await expect(page.getByTestId("workspace-hydrated")).toHaveText("hydrated");
  }
  await openReviewTools(page);
  await expectViewOption(page, "Status", "Answered");
  await expect(
    reviewLinkByTitle(page, "GitHub security digest for archived repositories")
  ).toBeVisible();
  await expect(
    reviewLinkByTitle(page, "Review neighborhood permit brief")
  ).toHaveCount(0);
});

test("primary navigation and queue disclosures behave consistently", async ({
  page
}) => {
  await page.goto("/human");

  const primary = page.getByRole("navigation", { name: "Primary" });
  await expect(
    primary.getByRole("link", { name: "Review queue" })
  ).toHaveAttribute("aria-current", "page");
  await expect(primary.getByRole("link", { name: "History" })).toHaveAttribute(
    "href",
    /status=answered/
  );

  const unavailableMore = page
    .getByRole("button", { name: /^No more actions for / })
    .first();
  await expect(unavailableMore).toHaveAttribute("aria-disabled", "true");
  await expect(unavailableMore).toHaveAttribute("title", "No more actions");

  const account = page.getByLabel("Account status");
  await account.locator("summary").click();
  await expect(account).toHaveAttribute("open", "");

  const statusDisclosure = page.locator("details.view-select").filter({
    has: page.getByRole("button", { name: /^Status:/ })
  });
  const sortDisclosure = page.locator("details.view-select").filter({
    has: page.getByRole("button", { name: /^Sort:/ })
  });
  await account.locator("summary").click();
  await expect(account).not.toHaveAttribute("open", "");
  await statusDisclosure.locator("summary").click();
  await expect(statusDisclosure).toHaveAttribute("open", "");
  await expect(account).not.toHaveAttribute("open", "");
  await sortDisclosure.locator("summary").click();
  await expect(sortDisclosure).toHaveAttribute("open", "");
  await expect(statusDisclosure).not.toHaveAttribute("open", "");
  await sortDisclosure.locator("summary").click();
  await expect(sortDisclosure).not.toHaveAttribute("open", "");

  const rowDisclosure = page.locator("details.row-overflow").first();
  await rowDisclosure.locator("summary").click();
  await expect(rowDisclosure).toHaveAttribute("open", "");
  await expect(account).not.toHaveAttribute("open", "");

  await page.getByRole("heading", { name: "Needs review" }).click();
  await expect(rowDisclosure).not.toHaveAttribute("open", "");

  const accountSummary = account.locator("summary");
  await accountSummary.click();
  await page.keyboard.press("Escape");
  await expect(account).not.toHaveAttribute("open", "");
  await expect(accountSummary).toBeFocused();
});

test("queue-only workspace keeps pagination visible and rows independently scrollable", async ({
  page
}) => {
  await page.goto("/human?fixture_dataset=pagination&status=all");

  const queue = page.locator(".queue-scroll");
  const pagination = page.getByRole("navigation", { name: "Review pages" });
  await expect(queue).toBeVisible();
  await expect(pagination).toBeVisible();
  await expect
    .poll(() =>
      queue.evaluate((element) => element.scrollHeight > element.clientHeight)
    )
    .toBe(true);
});

test("review rows keep the canonical responsive topology across documented breakpoints", async ({
  page,
  isMobile
}) => {
  test.skip(isMobile, "One desktop browser covers explicit viewport changes");

  await page.goto("/human?status=all");
  const row = reviewRowByTitle(page, "Review neighborhood permit brief");

  await page.setViewportSize({ width: 1024, height: 900 });
  await expect
    .poll(() =>
      row.evaluate((element) => {
        const body = element
          .querySelector(".row-body")!
          .getBoundingClientRect();
        const actions = element
          .querySelector(".row-actions")!
          .getBoundingClientRect();
        return actions.left >= body.right;
      })
    )
    .toBe(true);

  await page.setViewportSize({ width: 768, height: 900 });
  await expect
    .poll(() =>
      row.evaluate((element) => {
        const body = element
          .querySelector(".row-body")!
          .getBoundingClientRect();
        const actions = element
          .querySelector(".row-actions")!
          .getBoundingClientRect();
        return actions.top >= body.bottom;
      })
    )
    .toBe(true);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() =>
      row.evaluate((element) => {
        const visual = element
          .querySelector(".row-context")!
          .getBoundingClientRect();
        const details = element
          .querySelector(".row-details-link")!
          .getBoundingClientRect();
        return Math.abs(
          visual.top + visual.height / 2 - (details.top + details.height / 2)
        );
      })
    )
    .toBeLessThan(2);
});

test("desktop detail modal stays within a readable responsive measure", async ({
  page,
  isMobile
}) => {
  test.skip(isMobile, "Desktop-only modal measure");

  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/human");
  await reviewLinkByTitle(page, "Review neighborhood permit brief").click();
  const detail = page.getByRole("region", { name: "Review detail" });
  await expect.poll(() => elementWidth(detail)).toBeGreaterThanOrEqual(640);
  await expect.poll(() => elementWidth(detail)).toBeLessThanOrEqual(900);
});

test("routine reviews can be completed directly from the queue", async ({
  page
}) => {
  await page.goto("/human");
  await openReviewTools(page);

  await expectViewOption(page, "Status", "Pending");
  await expect(page.getByRole("region", { name: "Review detail" })).toHaveCount(
    0
  );

  const row = page.locator("article.review-row", {
    has: reviewLinkByTitle(page, "Review neighborhood permit brief")
  });
  await expect(
    row.getByRole("group", {
      name: /Quick actions for Review neighborhood permit brief/
    })
  ).toBeVisible();
  await row.getByRole("button", { name: "Approve" }).click();

  await expect(page.getByRole("status")).toContainText(
    "Approve completed for “Review neighborhood permit brief”."
  );
  await expect(page).not.toHaveURL(/item=/);
  await expect(
    page.getByRole("heading", { name: "Needs review" })
  ).toBeVisible();
  await expect(
    reviewLinkByTitle(page, "Review neighborhood permit brief")
  ).toHaveCount(0);

  await page
    .getByRole("navigation", { name: "Primary" })
    .getByRole("link", { name: "History" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Answered reviews" })
  ).toBeVisible();
  await expect(page.getByLabel("Current view summary")).toHaveText(
    /\d+\+?\s*answered/
  );
  await expect(
    reviewLinkByTitle(page, "Review neighborhood permit brief")
  ).toBeVisible();
  await expect(
    reviewRowByTitle(page, "Review neighborhood permit brief")
  ).toContainText("Answered Approve");
});

test("human actions submit undo and narrow bulk actions through server actions", async ({
  page
}) => {
  await page.goto("/human");
  await expect(page.getByTestId("workspace-hydrated")).toHaveText("hydrated");
  await openReviewTools(page);
  await page
    .getByRole("button", { name: /^(Select items|Bulk select)$/ })
    .click();
  const permitRow = reviewRowByTitle(page, "Review neighborhood permit brief");
  const followUpRow = reviewRowByTitle(page, "Choose follow-up window");
  await permitRow.getByRole("checkbox", { name: "Select review" }).check();
  const incompatibleRow = page.locator("article.review-row", {
    has: reviewLinkByTitle(page, "Payments smoke check failed after deploy")
  });
  await incompatibleRow.scrollIntoViewIfNeeded();
  await incompatibleRow
    .getByRole("checkbox", { name: "Select review" })
    .check();
  await expect(page.locator('select[name="bulkActionValue"]')).toBeDisabled();
  await expect(page.getByRole("button", { name: "Apply" })).toBeDisabled();
  await incompatibleRow
    .getByRole("checkbox", { name: "Select review" })
    .uncheck();
  await followUpRow.getByRole("checkbox", { name: "Select review" }).check();
  await page.getByRole("button", { name: "Apply Approve" }).click();
  await expect(page.getByRole("status")).toContainText(
    "Bulk action complete: 2 answered, 0 failed."
  );
  await page
    .getByRole("navigation", { name: "Primary" })
    .getByRole("link", { name: "History" })
    .click();
  await expect(
    reviewRowByTitle(page, "Review neighborhood permit brief")
  ).toContainText("Answered Approve");
  await expect(reviewRowByTitle(page, "Choose follow-up window")).toContainText(
    "Answered Approve"
  );

  await page.goto("/human?item=00000000-0000-4000-8000-000000000517");
  await expect(page.getByLabel("Answered state")).toContainText(
    "Answered with Archive"
  );
  await page.getByRole("button", { name: "Undo answer" }).click();
  await expect(page.getByRole("status")).toContainText(
    "Answer undone before caller read."
  );

  await page.goto("/human?item=00000000-0000-4000-8000-000000000525");
  await expect(
    page.getByRole("button", { name: "Undo unavailable after caller read" })
  ).toBeDisabled();
});

test("failed file upload notice is not re-emitted by the browser", async ({
  page
}) => {
  const events = await interceptClientEvents(page);
  await page.goto("/human?item=00000000-0000-4000-8000-000000000511");

  await openSecondaryActions(page);
  await page.getByRole("button", { name: "Attach evidence" }).click();
  await page.getByLabel("Evidence file").setInputFiles({
    name: "empty.txt",
    mimeType: "text/plain",
    buffer: Buffer.alloc(0)
  });
  await page.getByRole("button", { name: "Attach evidence" }).click();

  await expect(page.getByRole("status")).toContainText(
    "Action failed: invalid request."
  );
  // The regression this guards against emitted from a post-hydration client
  // effect; assert emptiness only after hydration so a reintroduced emission
  // would land before the check and fail it.
  await expect(page.getByTestId("workspace-hydrated")).toHaveText("hydrated");
  await expect.poll(() => events).toEqual([]);
});

test("reviews beyond the first 100 remain discoverable and reviewable", async ({
  page,
  isMobile
}) => {
  await page.goto("/human?fixture_dataset=pagination");
  await expect(page.getByRole("button", { name: "Next 100" })).toBeVisible();
  await page.getByRole("button", { name: "Next 100" }).click();
  await expect(page).toHaveURL(/page=2/);
  await reviewLinkByTitle(page, "Beyond one hundred review").click();
  await expect(
    page.getByRole("region", { name: "Review detail" })
  ).toContainText("Open and approve this item");
  const detail = page.getByRole("region", { name: "Review detail" });
  const decisionSurface = reviewDecisionSurface(
    page,
    isMobile,
    "Beyond one hundred review"
  );
  await expect(
    decisionSurface.getByRole("button", { name: "Approve" })
  ).toBeEnabled();
  await expect(page.getByTestId("workspace-hydrated")).toHaveText("hydrated");

  // Submitting from page 2 must land back on page 2, not a reset view.
  await decisionSurface.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByRole("status")).toContainText(
    "Approve completed for “Beyond one hundred review”."
  );
  await expect(page).toHaveURL(/page=2/);
  await expect(page.getByTestId("workspace-hydrated")).toHaveText("hydrated");

  if (isMobile) {
    await expect(page.getByTestId("workspace-hydrated")).toHaveText("hydrated");
  }
  await openReviewTools(page);
  await page.getByLabel("Search").fill("Beyond one hundred");
  await expect(page).toHaveURL(/search=Beyond\+one\+hundred/);
  await expect(page).not.toHaveURL(/page=2/);
  await expect(
    reviewLinkByTitle(page, "Beyond one hundred review")
  ).toHaveCount(0);

  await page
    .getByRole("navigation", { name: "Primary" })
    .getByRole("link", { name: "History" })
    .click();
  await expect(
    reviewLinkByTitle(page, "Beyond one hundred review")
  ).toBeVisible();
});

test("review search sends one request after the trailing debounce", async ({
  page
}) => {
  await page.clock.install({ time: new Date("2026-07-11T08:00:00Z") });
  await page.goto("/human");
  await expect(page.getByTestId("workspace-hydrated")).toHaveText("hydrated");
  await page.clock.pauseAt(new Date("2026-07-11T10:00:00Z"));
  const searchRequests = trackHumanSearchRequests(page);

  await openReviewTools(page);
  await page.getByLabel("Search").pressSequentially("follow-up");
  expect(searchRequests).toHaveLength(0);
  await page.clock.runFor(299);
  expect(searchRequests).toHaveLength(0);
  await page.clock.runFor(1);

  await expect(page).toHaveURL(/search=follow-up/);
  await expect.poll(() => searchRequests.length).toBe(1);
});

test("Enter and the Search button submit immediately and cancel debounce", async ({
  page
}) => {
  await page.clock.install({ time: new Date("2026-07-11T08:00:00Z") });
  await page.goto("/human");
  await expect(page.getByTestId("workspace-hydrated")).toHaveText("hydrated");
  await page.clock.pauseAt(new Date("2026-07-11T10:00:00Z"));
  const searchRequests = trackHumanSearchRequests(page);
  await openReviewTools(page);
  const searchInput = page.getByLabel("Search");

  await searchInput.fill("follow-up");
  await searchInput.press("Enter");
  await expect(page).toHaveURL(/search=follow-up/);
  await expect.poll(() => searchRequests.length).toBe(1);
  await page.clock.runFor(300);
  expect(searchRequests).toHaveLength(1);

  await page.getByLabel("Search").fill("neighborhood permit");
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page).toHaveURL(/search=neighborhood\+permit/);
  await expect.poll(() => searchRequests.length).toBe(2);
  await page.clock.runFor(300);
  expect(searchRequests).toHaveLength(2);

  await page.getByLabel("Search").fill("summary");
  await chooseViewOption(page, "Status", "Answered");
  await expect(page).toHaveURL(/search=summary/);
  await expect(page).toHaveURL(/status=answered/);
  await expect.poll(() => searchRequests.length).toBe(3);
  await page.clock.runFor(300);
  expect(searchRequests).toHaveLength(3);
});

test("uncaught browser error emits a content-safe client event", async ({
  page
}) => {
  page.off("pageerror", rethrowPageError);
  const events = await interceptClientEvents(page);
  await page.goto("/human");
  await expect(page.getByTestId("workspace-hydrated")).toHaveText("hydrated");

  await page.evaluate(() => {
    window.dispatchEvent(
      new ErrorEvent("error", { error: new Error("fixture browser failure") })
    );
  });

  await expect
    .poll(() => events)
    .toEqual([{ name: "client_error", category: "browser_exception" }]);
});

test("bulk actions only submit selected rows visible in the current filter", async ({
  page
}) => {
  await page.goto("/human");
  await expect(page.getByTestId("workspace-hydrated")).toHaveText("hydrated");
  await openReviewTools(page);

  await page
    .getByRole("button", { name: /^(Select items|Bulk select)$/ })
    .click();
  await reviewRowByTitle(page, "Review neighborhood permit brief")
    .getByRole("checkbox", { name: "Select review" })
    .check();
  await reviewRowByTitle(page, "Choose follow-up window")
    .getByRole("checkbox", { name: "Select review" })
    .check();
  await expect(page.locator(".bulk-actions")).toContainText(
    "2 selected pending rows"
  );

  await openReviewTools(page);
  await page.getByLabel("Search").fill("follow-up");
  await expect(page.locator(".bulk-actions")).toContainText(
    "1 selected pending row"
  );
  await page.getByRole("button", { name: "Apply Approve" }).click();
  await expect(page.getByRole("status")).toContainText(
    "Bulk action complete: 1 answered, 0 failed."
  );
});

function reviewRowByTitle(page: Page, title: string) {
  return page.locator("article.review-row", {
    has: reviewLinkByTitle(page, title)
  });
}

function reviewLinkByTitle(page: Page, title: string) {
  return page.getByRole("link", {
    name: `Open review details for ${title}`
  });
}

function reviewDecisionSurface(page: Page, isMobile: boolean, title: string) {
  void isMobile;
  void title;
  return page.getByRole("region", { name: "Review detail" });
}

async function elementWidth(locator: Locator) {
  return locator.evaluate((element) =>
    Math.round(element.getBoundingClientRect().width)
  );
}

async function dragHorizontally(page: Page, locator: Locator, delta: number) {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  if (!box) return;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + delta, y);
  await page.mouse.up();
}

function deferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((innerResolve) => {
    resolve = () => innerResolve();
  });
  return { promise, resolve };
}

function postJson(request: Request) {
  const body = request.postData();
  return body ? JSON.parse(body) : null;
}

function trackHumanSearchRequests(page: Page) {
  const requests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/human" && url.searchParams.has("search")) {
      requests.push(url.toString());
    }
  });
  return requests;
}

async function openReviewTools(page: Page) {
  const button = page.getByRole("button", { name: "Review tools" });
  if ((await button.count()) === 0 || !(await button.isVisible())) {
    return;
  }
  if ((await button.getAttribute("aria-expanded")) !== "true") {
    await button.click();
  }
}

async function chooseViewOption(
  page: Page,
  label: "Status" | "Sort",
  option: string
) {
  await page.getByRole("button", { name: new RegExp(`^${label}:`) }).click();
  await page
    .getByRole("menu", { name: label })
    .getByRole("menuitemradio", { name: option })
    .click();
}

async function expectViewOption(
  page: Page,
  label: "Status" | "Sort",
  option: string
) {
  await expect(
    page.getByRole("button", { name: `${label}: ${option}` })
  ).toBeVisible();
}

async function openSecondaryActions(page: Page) {
  const disclosure = page.locator(".detail-pane .secondary-actions > summary");
  const open = await disclosure.evaluate(
    (summary) => (summary.parentElement as HTMLDetailsElement).open
  );
  if (!open) {
    await disclosure.click();
  }
}

async function interceptClientEvents(page: Page) {
  const events: Array<{ name: string; category?: string }> = [];
  await page.route("**/api/client-events", async (route) => {
    const body = postJson(route.request());
    if (body && Array.isArray(body.events)) {
      events.push(
        ...body.events.map((event: { name: string; category?: string }) => ({
          name: event.name,
          category: event.category
        }))
      );
    }
    await route.fulfill({ status: 204, body: "" });
  });
  return events;
}

test("popup controls cover typed response kinds", async ({ page }) => {
  await page.goto("/human?item=00000000-0000-4000-8000-000000000511");

  await openSecondaryActions(page);
  await page.getByRole("button", { name: "Attach evidence" }).click();
  await expect(page.locator(".file-drop-target")).toContainText(
    "Drop a file here"
  );
  await page.getByLabel("Evidence file").setInputFiles({
    name: "evidence.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("browser fixture file")
  });
  await page.getByRole("button", { name: "Attach evidence" }).click();
  await expect(page.getByRole("status")).toContainText(
    "Attach evidence completed"
  );

  await page.goto("/human?item=00000000-0000-4000-8000-000000000511");

  await openSecondaryActions(page);
  await page.getByRole("button", { name: "Request edit" }).click();
  await page
    .getByLabel("Requested change")
    .fill("Tighten the handoff language.");
  await page.getByRole("button", { name: "Request edit" }).click();
  await expect(page.getByRole("status")).toContainText(
    "Request edit completed"
  );

  await page.goto("/human?item=00000000-0000-4000-8000-000000000511");
  await openSecondaryActions(page);
  await page.getByRole("button", { name: "Set review lane" }).click();
  await page.getByLabel("Operations").check();
  await page.getByRole("button", { name: "Set review lane" }).click();
  await expect(page.getByRole("status")).toContainText(
    "Set review lane completed"
  );

  await page.goto("/human?item=00000000-0000-4000-8000-000000000512");
  await page.getByRole("button", { name: "Pick date", exact: true }).click();
  await page.getByLabel("Follow-up date").fill("2026-07-15");
  await page.getByRole("button", { name: "Pick date" }).click();
  await expect(page.getByRole("status")).toContainText("Pick date completed");

  await page.goto("/human?item=00000000-0000-4000-8000-000000000512");
  await page.getByRole("button", { name: "Pick date and time" }).click();
  await page.getByLabel("Follow-up instant").fill("2026-07-16T09:30");
  await page.getByRole("button", { name: "Pick date and time" }).click();
  await expect(page.getByRole("status")).toContainText(
    "Pick date and time completed"
  );

  await page.goto("/human?item=00000000-0000-4000-8000-000000000512");
  await page.getByRole("button", { name: "Select checks" }).click();
  await page.getByLabel("Facts reviewed").check();
  await page.getByLabel("Tone reviewed").check();
  await page.getByRole("button", { name: "Select checks" }).click();
  await expect(page.getByRole("status")).toContainText(
    "Select checks completed"
  );
});

test("row popup actions open a focused composer instead of the full detail", async ({
  page
}) => {
  await page.goto("/human");
  await reviewRowByTitle(page, "Choose follow-up window")
    .getByRole("link", { name: "Pick date", exact: true })
    .click();

  await expect(page).toHaveURL(/compose=pick_date/);
  const detail = page.getByRole("region", { name: "Review detail" });
  const field = detail.getByLabel("Follow-up date");
  await expect(field).toBeVisible();
  await expect(detail.getByText("Review summary")).toHaveCount(0);
  await expect(
    detail.getByRole("navigation", { name: "Review navigation" })
  ).toHaveCount(0);

  await field.fill("2026-07-20");
  const paneBox = await detail.boundingBox();
  expect(paneBox).not.toBeNull();
  await page.mouse.move(paneBox!.x + paneBox!.width / 2, paneBox!.y + 24);
  await page.mouse.down();
  await page.mouse.move(8, 8);
  await page.mouse.up();
  await expect(page).toHaveURL(/compose=pick_date/);
  await expect(field).toHaveValue("2026-07-20");
});

test("canonical row visuals and popup constraints expose only supported semantics", async ({
  page,
  isMobile
}) => {
  await page.goto("/human?status=all");

  const numericRow = reviewRowByTitle(page, "Review neighborhood permit brief");
  await expect(numericRow.locator(".numeric-bar")).not.toHaveAttribute(
    "class",
    /signal|risk/
  );
  await expect(numericRow.locator(".bar-fill")).toHaveCSS(
    "background-color",
    "rgb(108, 105, 96)"
  );
  await expect(numericRow.getByText("Urgent priority")).toHaveText(
    "Urgent priority"
  );
  await expect(numericRow.locator(".row-link")).toHaveJSProperty(
    "tagName",
    "DIV"
  );
  await expect(numericRow.locator(".row-summary-link")).toHaveJSProperty(
    "tagName",
    "DIV"
  );

  const uncoloredRow = reviewRowByTitle(
    page,
    "Which cost denominator should the benchmark use?"
  );
  await expect
    .poll(() =>
      uncoloredRow.evaluate((element) =>
        getComputedStyle(element).getPropertyValue("--row-accent").trim()
      )
    )
    .toBe("#7a746c");

  const progressRow = reviewRowByTitle(page, "Choose follow-up window");
  await expect(progressRow.locator(".ring svg")).toHaveCount(0);
  await expect(progressRow.locator(".visual-unit")).toHaveText("checks");

  const pillRow = reviewRowByTitle(
    page,
    "Reply to Meridian about the renewal delay"
  );
  await expect(pillRow.locator(".pill-visual > strong")).toHaveText(
    "External · 3"
  );
  await expect(pillRow.locator(".pill-visual")).not.toContainText("Signal");

  const fallbackRow = reviewRowByTitle(
    page,
    "Confirm the electrician’s arrival window"
  );
  await expect(fallbackRow.locator(".product-fallback-meta")).toBeVisible();

  if (isMobile) {
    await expect(progressRow.locator(".row-subtitle")).toHaveCSS(
      "-webkit-line-clamp",
      "2"
    );
  }

  await page.goto("/human?item=00000000-0000-4000-8000-000000000521");
  await page.getByRole("button", { name: "Choose category" }).click();
  await expect(
    page.locator('input[name="response.value"]:checked')
  ).toHaveCount(0);

  await page.goto("/human?item=00000000-0000-4000-8000-000000000512");
  await page.getByRole("button", { name: "Pick date and time" }).click();
  const datetime = page.getByLabel("Follow-up instant");
  await expect(datetime).toHaveAttribute("min", "2026-07-01T00:00");
  await expect(datetime).toHaveAttribute("max", "2026-07-31T23:59");
  await expect(datetime).toHaveAttribute("aria-describedby", /.+/);
  await expect(page.getByText("UTC datetime", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Close action" }).click();

  await page.getByRole("button", { name: "Select checks" }).click();
  const multiSubmit = page.getByRole("button", {
    name: "Select checks"
  });
  await expect(page.getByText("Choose 1 to 2. 0 selected.")).toBeVisible();
  await expect(multiSubmit).toBeDisabled();
  await page.getByLabel("Facts reviewed").check();
  await expect(multiSubmit).toBeEnabled();
  await page.getByLabel("Tone reviewed").check();
  await expect(page.getByLabel("Sources reviewed")).toBeDisabled();

  await expect(
    page
      .getByRole("region", { name: "Review detail" })
      .getByText("Details", { exact: true })
  ).toBeVisible();
});

test("queue More menu lists caller overflow actions", async ({ page }) => {
  await page.goto("/human?status=all");
  const row = reviewRowByTitle(page, "Review neighborhood permit brief");
  await row.locator("details.row-overflow > summary").click();
  const menu = row.locator(".row-overflow-menu");
  await expect(menu.getByRole("link", { name: "Request edit" })).toBeVisible();
  await expect(
    menu.getByRole("link", { name: "Attach evidence" })
  ).toBeVisible();
  await expect(
    menu.getByRole("link", { name: "Set review lane" })
  ).toBeVisible();
  await expect(menu.getByText("Review remaining outcomes")).toHaveCount(0);

  await menu.getByRole("link", { name: "Request edit" }).click();
  await expect(page).toHaveURL(/compose=request_edit/);
  await expect(
    page.getByRole("dialog", { name: "Request edit" })
  ).toBeVisible();
});

test("queue J and K move between rows and Enter opens details", async ({
  page
}) => {
  await page.goto("/human?status=all");
  const rows = page.locator(".review-list .row-link");
  await expect(rows.first()).toBeVisible();

  await page.keyboard.press("j");
  await expect(rows.first()).toBeFocused();

  await page.keyboard.press("j");
  await expect(rows.nth(1)).toBeFocused();

  await page.keyboard.press("k");
  await expect(rows.first()).toBeFocused();

  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/item=/);
  await expect(page.getByRole("dialog")).toBeVisible();
});

test("queue J does not steal typing from search or move past the last row", async ({
  page
}) => {
  await page.goto("/human?status=all");
  await openReviewTools(page);
  const search = page.getByLabel("Search");
  await search.click();
  await page.keyboard.press("j");
  await expect(search).toHaveValue("j");
  await expect(
    page.locator(".review-list .row-link").first()
  ).not.toBeFocused();

  await page.goto("/human?status=all");
  const rows = page.locator(".review-list .row-link");
  await expect(rows.first()).toBeVisible();
  const count = await rows.count();
  await rows.last().focus();
  await page.keyboard.press("j");
  await expect(rows.nth(count - 1)).toBeFocused();
});

test("mobile review navigation preserves the queue view", async ({
  page,
  isMobile
}) => {
  test.skip(!isMobile, "Mobile-only navigation contract");

  await page.goto("/human?status=pending&sort=updated_at");
  await expect(
    page.getByRole("region", { name: "Queue browser" })
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Review detail" })
  ).toBeHidden();

  await reviewLinkByTitle(page, "Review neighborhood permit brief").click();
  await expect(
    page.getByRole("region", { name: "Review detail" })
  ).toBeVisible();
  await page.getByRole("link", { name: "Close detail", exact: true }).click();

  await expect(page).toHaveURL(/sort=updated_at/);
  await expectViewOption(page, "Status", "Pending");
  await expect(
    page.getByRole("region", { name: "Queue browser" })
  ).toBeVisible();
});

test("deployment fixture renders hostile caller content inertly", async ({
  page
}) => {
  await page.goto("/human?item=00000000-0000-4000-8000-000000000523");

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
    page.getByRole("link", { name: "Blocked unsafe link" })
  ).toHaveCount(0);
  await openSecondaryActions(page);
  await expect(
    detail.getByRole("button", { name: "Unavailable upload" })
  ).toBeDisabled();

  const securityRow = page.locator("article.review-row", {
    has: page.locator('a[href*="item=00000000-0000-4000-8000-000000000523"]')
  });
  await expect(securityRow.locator(".review-accent")).toHaveCount(0);
  await expect(securityRow).not.toHaveAttribute("style", /url\(/i);
  await expect(detail.locator(".ring")).not.toHaveAttribute(
    "style",
    /caller-controlled/i
  );
  await expect(
    detail.getByText(/api key|manual key|archive|gmail/i)
  ).toHaveCount(0);
});

test("fixture storyboard catalogs every use case at desktop tablet and phone widths", async ({
  page,
  isMobile
}) => {
  test.skip(isMobile, "The storyboard itself is verified once on desktop.");

  await page.goto("/human/storyboard");
  await expect(
    page.getByRole("heading", { name: "Review neighborhood permit brief" })
  ).toBeVisible();
  await expect(page.getByText("10 review scenarios")).toBeVisible();
  for (const useCase of [
    "Email draft approval",
    "Email archive labeling",
    "LinkedIn connection request approval",
    "X post draft approval",
    "Financial categorization judgment",
    "Answer ambiguity without watching the run",
    "Resolve a failed automated check",
    "SMS reply and scheduling"
  ]) {
    await expect(
      page.getByRole("link", { name: new RegExp(useCase) })
    ).toBeVisible();
  }

  const frames = page.locator(".storyboard-viewport iframe");
  await expect(frames).toHaveCount(3);
  await expect(frames.nth(0)).toHaveAttribute("width", "1440");
  await expect(frames.nth(1)).toHaveAttribute("width", "834");
  await expect(frames.nth(2)).toHaveAttribute("width", "390");
  await expect(
    frames
      .nth(0)
      .contentFrame()
      .locator(".detail-pane")
      .getByText("Review neighborhood permit brief", { exact: true })
  ).toBeVisible();

  await page.getByRole("link", { name: /Email draft approval/ }).click();
  await expect(
    page.getByRole("heading", {
      name: "Reply to Meridian about the renewal delay"
    })
  ).toBeVisible();
  await expect(
    frames
      .nth(0)
      .contentFrame()
      .locator(".detail-pane")
      .getByText("Reply to Meridian about the renewal delay", { exact: true })
  ).toBeVisible();
  await expect(page.getByText("default text", { exact: true })).toBeVisible();

  await page.getByRole("link", { name: "Queue", exact: true }).click();
  await expect(page).toHaveURL(/mode=queue/);
  await expect(frames.nth(0)).toHaveAttribute(
    "src",
    /search=email%3Adraft%3Ameridian-renewal/
  );
});
