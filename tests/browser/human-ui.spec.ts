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

test("account popup identifies the user, shows free usage, and links to upgrade", async ({
  page,
  isMobile
}) => {
  await page.goto("/human?fixture_plan=free");
  await page.getByLabel("Account status").locator("summary").click();

  const popup = page.locator(".account-popover");
  await expect(popup).toBeVisible();
  await expect(popup).toContainText("Alex Morgan");
  await expect(popup).toContainText("alex@example.com");
  await expect(popup).toContainText("GitHub");
  await expect(popup).toContainText("Free");
  await expect(popup).toContainText("184 of 5,000");
  await expect(popup).toContainText("4,628 of 100,000");
  await expect(popup).toContainText("1.3 MB of 32 MB");
  await expect(popup.getByRole("link", { name: "Upgrade" })).toHaveAttribute(
    "href",
    "/upgrade"
  );
  await expect(popup.getByRole("link", { name: "Sign out" })).toHaveAttribute(
    "href",
    "/sign-out"
  );
  await expect(popup.locator(".account-usage-track")).toHaveCount(0);
  const closeButton = popup.getByRole("button", { name: "Close account menu" });
  const backdrop = page.getByRole("button", { name: "Dismiss account menu" });
  if (isMobile) {
    await expect(closeButton).toBeVisible();
    await expect(backdrop).toBeVisible();
    const urlBefore = page.url();
    const viewport = page.viewportSize();
    await backdrop.click({
      position: {
        x: 8,
        y: Math.floor((viewport?.height ?? 800) / 2)
      }
    });
    await expect(popup).toBeHidden();
    await expect(page).toHaveURL(urlBefore);
    const accountSummary = page.getByLabel("Account status").locator("summary");
    await accountSummary.click();
    await expect(popup).toBeVisible();
    await accountSummary.click();
    await expect(popup).toBeHidden();
    await accountSummary.click();
    await expect(popup).toBeVisible();
    await closeButton.click();
    await expect(popup).toBeHidden();
  } else {
    await expect(closeButton).toBeHidden();
    await expect(backdrop).toBeHidden();
  }
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
  if (isMobile) {
    await expect(
      page.locator(".review-controls .selection-mode-button")
    ).toBeHidden();
    await expect(page.locator(".compact-selection-button")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Review tools" })
    ).toBeVisible();
    await expect(page.locator(".review-controls")).toBeHidden();
    await openReviewTools(page);
    await expect(page.locator(".review-controls")).toBeVisible();
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
        const tools = document
          .querySelector(".mobile-tools-button")!
          .getBoundingClientRect();
        const selection = document
          .querySelector(".compact-selection-button")!
          .getBoundingClientRect();
        return {
          accountBottom: account.bottom,
          appBarBottom: appBar.bottom,
          filterTop: filters.top,
          searchTop: search.top,
          toolsTop: tools.top,
          toolsBottom: tools.bottom,
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
    expect(shellGeometry.selectionTop).toBeCloseTo(shellGeometry.toolsTop, 0);
    expect(shellGeometry.searchTop).toBeGreaterThan(shellGeometry.toolsBottom);
  } else {
    await expect(
      page.locator(".review-controls .selection-mode-button")
    ).toBeVisible();
    await expect(page.locator(".compact-selection-button")).toBeHidden();
  }
  await expect(
    reviewLinkByTitle(page, "Review neighborhood permit brief")
  ).toBeVisible();
  await reviewLinkByTitle(page, "Review neighborhood permit brief").click();
  const detail = page.getByRole("region", { name: "Review detail" });
  await expect(detail.getByText("Confidence")).toBeVisible();
  await expect(detail.getByText("82%")).toBeVisible();
  await expect(detail).not.toContainText("82%%");
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
    ).getByRole("button", { name: "Approve permit brief" })
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

  await choosePrimarySort(page, "Last updated");
  await expect(
    reviewLinkByTitle(page, "Payments smoke check failed after deploy")
  ).toBeVisible();
  await choosePrimarySort(page, "Priority");

  await reviewRowByTitle(page, "Review neighborhood permit brief")
    .getByRole("button", { name: "Defer" })
    .click();
  await expect(
    reviewRowByTitle(page, "Review neighborhood permit brief")
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
  await expect(page).not.toHaveURL(/item=/);
  await expect(page.getByTestId("workspace-hydrated")).toHaveText("hydrated");

  await openReviewTools(page);
  await page.getByRole("textbox", { name: "Search" }).fill("follow-up");
  await expect(page.getByRole("textbox", { name: "Search" })).toHaveValue(
    "follow-up"
  );
  await expect(page).toHaveURL(/search=follow-up/);
  await expect(
    reviewLinkByTitle(page, "Choose follow-up window")
  ).toBeVisible();
  await expect(
    reviewLinkByTitle(page, "Review neighborhood permit brief")
  ).toHaveCount(0);

  await page.getByRole("textbox", { name: "Search" }).fill("");
  await page.getByRole("link", { name: "History" }).click();
  await expect(page).not.toHaveURL(/search=/);
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
  await expect(page.getByRole("link", { name: "History" })).toHaveAttribute(
    "aria-current",
    "page"
  );
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

  await account.locator("summary").click();
  await expect(account).not.toHaveAttribute("open", "");
  await openReviewTools(page);
  const sortTrigger = page.getByLabel("Sort: Priority");
  await sortTrigger.click();
  await expect(sortTrigger).toHaveAttribute("aria-expanded", "true");
  await expect(
    page.getByRole("dialog", { name: "Sort reviews" })
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(sortTrigger).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("dialog", { name: "Sort reviews" })).toHaveCount(
    0
  );
  await expect(sortTrigger).toBeFocused();

  await sortTrigger.click();
  const sortScrim = page.getByRole("button", { name: "Dismiss sort panel" });
  if (await sortScrim.isVisible()) {
    await sortScrim.click();
  } else {
    await page.getByRole("heading", { name: "Needs review" }).click();
  }
  await expect(sortTrigger).toHaveAttribute("aria-expanded", "false");

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

test("review queue and history remain disjoint", async ({ page }) => {
  await page.goto("/human?status=all");

  await expect(
    page.getByRole("heading", { name: "Needs review" })
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /^Status:/ })).toHaveCount(0);
  await expect(
    reviewLinkByTitle(page, "GitHub security digest for archived repositories")
  ).toHaveCount(0);

  const queueRows = page.locator("article.review-row");
  await expect(queueRows).toHaveCount(8);
  await expect(queueRows.locator(".inline-actions")).toHaveCount(8);

  await page.getByRole("link", { name: "History" }).click();
  await expect(
    page.getByRole("heading", { name: "Answered reviews" })
  ).toBeVisible();
  await expect(page.locator("article.review-row")).toHaveCount(2);
  await expect(page.locator(".inline-actions")).toHaveCount(0);
  await expect(page.locator(".row-actions")).toHaveCount(2);
  await expect(page.locator(".row-actions").first()).toBeHidden();
  await expect(
    page.getByRole("link", { name: "Return to review queue" })
  ).toBeVisible();
  await expect(
    reviewLinkByTitle(page, "Review neighborhood permit brief")
  ).toHaveCount(0);
});

test("queue-only workspace keeps pagination visible and rows independently scrollable", async ({
  page
}) => {
  await page.goto("/human?fixture_dataset=pagination");

  const queue = page.locator(".queue-scroll");
  const pagination = page.getByRole("navigation", { name: "Review pages" });
  await expect(queue).toBeVisible();
  await expect(pagination).toBeVisible();
  await expect(page.getByLabel("Current view summary")).toHaveText(
    /100\s*shown/
  );
  await expect(page.getByLabel("Current view summary")).not.toContainText(
    "of 100 remaining"
  );
  await expect
    .poll(() =>
      queue.evaluate((element) => element.scrollHeight > element.clientHeight)
    )
    .toBe(true);
  const geometry = await page.locator(".queue-pane").evaluate((pane) => {
    const queue = pane.querySelector(".queue-scroll")!.getBoundingClientRect();
    const pagination = pane
      .querySelector(".review-pagination")!
      .getBoundingClientRect();
    const buttons = [
      ...pane.querySelectorAll<HTMLButtonElement>(".review-pagination button")
    ].map((button) => button.getBoundingClientRect());
    return {
      queueBottom: queue.bottom,
      paginationTop: pagination.top,
      paginationBottom: pagination.bottom,
      paneBottom: pane.getBoundingClientRect().bottom,
      buttonTops: buttons.map((button) => button.top),
      buttonBottoms: buttons.map((button) => button.bottom)
    };
  });
  expect(geometry.paginationTop).toBeGreaterThanOrEqual(
    geometry.queueBottom - 1
  );
  expect(geometry.paginationBottom).toBeLessThanOrEqual(
    geometry.paneBottom + 1
  );
  expect(geometry.buttonTops[0]).toBeCloseTo(geometry.buttonTops[1] ?? 0, 0);
  expect(geometry.buttonBottoms[0]).toBeCloseTo(
    geometry.buttonBottoms[1] ?? 0,
    0
  );
});

test("review rows keep the canonical responsive topology across documented breakpoints", async ({
  page,
  isMobile
}) => {
  test.skip(isMobile, "One desktop browser covers explicit viewport changes");

  await page.goto("/human");
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
        const summary = element
          .querySelector(".row-summary-link")!
          .getBoundingClientRect();
        const details = element
          .querySelector(".row-details-link")!
          .getBoundingClientRect();
        return details.top >= summary.bottom - 1;
      })
    )
    .toBe(true);
});

