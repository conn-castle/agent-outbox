import { expect, test, type Page, type Route } from "@playwright/test";

const permit = "Review neighborhood permit brief";
const followUp = "Choose follow-up window";
const email = "Reply to Meridian about the renewal delay";
const actions = [
  [permit, "Approve permit brief"],
  [followUp, "Approve follow-up"],
  [email, "Approve to send"]
] as const;

test("undo restores only the last answer, in its original queue position, across history and reload", async ({
  page
}) => {
  const initial = await openQueue(page);
  for (const [, action] of actions) await answer(page, action);
  await expectQueue(
    page,
    initial.filter((title) => !actions.some(([item]) => item === title))
  );
  await undo(page);
  const pending = initial.filter(
    (title) => title !== permit && title !== followUp
  );
  await expectQueue(page, pending);
  await page.reload();
  await expectHydrated(page);
  await expectQueue(page, pending);
  await expectHistory(page, [permit, followUp], [email]);

  // An older answer is independently undoable from its History details.
  await page
    .getByRole("link", {
      name: `Open review details for ${permit}`,
      exact: true
    })
    .first()
    .click();
  const restored = mutationResponse(page);
  await page.getByRole("button", { name: "Undo answer", exact: true }).click();
  await restored;
  await page
    .getByRole("navigation", { name: "Primary" })
    .getByRole("link", { name: "Review queue", exact: true })
    .click();
  await expectQueue(
    page,
    initial.filter((title) => title !== followUp)
  );
  await page.reload();
  await expectHydrated(page);
  await expectQueue(
    page,
    initial.filter((title) => title !== followUp)
  );
  await expectHistory(page, [followUp], [permit, email]);
});

for (const outcome of ["all", "partial", "none"] as const) {
  test(`undo after ${outcome} bulk success preserves exactly the unanswered queue`, async ({
    page
  }) => {
    const initial = await openQueue(page);
    const refreshes = await holdRefreshes(page);
    try {
      for (const [, action] of actions.slice(0, 2)) {
        await answer(page, action);
        await undo(page);
      }
      await expectQueue(page, initial);
      await showTools(page);
      await page
        .getByRole("button", { name: "Select items", exact: true })
        .click();
      for (const title of [permit, followUp])
        await row(page, title)
          .getByRole("checkbox", { name: "Select review" })
          .check();

      // Inject only the failure outcome. Successful items are sent to the real
      // fixture endpoint, so History and reload independently see those writes.
      if (outcome !== "all")
        await page.route("**/human/mutations", (route) =>
          bulkFailure(route, outcome)
        );
      const bulk = mutationResponse(page);
      await page
        .getByRole("button", {
          name: "Apply Approve permit brief",
          exact: true
        })
        .click();
      await bulk;
      if (outcome !== "all") {
        await expect(page.locator(".last-action-error")).toContainText(
          outcome === "partial" ? "1 failed" : "2 not answered"
        );
        await page.unroute("**/human/mutations");
      }
      const answered =
        outcome === "all"
          ? [permit, followUp]
          : outcome === "partial"
            ? [permit]
            : [];
      const pending = initial.filter((title) => !answered.includes(title));
      await expectQueue(page, pending);
      await answer(page, "Approve to send");
      await expectQueue(
        page,
        pending.filter((title) => title !== email)
      );
      await undo(page);
      await expectQueue(page, pending);
      await refreshes.release();

      // A completed server-rendered sort ensures fresh queue data has reached
      // this mounted UI. No mutation-journal counters are correctness oracles.
      await sortByTitle(page);
      await expectQueue(
        page,
        [...pending].sort((a, b) => a.localeCompare(b))
      );
      await expectHistory(
        page,
        answered,
        initial.filter((title) => !answered.includes(title))
      );
      await page
        .getByRole("navigation", { name: "Primary" })
        .getByRole("link", { name: "Review queue", exact: true })
        .click();
      await expectQueueMembership(page, pending);
      await page.reload();
      await expectHydrated(page);
      await expectQueueMembership(page, pending);
      if (outcome !== "all") {
        // A failed bulk item must remain actionable, not just visibly present.
        await answer(page, "Approve follow-up");
        await page.reload();
        await expectHydrated(page);
        await expectQueueMembership(
          page,
          pending.filter((title) => title !== followUp)
        );
      }
    } finally {
      await refreshes.release();
    }
  });
}

test("rejected undo keeps every answered item in History and restores no queue rows", async ({
  page
}) => {
  const initial = await openQueue(page);
  const refreshes = await holdRefreshes(page);
  try {
    for (const [, action] of actions) await answer(page, action);
    await page.route("**/human/mutations", async (route) => {
      const form = await requestForm(route);
      await route.fulfill({
        status: 409,
        json: {
          ok: false,
          operation: "undo",
          inputItemIds: [form.get("inputItemId")],
          code: "output_already_read",
          message: "Output result has already been read by the caller."
        }
      });
    });
    await undo(page);
    await expect(page.locator(".last-action-error")).toContainText(
      "already been read"
    );
    await page.unroute("**/human/mutations");
    const pending = initial.filter(
      (title) => !actions.some(([item]) => item === title)
    );
    await expectQueue(page, pending);
  } finally {
    await refreshes.release();
  }
  const pending = initial.filter(
    (title) => !actions.some(([item]) => item === title)
  );
  await sortByTitle(page);
  await expectQueueMembership(page, pending);
  await page.reload();
  await expectHydrated(page);
  await expectQueueMembership(page, pending);
  await expectHistory(
    page,
    actions.map(([title]) => title),
    pending
  );
});

