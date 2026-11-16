import {
  continueWithChangedForm,
  continueWithStaleBulkItems,
  mutationForm
} from "./human-mutation-routes";
import { openPrimaryNavigation } from "./navigation";
import { expect, test, type Page, type Route } from "@playwright/test";

const permit = "Review neighborhood permit brief";
const followUp = "Choose follow-up window";
const email = "Reply to Meridian about the renewal delay";
const actions = [
  [permit, "Approve permit brief"],
  [followUp, "Approve follow-up"],
  [email, "Approve to send"]
] as const;

test("undo walks back through answers, most recent first, across history and reload", async ({
  page
}) => {
  const initial = await openQueue(page);
  for (const [, action] of actions) await answer(page, action);
  await expectQueue(page, without(initial, permit, followUp, email));

  await undo(page);
  await expectQueue(page, without(initial, permit, followUp));
  await expectUndoOffered(page, "Approve follow-up");
  await expectHistory(page, [permit, followUp], [email]);
  await openReviewQueue(page);

  await undo(page);
  await expectQueue(page, without(initial, permit));
  await expectUndoOffered(page, "Approve permit brief");

  await undo(page);
  await expectQueue(page, initial);
  await expect(page.getByTestId("last-answer-undo")).toHaveCount(0);

  await page.reload();
  await expectHydrated(page);
  await expectQueue(page, initial);
  await expectHistory(page, [], [permit, followUp, email]);
});

test("repeated undo without waiting for the server reverses every answer", async ({
  page
}) => {
  const initial = await openQueue(page);
  for (const [, action] of actions) await answer(page, action);

  const restored = waitForMutations(page, actions.length);
  for (const [, action] of [...actions].reverse()) {
    await page
      .getByRole("button", { name: `Undo “${action}”`, exact: true })
      .click();
  }
  await restored;
  await expectQueue(page, initial);
  await expect(page.getByTestId("last-answer-undo")).toHaveCount(0);

  await page.reload();
  await expectHydrated(page);
  await expectQueue(page, initial);
  await expectHistory(page, [], [permit, followUp, email]);
});

test("undo targets the newest answer while it is still saving", async ({
  page
}) => {
  const initial = await openQueue(page);
  await answer(page, "Approve permit brief");

  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requests = 0;
  await page.route("**/human/mutations", async (route) => {
    requests += 1;
    if (requests === 1) await held;
    await route.continue();
  });
  await page
    .getByRole("button", { name: "Approve follow-up", exact: true })
    .click();
  await expect.poll(() => requests).toBe(1);
  // The earlier, already-saved answer must not be what Undo acts on.
  await expectUndoOffered(page, "Approve follow-up");
  await page.getByTestId("last-answer-undo").click();
  await expect(page.getByTestId("last-answer-undo")).toBeDisabled();
  expect(requests, "Undo waits for the answer it reverses.").toBe(1);

  const settled = waitForMutations(page, 2);
  release();
  await settled;
  await page.unroute("**/human/mutations");
  await expectQueue(page, without(initial, permit));
  await expectUndoOffered(page, "Approve permit brief");

  await page.reload();
  await expectHydrated(page);
  await expectQueue(page, without(initial, permit));
  await expectHistory(page, [permit], [followUp]);
});

test("undo reverses a whole bulk answer as one step", async ({ page }) => {
  const initial = await openQueue(page);
  await answer(page, "Approve to send");
  await selectRows(page, [permit, followUp]);
  const bulk = mutationResponse(page);
  await applyBulk(page);
  expect((await bulk).ok()).toBe(true);
  await expectQueue(page, without(initial, permit, followUp, email));
  await expect(
    page.getByRole("button", {
      name: "Undo “Approve permit brief” for 2 reviews",
      exact: true
    })
  ).toBeVisible();

  await undo(page);
  await expectQueue(page, without(initial, email));
  await expectUndoOffered(page, "Approve to send");
  await expectHistory(page, [email], [permit, followUp]);
  await openReviewQueue(page);

  await undo(page);
  await expectQueue(page, initial);
  await expect(page.getByTestId("last-answer-undo")).toHaveCount(0);

  await page.reload();
  await expectHydrated(page);
  await expectQueue(page, initial);
  await expectHistory(page, [], [permit, followUp, email]);
});