test("narrow review rows preserve complete decision context and actions", async ({
  page,
  isMobile
}) => {
  test.skip(isMobile, "One desktop browser covers explicit viewport changes");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/human");

  const deployment = reviewRowByTitle(
    page,
    "Payments smoke check failed after deploy"
  );
  await expect(
    deployment.locator(".row-context .pill-visual > strong")
  ).toHaveText("1 failed");
  await expect(deployment.locator(".row-context .bar-track")).toHaveCount(0);
  await expect(deployment).toContainText(
    "Error rate and payment completion remain normal."
  );
  await expect(
    deployment.getByRole("link", { name: "Open safety note" })
  ).toBeVisible();
  await expect(
    deployment.getByRole("link", { name: "Keep release" })
  ).toHaveClass(/action-tone-success action-style-solid/);
  await expect(deployment.getByRole("link", { name: "Roll back" })).toHaveClass(
    /action-tone-danger action-style-outline/
  );

  await expect(
    reviewRowByTitle(page, "Reply to Meridian about the renewal delay")
  ).toContainText("the data-import rehearsal.");
});

test("narrow pill visuals stay inside their row context", async ({
  page,
  isMobile
}) => {
  test.skip(isMobile, "One desktop browser covers the explicit phone width");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/human");
  await expect(page.getByTestId("workspace-hydrated")).toHaveText("hydrated");
  const deployment = reviewRowByTitle(
    page,
    "Payments smoke check failed after deploy"
  );
  const context = deployment.locator(".row-context");
  const pill = context.locator(".pill-visual");
  await expect(pill).toHaveAttribute("title", "1 failed");
  await pill.locator("strong").evaluate((label) => {
    label.textContent =
      "Net terms required — awaiting final finance authorization";
  });
  await expect
    .poll(async () => {
      const [contextBox, pillBox] = await Promise.all([
        context.boundingBox(),
        pill.boundingBox()
      ]);
      return Boolean(
        contextBox &&
        pillBox &&
        pillBox.x >= contextBox.x - 1 &&
        pillBox.x + pillBox.width <= contextBox.x + contextBox.width + 1
      );
    })
    .toBe(true);
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
  const humanPosts: string[] = [];
  page.on("request", (request) => {
    if (request.method() !== "POST") return;
    const url = new URL(request.url());
    if (!url.pathname.startsWith("/human")) return;
    humanPosts.push(
      request.headers()["next-action"]
        ? "server-action"
        : url.pathname === "/human/mutations"
          ? "mutation"
          : `other:${url.pathname}`
    );
  });

  await page.goto("/human");
  await expect(page.getByTestId("workspace-hydrated")).toHaveText("hydrated");
  await openReviewTools(page);

  await expect(
    page.getByRole("link", { name: "Review queue" })
  ).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("region", { name: "Review detail" })).toHaveCount(
    0
  );

  const row = reviewRowByTitle(page, "Review neighborhood permit brief");
  await expect(
    row.getByRole("group", {
      name: /Quick actions for Review neighborhood permit brief/
    })
  ).toBeVisible();
  await row.getByRole("button", { name: "Approve permit brief" }).click();

  const completionNotice = page.locator("[data-sonner-toast]");
  await expect(completionNotice).toHaveCount(1);
  await expect(completionNotice).toContainText(
    "Saved Approve permit brief for “Review neighborhood permit brief”."
  );
  await expect(page).not.toHaveURL(/notice=/);
  expect(humanPosts).toEqual(["mutation"]);
  await page.getByRole("button", { name: "Close toast" }).click();
  await expect(completionNotice).toHaveCount(0);

  const followUpRow = reviewRowByTitle(page, "Choose follow-up window");
  await followUpRow.scrollIntoViewIfNeeded();
  await followUpRow.getByRole("button", { name: "Approve follow-up" }).click();
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(1);
  await expect(page.locator("[data-sonner-toast]")).toContainText(
    "Saved Approve follow-up for “Choose follow-up window”."
  );
  await expect(page).not.toHaveURL(/notice=/);
  expect(humanPosts).toEqual(["mutation", "mutation"]);
  await expect(page).not.toHaveURL(/item=/);
  await expect(
    page.getByRole("heading", { name: "Needs review" })
  ).toBeVisible();
  await expect(
    reviewLinkByTitle(page, "Review neighborhood permit brief")
  ).toHaveCount(0);
  await expect(reviewLinkByTitle(page, "Choose follow-up window")).toHaveCount(
    0
  );

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
  ).toContainText("answeredDecision: Approve");
  await expect(reviewRowByTitle(page, "Choose follow-up window")).toContainText(
    "answeredDecision: Approve"
  );
});