async function openQueue(page: Page) {
  page.on("pageerror", (error) => {
    throw error;
  });
  await page.goto("/human");
  await expectHydrated(page);
  return page.locator(".row-title").allTextContents();
}

async function expectHydrated(page: Page) {
  // /human/mutations is client-only. SSR queue rows can already satisfy
  // membership assertions via the server-action fallback.
  await expect(page.getByTestId("workspace-hydrated")).toHaveText("hydrated");
}

function row(page: Page, title: string) {
  return page
    .locator("article.review-row")
    .filter({ has: page.locator(".row-title", { hasText: title }) });
}

function mutationResponse(page: Page) {
  return page.waitForResponse(
    (response) =>
      response.url().endsWith("/human/mutations") &&
      response.request().method() === "POST"
  );
}

async function answer(page: Page, action: string) {
  await expectHydrated(page);
  const response = mutationResponse(page);
  await page.getByRole("button", { name: action, exact: true }).click();
  expect((await response).ok()).toBe(true);
  await expect(
    page.getByRole("button", { name: `Undo “${action}”`, exact: true })
  ).toBeVisible();
}

async function undo(page: Page) {
  await expectHydrated(page);
  const response = mutationResponse(page);
  await page.getByTestId("last-answer-undo").click();
  await response;
}

async function expectQueue(page: Page, titles: string[]) {
  await expect(
    page.getByRole("heading", { name: "Needs review" })
  ).toBeVisible();
  await expect(page.locator(".row-title")).toHaveText(titles);
  await expect(page.getByLabel("Current view summary")).toHaveText(
    new RegExp(
      `^${titles.length}\\s*shown of ${titles.length} matching reviews$`
    )
  );
}

async function expectQueueMembership(page: Page, titles: string[]) {
  await expect(page.locator(".row-title")).toHaveCount(titles.length);
  await expect
    .poll(async () =>
      (await page.locator(".row-title").allTextContents()).sort()
    )
    .toEqual([...titles].sort());
  await expect(page.getByLabel("Current view summary")).toHaveText(
    new RegExp(
      `^${titles.length}\\s*shown of ${titles.length} matching reviews$`
    )
  );
}

async function expectHistory(
  page: Page,
  answered: string[],
  pending: string[]
) {
  await page
    .getByRole("navigation", { name: "Primary" })
    .getByRole("link", { name: "History", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Answered reviews" })
  ).toBeVisible();
  for (const title of answered) await expect(row(page, title)).toBeVisible();
  for (const title of pending) await expect(row(page, title)).toHaveCount(0);
}

async function showTools(page: Page) {
  const tools = page.getByRole("button", { name: "Review tools" });
  if (
    (await tools.isVisible()) &&
    (await tools.getAttribute("aria-expanded")) !== "true"
  )
    await tools.click();
}

async function sortByTitle(page: Page) {
  await showTools(page);
  await page.getByLabel(/^Sort:/).click();
  await page.getByLabel("Sort 1 field").selectOption({ label: "Title" });
  await page
    .getByRole("dialog", { name: "Sort reviews" })
    .getByRole("button", { name: "Done", exact: true })
    .click();
  await expect(
    page.getByRole("status").filter({ hasText: "View updated." })
  ).toContainText("Sorted by Title");
}

async function holdRefreshes(page: Page) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const handler = async (route: Route) => {
    if (
      route.request().method() === "GET" &&
      route.request().headers()["rsc"] === "1"
    )
      await gate;
    await route.continue();
  };
  await page.route("**/human**", handler);
  let released = false;
  return {
    release: async () => {
      if (released) return;
      released = true;
      release();
      await page.unrouteAll({ behavior: "wait" });
    }
  };
}

async function requestForm(route: Route) {
  return new Request(route.request().url(), {
    method: "POST",
    headers: route.request().headers(),
    body: new Uint8Array(route.request().postDataBuffer()!)
  }).formData();
}

async function bulkFailure(route: Route, outcome: "partial" | "none") {
  const form = await requestForm(route);
  const items = form
    .getAll("bulkItem")
    .map((value) => JSON.parse(String(value)) as { inputItemId: string });
  if (outcome === "none") {
    await route.fulfill({
      status: 409,
      json: {
        ok: false,
        operation: "bulk-answer",
        inputItemIds: items.map((item) => item.inputItemId),
        code: "bulk_answer_failed",
        message: "Bulk action failed: 2 not answered."
      }
    });
    return;
  }
  const first = form.getAll("bulkItem")[0];
  form.delete("bulkItem");
  form.append("bulkItem", first);
  const request = new Request(route.request().url(), {
    method: "POST",
    body: form
  });
  const response = await route.fetch({
    headers: {
      ...route.request().headers(),
      "content-type": request.headers.get("content-type")!
    },
    postData: Buffer.from(await request.arrayBuffer())
  });
  const result = await response.json();
  expect(result.ok).toBe(true);
  await route.fulfill({
    response,
    json: {
      ...result,
      inputItemIds: items.map((item) => item.inputItemId),
      failed: 1,
      message: "Bulk action complete: 1 answered, 1 failed."
    }
  });
}