test("a partly failed bulk undo keeps offering the answers it did not restore", async ({
  page
}) => {
  const initial = await openQueue(page);
  await selectRows(page, [permit, followUp]);
  const answered = mutationResponse(page);
  await applyBulk(page);
  expect((await answered).ok()).toBe(true);
  await expectQueueMembership(page, without(initial, permit, followUp));

  // The second answer's undo names an output the server does not hold, so
  // the server restores only the first.
  await page.route("**/human/mutations", (route) =>
    continueWithChangedForm(route, (form) => {
      const [first] = form.getAll("outputResultId");
      form.delete("outputResultId");
      form.append("outputResultId", first);
      form.append("outputResultId", "00000000-0000-4000-8000-00000000dead");
    })
  );
  await undo(page);
  await expect(page.locator(".last-action-error")).toContainText(
    "1 restored, 1 failed"
  );
  await page.unroute("**/human/mutations");
  await expectQueueMembership(page, without(initial, followUp));

  // The same action is offered again for the answer still in History.
  await expectUndoOffered(page, "Approve permit brief");
  await undo(page);
  await expectQueueMembership(page, initial);
  await expect(page.getByTestId("last-answer-undo")).toHaveCount(0);
  await page.reload();
  await expectHydrated(page);
  await expectQueueMembership(page, initial);
});

test("a repeated undo is recognized only for the answer it undid", async ({
  page
}) => {
  const initial = await openQueue(page);
  await answer(page, "Approve permit brief");
  let sent: [string, string][] = [];
  await page.route("**/human/mutations", async (route) => {
    const form = await mutationForm(route.request());
    sent = [...form.entries()].map(([key, value]) => [key, String(value)]);
    await route.continue();
  });
  await undo(page);
  await expectQueue(page, initial);
  await page.unroute("**/human/mutations");

  const repeat = (fields: [string, string][]) =>
    page.evaluate(async (entries) => {
      const body = new FormData();
      for (const [key, value] of entries) body.append(key, value);
      const response = await fetch("/human/mutations", {
        method: "POST",
        body
      });
      return { status: response.status, result: await response.json() };
    }, fields);
  expect(await repeat(sent)).toMatchObject({
    status: 200,
    result: { ok: true, operation: "undo" }
  });
  // The item is restored, but not by undoing this output.
  expect(
    await repeat(
      sent.map(([key, value]) => [
        key,
        key === "outputResultId"
          ? "00000000-0000-4000-8000-00000000dead"
          : value
      ])
    )
  ).toMatchObject({ status: 409, result: { ok: false, code: "not_found" } });
});