test("queue actions preserve a bottom scroll position", async ({ page }) => {
  await page.goto("/human");
  await expect(page.getByTestId("workspace-hydrated")).toHaveText("hydrated");

  const queue = page.locator(".queue-scroll");
  const lastQuickAction = queue
    .locator("form.inline-action-form button")
    .last();
  await lastQuickAction.scrollIntoViewIfNeeded();
  const scrollTopBeforeAction = await queue.evaluate((element) =>
    Math.round(element.scrollTop)
  );
  expect(scrollTopBeforeAction).toBeGreaterThan(0);

  await lastQuickAction.click();
  await expect(page.locator("[data-sonner-toast]")).toContainText("Saved");
  expect(
    await queue.evaluate((element) => Math.round(element.scrollTop))
  ).toBeGreaterThan(0);
});

test("a second queue action is retained while the first is synchronizing", async ({
  page
}) => {
  const firstRequestStarted = deferred();
  const releaseFirstResponse = deferred();
  let mutationRequests = 0;
  await page.route("**/human/mutations", async (route) => {
    mutationRequests += 1;
    if (mutationRequests === 1) {
      firstRequestStarted.resolve();
      await releaseFirstResponse.promise;
    }
    await route.continue();
  });
  await page.goto("/human");
  await expect(page.getByTestId("workspace-hydrated")).toHaveText("hydrated");

  const firstAction = page.getByRole("button", {
    name: "Approve to send",
    exact: true
  });
  const secondAction = page.getByRole("button", {
    name: "Approve permit brief",
    exact: true
  });
  await firstAction.click();
  await firstRequestStarted.promise;
  await secondAction.click();

  await expect(firstAction).toBeHidden();
  await expect(secondAction).toBeHidden();
  await expect(
    page.getByLabel("Current view summary").getByText("6", { exact: true })
  ).toBeVisible();
  expect(
    mutationRequests,
    "The second intent should wait in the app journal while the first syncs."
  ).toBe(1);

  await page
    .getByRole("navigation", { name: "Primary" })
    .getByRole("link", { name: "History" })
    .click();
  await expect(page).toHaveURL(/status=answered/);
  expect(
    mutationRequests,
    "Client navigation must preserve the queued writes."
  ).toBe(1);

  releaseFirstResponse.resolve();
  await expect
    .poll(() => mutationRequests, {
      message: "The queued second intent should synchronize after the first."
    })
    .toBe(2);
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(2);
  const toastBoxes = await page
    .locator("[data-sonner-toast]")
    .evaluateAll((toasts) =>
      toasts
        .map((toast) => toast.getBoundingClientRect())
        .sort((left, right) => left.top - right.top)
        .map(({ top, bottom }) => ({ top, bottom }))
    );
  expect(toastBoxes[0]?.bottom).toBeLessThanOrEqual(toastBoxes[1]?.top ?? 0);
  await expect(
    reviewRowByTitle(page, "Reply to Meridian about the renewal delay")
  ).toContainText("answeredDecision: Approve to send");
  await expect(
    reviewRowByTitle(page, "Review neighborhood permit brief")
  ).toContainText("answeredDecision: Approve");
});

test("toasts expose immediate row context and undo restores queue order", async ({
  page
}) => {
  const requestStarted = deferred();
  const releaseResponse = deferred();
  await page.route("**/human/mutations", async (route) => {
    requestStarted.resolve();
    await releaseResponse.promise;
    await route.continue();
  });
  await page.goto("/human?sort=updated_at");
  await expect(page.getByTestId("workspace-hydrated")).toHaveText("hydrated");

  const title = "Review neighborhood permit brief";
  const row = reviewRowByTitle(page, title);
  const rows = page.locator("article.review-row");
  const originalIndex = await rows.evaluateAll(
    (nodes, expectedTitle) =>
      nodes.findIndex((node) => node.textContent?.includes(expectedTitle)),
    title
  );
  expect(originalIndex).toBeGreaterThanOrEqual(0);

  await row.getByRole("button", { name: "Approve permit brief" }).click();
  await requestStarted.promise;
  await expect(
    page.locator("[data-sonner-toast]").filter({
      hasText: "Saving Approve permit brief"
    })
  ).toContainText(`“${title}”…`);

  releaseResponse.resolve();
  const savedToast = page.locator("[data-sonner-toast]").filter({
    hasText: `Saved Approve permit brief for “${title}”.`
  });
  await savedToast.getByRole("button", { name: "Undo" }).click();
  await expect(
    page.locator("[data-sonner-toast]").filter({
      hasText: `Restored “${title}” to its prior queue position.`
    })
  ).toBeVisible();
  await expect(row).toBeVisible();
  const restoredIndex = await rows.evaluateAll(
    (nodes, expectedTitle) =>
      nodes.findIndex((node) => node.textContent?.includes(expectedTitle)),
    title
  );
  expect(restoredIndex).toBe(originalIndex);
});

test("review controls support type then priority compound sorting", async ({
  page
}) => {
  await page.goto("/human");
  await expect(page.getByTestId("workspace-hydrated")).toHaveText("hydrated");
  await openReviewTools(page);
  await choosePrimarySort(page, "Type", { keepOpen: true });
  if (
    (await page.getByLabel("Sort: Type").getAttribute("aria-expanded")) !==
    "true"
  ) {
    await page.getByLabel("Sort: Type").click();
  }
  await page.getByRole("button", { name: "Add sort field" }).click();
  await expect(page.getByLabel("Sort 2 field")).toBeVisible();
  await expect(page.getByLabel("Sort 2 field")).toBeFocused();
  await expect(page).toHaveURL(/order=type%3Aasc/);
  await expect(page).toHaveURL(/order=priority%3Aasc/);
  await expect(page.getByLabel("Sort: Type → Priority")).toBeVisible();
  await expect(page.locator("article.review-row").first()).toContainText(
    "Decision Check"
  );
});

test("sort rules remain clickable and reorder by pointer and keyboard", async ({
  page
}) => {
  await page.goto("/human");
  await expect(page.getByTestId("workspace-hydrated")).toHaveText("hydrated");
  await openReviewTools(page);
  await page.getByLabel("Sort: Priority").click();
  await page.getByRole("button", { name: "Add sort field" }).click();

  const secondaryHandle = page.getByRole("button", {
    name: "Reorder Type sort, position 2 of 2"
  });
  await secondaryHandle.focus();
  await page.keyboard.press("ArrowUp");
  await expect(page.getByLabel("Sort: Type → Priority")).toBeVisible();
  await expect(page).toHaveURL(/order=type%3Aasc/);
  await expect(page).toHaveURL(/order=priority%3Aasc/);

  const primaryHandle = page.getByRole("button", {
    name: "Reorder Type sort, position 1 of 2"
  });
  const targetHandle = page.getByRole("button", {
    name: "Reorder Priority sort, position 2 of 2"
  });
  const primaryBox = await primaryHandle.boundingBox();
  const secondaryBox = await targetHandle.boundingBox();
  expect(primaryBox).not.toBeNull();
  expect(secondaryBox).not.toBeNull();
  await page.mouse.move(
    primaryBox!.x + primaryBox!.width / 2,
    primaryBox!.y + primaryBox!.height / 2
  );
  await page.mouse.down();
  await page.mouse.move(
    secondaryBox!.x + secondaryBox!.width / 2,
    secondaryBox!.y + secondaryBox!.height / 2,
    { steps: 8 }
  );
  await page.mouse.up();
  await expect(page.getByLabel("Sort: Priority → Type")).toBeVisible();
  await expect(page).toHaveURL(/order=priority%3Aasc/);
  await expect(page).toHaveURL(/order=type%3Aasc/);

  await page.getByLabel("Sort 1 field").selectOption({ label: "Visual score" });
  await expect(page.getByLabel("Sort 1 field")).toBeFocused();
  await expect(page).toHaveURL(/order=visual_score%3Adesc/);
  await expect(page.getByLabel("Sort 1 direction")).toHaveValue("desc");
  await expect(
    page.getByText(/without a numeric score stay at the bottom/)
  ).toBeVisible();
  await expect(page.locator("article.review-row").nth(0)).toContainText(
    "Publish the instruction-ablation result"
  );
  await expect(page.locator("article.review-row").nth(1)).toContainText(
    "Review neighborhood permit brief"
  );
  await page.getByLabel("Sort 1 direction").selectOption("asc");
  await expect(page).toHaveURL(/order=visual_score%3Aasc/);
  await expect(page.locator("article.review-row").nth(0)).toContainText(
    "Categorize Cloudflare · $240.00"
  );
  await expect(page.locator("article.review-row").nth(1)).toContainText(
    "Choose follow-up window"
  );
  await page.getByLabel("Sort 2 field").selectOption({ label: "Caller" });
  await expect(page).toHaveURL(/order=caller%3Aasc/);
  await page.getByRole("button", { name: "Remove Caller sort" }).click();
  await expect(page.getByLabel("Sort 2 field")).toHaveCount(0);
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.getByLabel("Sort: Visual score")).toBeFocused();
});

test("review filters are visible, composable, removable, and reset pagination", async ({
  page
}) => {
  await page.goto("/human?fixture_dataset=pagination&page=2");
  await expect(page.getByTestId("workspace-hydrated")).toHaveText("hydrated");
  await openReviewTools(page);
  await page.getByLabel("Filter", { exact: true }).click();
  await page.getByRole("checkbox", { name: "High" }).check();
  await expect(page).toHaveURL(/priority=high/);
  await expect(page).not.toHaveURL(/page=2/);

  await page.getByRole("checkbox", { name: "Research Question" }).check();
  await expect(page).toHaveURL(/type=Research\+Question/);
  await expect(page.getByLabel("Filter, 2 applied")).toBeVisible();
  await expect(page.getByLabel("Applied filters")).toContainText(
    "Priority: High"
  );
  await expect(page.getByLabel("Applied filters")).toContainText(
    "Type: Research Question"
  );
  await expect(page.locator("article.review-row")).toHaveCount(0);

  await page.getByRole("button", { name: "Close filter menu" }).click();
  await page
    .getByRole("button", { name: "Remove Type: Research Question filter" })
    .click();
  await expect(page).not.toHaveURL(/type=Research/);
  await page.getByRole("button", { name: "Clear all" }).click();
  await expect(page).not.toHaveURL(/priority=/);
  await expect(page.getByLabel("Applied filters")).toHaveCount(0);
});