test("an answer undone from History leaves the remaining undo order intact", async ({
  page
}) => {
  const initial = await openQueue(page);
  for (const [, action] of actions) await answer(page, action);
  await expectHistory(page, [permit, followUp, email], []);
  await page
    .getByRole("link", {
      name: `Open review details for ${followUp}`,
      exact: true
    })
    .first()
    .click();
  const restored = mutationResponse(page);
  await page.getByRole("button", { name: "Undo answer", exact: true }).click();
  await restored;
  await openReviewQueue(page);
  await expectQueue(page, without(initial, permit, email));

  await expectUndoOffered(page, "Approve to send");
  await undo(page);
  await expectQueue(page, without(initial, permit));
  // The answer already undone from History is not offered again.
  await expectUndoOffered(page, "Approve permit brief");
  await undo(page);
  await expectQueue(page, initial);
  await expect(page.getByTestId("last-answer-undo")).toHaveCount(0);

  await page.reload();
  await expectHydrated(page);
  await expectQueue(page, initial);
  await expectHistory(page, [], [permit, followUp, email]);
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

      // The request is sent on with the failing items made stale, so the
      // endpoint itself rejects them and History and reload see its writes.
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
      await openPrimaryNavigation(page);
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

for (const outcome of ["partial", "none"] as const) {
  test(`bulk apply can be resubmitted after a ${outcome === "partial" ? "partially" : "fully"} failed bulk answer`, async ({
    page
  }) => {
    const initial = await openQueue(page);
    await selectRows(page, [permit, followUp]);
    await page.route("**/human/mutations", (route) =>
      bulkFailure(route, outcome)
    );
    const failed = mutationResponse(page);
    await applyBulk(page);
    await failed;
    await expect(page.locator(".last-action-error")).toContainText(
      outcome === "partial" ? "1 failed" : "2 not answered"
    );
    await page.unroute("**/human/mutations");
    await expectQueueMembership(
      page,
      outcome === "partial"
        ? initial.filter((title) => title !== permit)
        : initial
    );
    // Only the failed rows stay selected; none are reported as off-page.
    await expect(page.locator(".bulk-actions")).toContainText(
      outcome === "partial"
        ? "1 selected pending row"
        : "2 selected pending rows"
    );
    await expect(page.locator(".bulk-actions")).not.toContainText(
      "other pages"
    );

    const retried = mutationResponse(page);
    await page
      .getByRole("button", {
        name:
          outcome === "partial"
            ? "Apply Approve follow-up"
            : "Apply Approve permit brief",
        exact: true
      })
      .click();
    expect((await retried).ok()).toBe(true);
    const pending = initial.filter(
      (title) => title !== permit && title !== followUp
    );
    await expectQueueMembership(page, pending);
    await page.reload();
    await expectHydrated(page);
    await expectQueueMembership(page, pending);
  });
}

test("a bulk answer whose response is lost is retried without answering twice", async ({
  page
}) => {
  // Only the first attempt times out; the retry uses the normal timeout.
  await page.addInitScript(() => {
    const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
    let intercepted = false;
    AbortSignal.timeout = (ms: number) => {
      if (ms !== 20_000 || intercepted) return originalTimeout(ms);
      intercepted = true;
      return originalTimeout(50);
    };
  });
  const initial = await openQueue(page);
  await selectRows(page, [permit]);
  const mutationIds: string[] = [];
  await page.route("**/human/mutations", async (route) => {
    mutationIds.push(
      String((await mutationForm(route.request())).get("mutationId"))
    );
    if (mutationIds.length > 1) return route.continue();
    // The write commits, but its response never reaches the timed-out client.
    await route.fetch();
  });
  const retried = mutationResponse(page);
  await applyBulk(page);
  expect((await retried).ok()).toBe(true);
  await page.unroute("**/human/mutations");
  expect(mutationIds).toHaveLength(2);
  expect(mutationIds[1]).toBe(mutationIds[0]);

  const pending = without(initial, permit);
  await expectQueueMembership(page, pending);
  await expect(page.locator(".bulk-actions")).toHaveCount(0);
  await expect(page.locator(".last-action-error")).toHaveCount(0);
  // The retry reported the one committed answer, so Undo reverses it.
  await expectUndoOffered(page, "Approve permit brief");
  await undo(page);
  await expectQueueMembership(page, initial);
  await page.reload();
  await expectHydrated(page);
  await expectQueueMembership(page, initial);
});

test("a bulk answer that never reaches the server keeps visible selections for retry", async ({
  page
}) => {
  const initial = await openQueue(page, "/human?fixture_dataset=pagination");
  await selectRows(page, [permit, followUp]);
  let attempts = 0;
  await page.route("**/human/mutations", (route) => {
    attempts += 1;
    return route.abort();
  });
  await applyBulk(page);
  // The rows stay hidden while the client retries, then return with an error.
  await expect(row(page, permit)).toHaveCount(0);
  await expect(page.locator(".last-action-error")).toContainText(
    "could not be reached"
  );
  expect(attempts).toBe(3);
  await expect(page.locator(".row-title")).toHaveText(initial);
  for (const title of [permit, followUp])
    await expect(
      row(page, title).getByRole("checkbox", { name: "Select review" })
    ).toBeChecked();
  await expect(page.locator(".bulk-actions")).toContainText(
    "2 selected pending rows"
  );
  await page.unroute("**/human/mutations");
  const retried = mutationResponse(page);
  await applyBulk(page);
  expect((await retried).ok()).toBe(true);
  await expect(row(page, permit)).toHaveCount(0);
  await expect(row(page, followUp)).toHaveCount(0);
  await expect(page.locator(".bulk-actions")).toHaveCount(0);
  await page.reload();
  await expectHydrated(page);
  await expect(row(page, permit)).toHaveCount(0);
  await expect(row(page, followUp)).toHaveCount(0);
  await expectHistory(page, [permit, followUp], []);
});

for (const offView of ["filter", "page"] as const) {
  test(`a bulk answer that never reaches the server keeps selections off-${offView} for retry`, async ({
    page
  }) => {
    const initial = await openQueue(
      page,
      offView === "page" ? "/human?fixture_dataset=pagination" : "/human"
    );
    await selectRows(page, [permit, followUp]);
    const started = page.waitForRequest((request) =>
      request.url().endsWith("/human/mutations")
    );
    // The first attempt fails only after the changed view reaches the browser.
    let failFirstAttempt!: () => void;
    const viewChanged = new Promise<void>((resolve) => {
      failFirstAttempt = resolve;
    });
    await page.route("**/human/mutations", async (route) => {
      await viewChanged;
      await route.abort();
    });
    await applyBulk(page);
    await started;
    if (offView === "filter") {
      await showTools(page);
      await page
        .getByRole("textbox", { name: "Search", exact: true })
        .fill("Meridian");
      await expect(page).toHaveURL(/search=Meridian/);
      await expect(page.locator(".row-title")).toHaveText([email]);
    } else {
      await page.getByRole("button", { name: "Next 100", exact: true }).click();
      await expect(page).toHaveURL(/page=2/);
      await expect(row(page, permit)).toHaveCount(0);
      await expect(row(page, followUp)).toHaveCount(0);
    }

    failFirstAttempt();
    await expect(page.locator(".last-action-error")).toContainText(
      "could not be reached"
    );
    await expect(page.locator(".bulk-actions")).toContainText(
      "2 selected on other pages"
    );

    if (offView === "filter") {
      await page.getByRole("textbox", { name: "Search", exact: true }).fill("");
      await expect(page).not.toHaveURL(/search=/);
    } else {
      await page
        .getByRole("button", { name: "Previous 100", exact: true })
        .click();
      await expect(page).not.toHaveURL(/page=2/);
    }
    await expect(page.locator(".row-title")).toHaveText(initial);
    for (const title of [permit, followUp])
      await expect(
        row(page, title).getByRole("checkbox", { name: "Select review" })
      ).toBeChecked();
    await expect(page.locator(".bulk-actions")).toContainText(
      "2 selected pending rows"
    );
    await page.unroute("**/human/mutations");
    const retried = mutationResponse(page);
    await applyBulk(page);
    expect((await retried).ok()).toBe(true);
    const pending = initial.filter(
      (title) => title !== permit && title !== followUp
    );
    if (offView === "filter") await expectQueueMembership(page, pending);
    else {
      // The next page fills the two vacated positions on the first page.
      await expect(row(page, permit)).toHaveCount(0);
      await expect(row(page, followUp)).toHaveCount(0);
    }
    await expect(page.locator(".bulk-actions")).toHaveCount(0);
    await expectHistory(page, [permit, followUp], []);
  });
}

test("repeated bulk apply before the queue updates sends one request", async ({
  page
}) => {
  const initial = await openQueue(page);
  await selectRows(page, [permit, followUp]);
  let requests = 0;
  page.on("request", (request) => {
    if (
      request.url().endsWith("/human/mutations") &&
      request.method() === "POST"
    )
      requests += 1;
  });
  const response = mutationResponse(page);
  // Both clicks run in one task, before any optimistic render can disable it.
  await page
    .getByRole("button", { name: "Apply Approve permit brief", exact: true })
    .evaluate((button: HTMLButtonElement) => {
      button.click();
      button.click();
    });
  expect((await response).ok()).toBe(true);
  const pending = initial.filter(
    (title) => title !== permit && title !== followUp
  );
  await expectQueueMembership(page, pending);
  await page.reload();
  await expectHydrated(page);
  await expectQueueMembership(page, pending);
  expect(requests).toBe(1);
});

test("bulk apply answers a new selection after a successful bulk answer", async ({
  page
}) => {
  const initial = await openQueue(page);
  await selectRows(page, [permit]);
  const first = mutationResponse(page);
  await applyBulk(page);
  expect((await first).ok()).toBe(true);
  await expectQueueMembership(
    page,
    initial.filter((title) => title !== permit)
  );
  // Answered rows leave the selection, so none are reported as off-page.
  await expect(page.locator(".bulk-actions")).toHaveCount(0);

  await row(page, followUp)
    .getByRole("checkbox", { name: "Select review" })
    .check();
  await expect(page.locator(".bulk-actions")).toContainText(
    "1 selected pending row"
  );
  await expect(page.locator(".bulk-actions")).not.toContainText("other pages");
  const second = mutationResponse(page);
  await page
    .getByRole("button", { name: "Apply Approve follow-up", exact: true })
    .click();
  expect((await second).ok()).toBe(true);
  const pending = initial.filter(
    (title) => title !== permit && title !== followUp
  );
  await expectQueueMembership(page, pending);
  await page.reload();
  await expectHydrated(page);
  await expectQueueMembership(page, pending);
});

for (const [code, message] of [
  ["output_already_read", "Output result has already been read by the caller."],
  ["not_found", "Output result was not found."]
] as const) {
  test(`${code} undo rejection keeps answered items in History and withdraws that Undo`, async ({
    page
  }) => {
    const initial = await openQueue(page);
    const refreshes = await holdRefreshes(page);
    try {
      for (const [, action] of actions) await answer(page, action);
      await page.route("**/human/mutations", async (route) => {
        const form = await mutationForm(route.request());
        await route.fulfill({
          status: 409,
          json: {
            ok: false,
            operation: "undo",
            inputItemIds: [form.get("inputItemId")],
            code,
            message
          }
        });
      });
      await undo(page);
      await expect(page.locator(".last-action-error")).toContainText(message);
      // The rejection is permanent, so that answer is no longer offered; the
      // answer before it is.
      await expectUndoOffered(page, "Approve follow-up");
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
}

test("temporarily failed undo keeps Undo available for retry", async ({
  page
}) => {
  const [, action] = actions[0];
  await openQueue(page);
  await answer(page, action);
  await page.route("**/human/mutations", (route) =>
    route.fulfill({ status: 503, body: "Service Unavailable" })
  );
  await undo(page);
  await expect(page.locator(".last-action-error")).toContainText(
    "temporarily unavailable"
  );
  await page.unroute("**/human/mutations");
  await expect(
    page.getByRole("button", { name: `Undo “${action}”`, exact: true })
  ).toBeVisible();
});

async function openQueue(page: Page, href = "/human") {
  page.on("pageerror", (error) => {
    throw error;
  });
  await page.goto(href);
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

function without(titles: string[], ...removed: string[]) {
  return titles.filter((title) => !removed.includes(title));
}

// The single Undo control names the action it will reverse.
async function expectUndoOffered(page: Page, action: string) {
  await expect(page.getByTestId("last-answer-undo")).toHaveAccessibleName(
    `Undo “${action}”`
  );
}

async function waitForMutations(page: Page, count: number) {
  let seen = 0;
  await page.waitForResponse((response) => {
    if (
      response.url().endsWith("/human/mutations") &&
      response.request().method() === "POST"
    )
      seen += 1;
    return seen >= count;
  });
}

async function openReviewQueue(page: Page) {
  await openPrimaryNavigation(page);
  await page
    .getByRole("navigation", { name: "Primary" })
    .getByRole("link", { name: "Review queue", exact: true })
    .click();
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
  await openPrimaryNavigation(page);
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

async function selectRows(page: Page, titles: string[]) {
  await showTools(page);
  await page.getByRole("button", { name: "Select items", exact: true }).click();
  for (const title of titles)
    await row(page, title)
      .getByRole("checkbox", { name: "Select review" })
      .check();
}

async function applyBulk(page: Page) {
  await page
    .getByRole("button", { name: "Apply Approve permit brief", exact: true })
    .click();
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

/** Has the endpoint reject the last ("partial") or every ("none") item. */
async function bulkFailure(route: Route, outcome: "partial" | "none") {
  await continueWithStaleBulkItems(
    route,
    (index) => outcome === "none" || index > 0
  );
}