test("sort control supports every field and arbitrary priority changes", async ({
  page
}) => {
  await page.goto("/human");
  await openReviewTools(page);
  await page.getByLabel("Sort: Priority").click();

  for (let rank = 2; rank <= 7; rank += 1) {
    await page.getByRole("button", { name: "Add sort field" }).click();
    await expect(page.getByLabel(`Sort ${rank} field`)).toBeFocused();
  }
  await expect(
    page.getByRole("button", { name: "Add sort field" })
  ).toHaveCount(0);
  const fields = await page
    .locator(".sort-rule-fields > .sort-select:first-child select")
    .evaluateAll((selects) =>
      selects.map((select) => (select as HTMLSelectElement).value)
    );
  expect(new Set(fields).size).toBe(7);

  const lastHandle = page.getByRole("button", {
    name: "Reorder Last updated sort, position 7 of 7"
  });
  await lastHandle.focus();
  await page.keyboard.press("ArrowUp");
  await expect(
    page.getByRole("button", {
      name: "Reorder Last updated sort, position 6 of 7"
    })
  ).toBeFocused();

  await page.getByRole("button", { name: "Remove Created sort" }).click();
  await expect(page.getByLabel("Sort 7 field")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Add sort field" })
  ).toBeVisible();
});

test("sort rules own their direction and reset it when the field changes", async ({
  page
}) => {
  await page.goto("/human");
  await openReviewTools(page);
  await page.getByLabel("Sort: Priority").click();
  await page.getByLabel("Sort 1 direction").selectOption("desc");
  await expect(page).toHaveURL(/order=priority%3Adesc/);
  await page.getByLabel("Sort 1 field").selectOption({ label: "Type" });
  await expect(page).toHaveURL(/order=type%3Aasc/);
  await expect(page.getByLabel("Sort 1 direction")).toHaveValue("asc");
});

test("canonical search and status navigation preserve pending view changes", async ({
  page
}) => {
  await page.goto("/human");
  await openReviewTools(page);
  await page.getByRole("textbox", { name: "Search" }).fill("follow-up ");
  await page.getByLabel("Filter", { exact: true }).click();
  await page.getByRole("checkbox", { name: "High" }).check();
  await expect(page).toHaveURL(/search=follow-up(?:&|$)/);
  await expect(page).not.toHaveURL(/follow-up\+/);
  await expect(page).toHaveURL(/priority=high/);
  await page.getByRole("button", { name: "Done" }).click();
  await page
    .getByRole("navigation", { name: "Primary" })
    .getByRole("link", { name: "History" })
    .click();
  await expect(page).toHaveURL(/status=answered/);
  await expect(page).toHaveURL(/search=follow-up/);
  await expect(page).toHaveURL(/priority=high/);

  await page.goBack();
  await expect(page).not.toHaveURL(/status=answered/);
  await expect(page).toHaveURL(/search=follow-up/);
  await expect(page).toHaveURL(/priority=high/);
});

test("a client mutation timeout keeps the optimistic projection", async ({
  page
}) => {
  const requestStarted = deferred();
  await page.addInitScript(() => {
    const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
    AbortSignal.timeout = (ms: number) =>
      originalTimeout(ms === 20_000 ? 50 : ms);
  });
  await page.route("**/human/mutations", async (route) => {
    requestStarted.resolve();
    await new Promise<void>(() => {});
    await route.continue();
  });
  await page.goto("/human");
  await expect(page.getByTestId("workspace-hydrated")).toHaveText("hydrated");

  const row = reviewRowByTitle(
    page,
    "Reply to Meridian about the renewal delay"
  );
  const aborted = page.waitForEvent("requestfailed", (request) =>
    request.url().includes("/human/mutations")
  );
  await row.getByRole("button", { name: "Approve to send" }).click();
  await requestStarted.promise;
  await aborted;
  await expect(row).toBeHidden();
  await expect(page.locator("[data-sonner-toast]")).toContainText(
    "Still confirming"
  );
});

test("an all-failed bulk mutation restores the selected rows", async ({
  page
}) => {
  await page.route("**/human/mutations", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        operation: "bulk-answer",
        message: "Bulk action complete: 0 answered, 2 failed.",
        inputItemIds: [
          "00000000-0000-4000-8000-000000000511",
          "00000000-0000-4000-8000-000000000512"
        ],
        answered: 0,
        failed: 2
      })
    });
  });
  await page.goto("/human");
  await expect(page.getByTestId("workspace-hydrated")).toHaveText("hydrated");
  await openReviewTools(page);
  await page
    .getByRole("button", { name: /^(Select items|Bulk select)$/ })
    .click();
  const permitRow = reviewRowByTitle(page, "Review neighborhood permit brief");
  const followUpRow = reviewRowByTitle(page, "Choose follow-up window");
  await permitRow.getByRole("checkbox", { name: "Select review" }).check();
  await followUpRow.getByRole("checkbox", { name: "Select review" }).check();
  await page
    .getByRole("button", { name: "Apply Approve permit brief" })
    .click();

  await expect(page.locator("[data-sonner-toast]")).toContainText(
    "Bulk action complete: 0 answered, 2 failed."
  );
  await expect(permitRow).toBeVisible();
  await expect(followUpRow).toBeVisible();
});

test("undo from a History toast does not leave a pending snapshot in History", async ({
  page
}) => {
  await page.goto("/human");
  await expect(page.getByTestId("workspace-hydrated")).toHaveText("hydrated");
  const row = reviewRowByTitle(
    page,
    "Reply to Meridian about the renewal delay"
  );
  await row.getByRole("button", { name: "Approve to send" }).click();
  const toast = page.locator("[data-sonner-toast]");
  await expect(toast).toContainText(
    "Saved Approve to send for “Reply to Meridian about the renewal delay”."
  );

  await page
    .getByRole("navigation", { name: "Primary" })
    .getByRole("link", { name: "History" })
    .click();
  await expect(page).toHaveURL(/status=answered/);
  await expect(row).toBeVisible();
  await toast.getByRole("button", { name: "Undo" }).click();
  await expect(
    page.locator("[data-sonner-toast]").filter({ hasText: "Restored" })
  ).toBeVisible();
  await expect(row).toHaveCount(0);
});

test("a failed optimistic queue action rolls back its local projection", async ({
  page
}) => {
  const requestStarted = deferred();
  const releaseFailure = deferred();
  await page.route("**/human/mutations", async (route) => {
    requestStarted.resolve();
    await releaseFailure.promise;
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        ok: false,
        operation: "answer",
        code: "temporary_unavailable",
        message: "The decision could not be saved.",
        inputItemIds: ["00000000-0000-4000-8000-000000000501"]
      })
    });
  });
  await page.goto("/human");
  await expect(page.getByTestId("workspace-hydrated")).toHaveText("hydrated");

  const row = reviewRowByTitle(
    page,
    "Reply to Meridian about the renewal delay"
  );
  await row.getByRole("button", { name: "Approve to send" }).click();
  await requestStarted.promise;
  await expect(row).toBeHidden();

  releaseFailure.resolve();
  await expect(row).toBeVisible();
  await expect(page.locator("[data-sonner-toast]")).toContainText(
    "The decision could not be saved."
  );
});

test("human mutation transport rejects cross-origin requests", async ({
  page
}) => {
  const response = await page.request.post("/human/mutations", {
    headers: { Origin: "https://attacker.example" },
    multipart: { _operation: "answer" }
  });
  expect(response.status()).toBe(403);
  await expect(response.json()).resolves.toMatchObject({
    ok: false,
    code: "invalid_request"
  });
});

test("review actions disappear within 20 ms without shifting the workspace", async ({
  page
}) => {
  const actionRequestStarted = deferred();
  const releaseActionResponse = deferred();
  await page.route("**/human**", async (route) => {
    if (route.request().method() === "POST") {
      actionRequestStarted.resolve();
      await releaseActionResponse.promise;
    }
    await route.continue();
  });
  await page.addInitScript(() => {
    window.addEventListener(
      "click",
      () => {
        (
          window as Window & { __humanActionClickStartedAt?: number }
        ).__humanActionClickStartedAt = performance.now();
      },
      true
    );
  });
  await page.goto("/human?notice=answer_submitted");
  await expect(page.getByTestId("workspace-hydrated")).toHaveText("hydrated");

  const row = reviewRowByTitle(page, "Review neighborhood permit brief");
  const approve = row.getByRole("button", { name: "Approve permit brief" });
  await expect(approve).toBeEnabled();
  const existingNotice = page.locator("[data-sonner-toast]");
  await expect(existingNotice).toContainText("Saved response for this review.");
  const workspaceBody = page.locator(".workspace-body");
  const workspaceTopBeforeAction = await workspaceBody.evaluate(
    (element) => element.getBoundingClientRect().top
  );

  await approve.evaluate((button) => {
    const reviewRow = button.closest("article.review-row");
    const list = reviewRow?.closest("ol.review-list");
    const workspace = button.closest<HTMLElement>(".human-workspace");
    if (!reviewRow || !list || !workspace) {
      throw new Error("Review action latency test could not find its UI.");
    }
    const rowContainer = reviewRow.closest("li");
    if (!rowContainer) {
      throw new Error("Review action latency test could not find its row.");
    }
    const observer = new MutationObserver(() => {
      if (!rowContainer.isConnected) {
        const startedAt = (
          window as Window & { __humanActionClickStartedAt?: number }
        ).__humanActionClickStartedAt;
        if (startedAt === undefined) {
          throw new Error("Review action latency test missed the click event.");
        }
        workspace.dataset.actionResponseMs = String(
          performance.now() - startedAt
        );
        observer.disconnect();
      }
    });
    observer.observe(list, { childList: true });
    (button as HTMLButtonElement).click();
  });

  await actionRequestStarted.promise;
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      })
  );
  const responseMs = await page
    .locator(".human-workspace")
    .getAttribute("data-action-response-ms");

  expect(
    responseMs,
    "The reviewed row must respond before the held server action completes."
  ).not.toBeNull();
  expect(Number(responseMs)).toBeLessThanOrEqual(20);
  await expect(row).toBeHidden();
  await expect(existingNotice).toHaveCount(2);
  await expect(
    existingNotice.filter({ hasText: "Saving Approve permit brief" })
  ).toContainText("“Review neighborhood permit brief”…");
  expect(
    await workspaceBody.evaluate(
      (element) => element.getBoundingClientRect().top
    )
  ).toBe(workspaceTopBeforeAction);

  releaseActionResponse.resolve();
  const completionNotice = page.locator("[data-sonner-toast]");
  const savedNotice = completionNotice.filter({
    hasText:
      "Saved Approve permit brief for “Review neighborhood permit brief”."
  });
  await expect(savedNotice).toBeVisible();
  await expect(savedNotice.getByRole("button", { name: "Undo" })).toBeVisible();
  await expect(page.locator(".human-notice")).toHaveCount(0);
  expect(
    await workspaceBody.evaluate(
      (element) => element.getBoundingClientRect().top
    )
  ).toBe(workspaceTopBeforeAction);
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
  const incompatibleRow = reviewRowByTitle(
    page,
    "Payments smoke check failed after deploy"
  );
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
  await page
    .getByRole("button", { name: "Apply Approve permit brief" })
    .click();
  await expect(page.locator("[data-sonner-toast]")).toContainText(
    "Bulk action complete: 2 answered, 0 failed."
  );
  await page
    .getByRole("navigation", { name: "Primary" })
    .getByRole("link", { name: "History" })
    .click();
  await expect(
    reviewRowByTitle(page, "Review neighborhood permit brief")
  ).toContainText("answeredDecision: Approve");
  await expect(reviewRowByTitle(page, "Choose follow-up window")).toContainText(
    "answeredDecision: Approve"
  );

  await page.goto("/human?item=00000000-0000-4000-8000-000000000517");
  await expect(page.getByTestId("workspace-hydrated")).toHaveText("hydrated");
  await expect(page.getByLabel("Answered state")).toContainText(
    "Answered with Archive"
  );
  await page.getByRole("button", { name: "Undo answer" }).click();
  await expect(page.locator("[data-sonner-toast]")).toContainText("Restored");

  await page.goto("/human?item=00000000-0000-4000-8000-000000000525");
  await expect(
    page.getByRole("button", { name: "Undo unavailable after caller read" })
  ).toBeDisabled();
});

test("undo from detail closes the modal before the server answers", async ({
  page
}) => {
  const actionRequestStarted = deferred();
  const releaseActionResponse = deferred();
  await page.route("**/human**", async (route) => {
    if (route.request().method() === "POST") {
      actionRequestStarted.resolve();
      await releaseActionResponse.promise;
    }
    await route.continue();
  });
  await page.goto("/human?item=00000000-0000-4000-8000-000000000517");
  await expect(page.getByTestId("workspace-hydrated")).toHaveText("hydrated");
  await expect(page.getByLabel("Answered state")).toContainText(
    "Answered with Archive"
  );
  expect(
    await page.evaluate(() => {
      const dialog = document.querySelector("dialog.detail-modal");
      return dialog instanceof HTMLDialogElement && dialog.open;
    })
  ).toBe(true);

  await page.getByRole("button", { name: "Undo answer" }).click();
  await actionRequestStarted.promise;
  expect(
    await page.evaluate(() => {
      const dialog = document.querySelector("dialog.detail-modal");
      return dialog instanceof HTMLDialogElement ? dialog.open : false;
    }),
    "Optimistic undo must close the detail modal so the queue is not left inert."
  ).toBe(false);
  expect(
    await page.evaluate(() => document.querySelector("[inert]") != null)
  ).toBe(false);

  releaseActionResponse.resolve();
  await expect(page.locator("[data-sonner-toast]")).toContainText("Restored");
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

  await expect(page.locator("[data-sonner-toast]")).toContainText(
    "Could not save “Review neighborhood permit brief”: Action failed: invalid request."
  );
  await expect(
    reviewLinkByTitle(page, "Review neighborhood permit brief")
  ).toBeVisible();
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
  // This scenario intentionally spans several client navigations and a server
  // action. Keep each assertion's normal bounded wait while allowing for CI
  // scheduling across the complete workflow.
  test.slow();

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
  await expect(page.locator("[data-sonner-toast]")).toContainText("Saved");
  await expect(page).toHaveURL(/page=2/);
  await expect(page.getByTestId("workspace-hydrated")).toHaveText("hydrated");

  if (isMobile) {
    await expect(page.getByTestId("workspace-hydrated")).toHaveText("hydrated");
  }
  await openReviewTools(page);
  await page
    .getByRole("textbox", { name: "Search" })
    .fill("Beyond one hundred");
  await expect(page).toHaveURL(/search=Beyond\+one\+hundred/);
  await expect(page).not.toHaveURL(/page=2/);
  await expect(
    reviewLinkByTitle(page, "Beyond one hundred review")
  ).toHaveCount(0);

  await page
    .getByRole("navigation", { name: "Primary" })
    .getByRole("link", { name: "History" })
    .click();
  await expect(page).toHaveURL(/status=answered/);
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
  await page.getByRole("textbox", { name: "Search" }).fill("follow-up");
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
  const searchInput = page.getByRole("textbox", { name: "Search" });

  await searchInput.fill("follow-up");
  await searchInput.press("Enter");
  await expect(page).toHaveURL(/search=follow-up/);
  await expect.poll(() => searchRequests.length).toBe(1);
  await page.clock.runFor(300);
  expect(searchRequests).toHaveLength(1);

  await page
    .getByRole("textbox", { name: "Search" })
    .fill("neighborhood permit");
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page).toHaveURL(/search=neighborhood\+permit/);
  await expect.poll(() => searchRequests.length).toBe(2);
  await page.clock.runFor(300);
  expect(searchRequests).toHaveLength(2);

  await page.getByRole("textbox", { name: "Search" }).fill("summary");
  await choosePrimarySort(page, "Last updated");
  await expect(page).toHaveURL(/search=summary/);
  await expect(page).toHaveURL(/order=updated_at%3Adesc/);
  await expect.poll(() => searchRequests.length).toBe(3);
  await page.clock.runFor(300);
  expect(searchRequests).toHaveLength(3);

  await page.getByRole("textbox", { name: "Search" }).fill("follow-up");
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page).toHaveURL(/search=follow-up/);
  await page.getByRole("textbox", { name: "Search" }).fill("");
  await page.getByRole("link", { name: "History" }).click();
  await expect(page).toHaveURL(/status=answered/);
  await expect(page).not.toHaveURL(/search=/);
  await page.clock.runFor(300);
  await expect(page).not.toHaveURL(/search=/);
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

  await expect.poll(() => events).toEqual([{ name: "client_error" }]);
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
  await page.getByRole("textbox", { name: "Search" }).fill("follow-up");
  await expect(page.locator(".bulk-actions")).toContainText(
    "1 selected pending row"
  );
  await page.getByRole("button", { name: "Apply Approve follow-up" }).click();
  await expect(page.locator("[data-sonner-toast]")).toContainText(
    "Bulk action complete: 1 answered, 0 failed."
  );
});

function reviewRowByTitle(page: Page, title: string) {
  return page.locator("article.review-row").filter({
    has: page.locator(".row-title", { hasText: title })
  });
}

function reviewLinkByTitle(page: Page, title: string) {
  return page.locator("a.row-details-link").and(
    page.getByRole("link", {
      name: `Open review details for ${title}`,
      exact: true
    })
  );
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

async function choosePrimarySort(
  page: Page,
  option: string,
  { keepOpen = false }: { keepOpen?: boolean } = {}
) {
  const trigger = page.getByLabel(/^Sort:/);
  if ((await trigger.getAttribute("aria-expanded")) !== "true") {
    await trigger.click();
  }
  await page.getByLabel("Sort 1 field").selectOption({ label: option });
  if (!keepOpen) {
    await page
      .getByRole("dialog", { name: "Sort reviews" })
      .getByRole("button", { name: "Done" })
      .click();
  }
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
  await expect(page.locator("[data-sonner-toast]")).toContainText("Saved");

  await page.goto("/human?item=00000000-0000-4000-8000-000000000511");

  await openSecondaryActions(page);
  await page.getByRole("button", { name: "Request edit" }).click();
  await page
    .getByLabel("Requested change")
    .fill("Tighten the handoff language.");
  await page.getByRole("button", { name: "Request edit" }).click();
  await expect(page.locator("[data-sonner-toast]")).toContainText("Saved");

  await page.goto("/human?item=00000000-0000-4000-8000-000000000511");
  await openSecondaryActions(page);
  await page.getByRole("button", { name: "Set review lane" }).click();
  await page.getByLabel("Operations").check();
  await page.getByRole("button", { name: "Set review lane" }).click();
  await expect(page.locator("[data-sonner-toast]")).toContainText("Saved");

  await page.goto("/human?item=00000000-0000-4000-8000-000000000512");
  await page.getByRole("button", { name: "Pick date", exact: true }).click();
  await page.getByLabel("Follow-up date").fill("2026-07-15");
  await page.getByRole("button", { name: "Pick date" }).click();
  await expect(page.locator("[data-sonner-toast]")).toContainText("Saved");

  await page.goto("/human?item=00000000-0000-4000-8000-000000000512");
  await page.getByRole("button", { name: "Pick date and time" }).click();
  await page.getByLabel("Follow-up instant").fill("2026-07-16T09:30");
  await page.getByRole("button", { name: "Pick date and time" }).click();
  await expect(page.locator("[data-sonner-toast]")).toContainText("Saved");

  await page.goto("/human?item=00000000-0000-4000-8000-000000000512");
  await page.getByRole("button", { name: "Select checks" }).click();
  await page.getByLabel("Facts reviewed").check();
  await page.getByLabel("Tone reviewed").check();
  await page.getByRole("button", { name: "Select checks" }).click();
  await expect(page.locator("[data-sonner-toast]")).toContainText("Saved");
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
  await page.goto("/human");

  await expect
    .poll(() =>
      page.locator(".human-workspace").evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          canvas: style.getPropertyValue("--review-canvas").trim(),
          paper: style.getPropertyValue("--review-paper").trim()
        };
      })
    )
    .toEqual({ canvas: "#f6f5f1", paper: "#fcfcfa" });

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
    "A"
  );
  await expect(numericRow.locator("a.row-link")).toHaveAttribute(
    "aria-label",
    "Open review details for Review neighborhood permit brief"
  );
  await expect(numericRow.locator("a.row-link")).toHaveAttribute(
    "href",
    /item=00000000-0000-4000-8000-000000000511/
  );
  await expect(numericRow.locator("a.row-link a")).toHaveCount(0);
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
    .toBe("#f2a347");

  const progressRow = reviewRowByTitle(page, "Choose follow-up window");
  await expect(progressRow.locator(".ring svg")).toHaveCount(0);
  await expect(progressRow.locator(".visual-unit")).toHaveText("checks");

  const coloredProgressRow = reviewRowByTitle(
    page,
    "Publish the instruction-ablation result"
  );
  await expect(coloredProgressRow.locator(".bar-fill")).toHaveCSS(
    "background-color",
    "rgb(169, 81, 35)"
  );

  const pillRow = reviewRowByTitle(
    page,
    "Reply to Meridian about the renewal delay"
  );
  await expect(pillRow.locator(".pill-visual > strong")).toHaveText(
    "External · 3"
  );
  await expect(pillRow.locator(".pill-visual")).not.toContainText("Signal");
  await expect(pillRow.locator(".pill-visual")).toHaveCSS(
    "background-color",
    /color\(srgb/
  );
  await expect(pillRow.locator(".pill-visual")).toHaveCSS(
    "color",
    "rgb(169, 81, 35)"
  );

  const categoryVisual = reviewRowByTitle(
    page,
    "Categorize Cloudflare · $240.00"
  ).locator(".row-context .numeric-bar");
  await expect
    .poll(() =>
      categoryVisual.evaluate(
        (element) => element.scrollWidth <= element.clientWidth
      )
    )
    .toBe(true);

  if (isMobile) {
    await expect(progressRow.locator(".row-subtitle")).toHaveCSS(
      "-webkit-line-clamp",
      "2"
    );
  }

  await page.goto("/human?status=answered");
  const fallbackRow = reviewRowByTitle(
    page,
    "Confirm the electrician’s arrival window"
  );
  await expect(fallbackRow.locator(".product-fallback-meta")).toBeVisible();
  await expect(fallbackRow.locator(".row-footer")).toContainText(
    "Decision: Approve reply"
  );
  const archiveVisual = reviewRowByTitle(
    page,
    "GitHub security digest for archived repositories"
  ).locator(".row-context .numeric-bar");
  await expect
    .poll(() =>
      archiveVisual.evaluate(
        (element) => element.scrollWidth <= element.clientWidth
      )
    )
    .toBe(true);
  await expect
    .poll(() =>
      fallbackRow.evaluate((row) => {
        const copyElement = row.querySelector<HTMLElement>(".row-copy")!;
        const copy =
          getComputedStyle(copyElement).display === "contents"
            ? row.querySelector(".row-link")!.getBoundingClientRect()
            : copyElement.getBoundingClientRect();
        const footer = row
          .querySelector(".row-footer")!
          .getBoundingClientRect();
        return {
          leftAligned: Math.abs(copy.left - footer.left) < 1,
          rightAligned: Math.abs(copy.right - footer.right) < 1
        };
      })
    )
    .toEqual({ leftAligned: true, rightAligned: true });

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
  await page.goto("/human");
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

test("answered queue rows hide overflow decision actions", async ({ page }) => {
  await page.goto("/human?status=answered");
  const row = reviewRowByTitle(
    page,
    "GitHub security digest for archived repositories"
  );
  await expect(row.locator("details.row-overflow")).toHaveCount(0);
  await expect(row.locator(".inline-actions")).toHaveCount(0);
  await expect(
    row.getByRole("button", {
      name: "No more actions for GitHub security digest for archived repositories"
    })
  ).toBeVisible();
  await expect(row).toContainText("Decision: Archive");
  await expect(row.locator("a.row-link a")).toHaveCount(0);
});

test("queue J and K move between rows and Enter opens details", async ({
  page
}) => {
  await page.goto("/human");
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
  await page.goto("/human");
  await openReviewTools(page);
  const search = page.getByRole("textbox", { name: "Search" });
  await search.click();
  await page.keyboard.press("j");
  await expect(search).toHaveValue("j");
  await expect(
    page.locator(".review-list .row-link").first()
  ).not.toBeFocused();

  await page.goto("/human");
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

  await expect(page).toHaveURL(/order=updated_at%3Adesc/);
  await expect(
    page.getByRole("link", { name: "Review queue" })
  ).toHaveAttribute("aria-current", "page");
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
  await expect(detail.locator(".card-visual")).not.toHaveAttribute(
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
