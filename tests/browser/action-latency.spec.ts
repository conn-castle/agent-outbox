import { expect, test, type Locator, type Page } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.addEventListener(
      "click",
      () => {
        (
          window as Window & { __actionLatencyStartedAt?: number }
        ).__actionLatencyStartedAt = performance.now();
      },
      true
    );
  });
});

test("contact submission responds visibly within 20 ms", async ({ page }) => {
  const requestStarted = deferred();
  const releaseResponse = deferred();
  await page.route("**/api/contact", async (route) => {
    requestStarted.resolve();
    await releaseResponse.promise;
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ ok: false, message: "Held by latency test." })
    });
  });

  await page.goto("/contact");
  await fillValidContactForm(page);

  const button = page.getByRole("button", { name: "Send message" });
  const responseMsPromise = observeTextResponse(page, button, "Sending…");
  await button.evaluate((element) => (element as HTMLButtonElement).click());
  await requestStarted.promise;
  let responseMs: number;
  try {
    responseMs = await responseMsPromise;
  } finally {
    releaseResponse.resolve();
  }

  expect(responseMs).toBeLessThanOrEqual(20);
  await expect(page.getByRole("status")).toContainText("Held by latency test.");
});

test("billing checkout responds visibly within 20 ms", async ({ page }) => {
  const requestStarted = deferred();
  const releaseResponse = deferred();
  await page.route("**/api/billing/checkout", async (route) => {
    requestStarted.resolve();
    await releaseResponse.promise;
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        ok: false,
        error: { message: "Held by latency test." }
      })
    });
  });

  await page.goto("/upgrade");
  const button = page.getByRole("button", { name: "Start $5/mo checkout" });
  const feedback = button.locator(".billing-option-action");
  const responseMsPromise = observeTextResponse(page, feedback, "Starting...");
  await button.evaluate((element) => (element as HTMLButtonElement).click());
  await requestStarted.promise;
  let responseMs: number;
  try {
    responseMs = await responseMsPromise;
  } finally {
    releaseResponse.resolve();
  }

  expect(responseMs).toBeLessThanOrEqual(20);
  await expect(page.locator(".form-error")).toContainText(
    "Held by latency test."
  );
});

test("caller approval responds visibly within 20 ms", async ({
  page,
  request
}, testInfo) => {
  const start = await request.post("/api/caller/connect/browser/start", {
    headers: { "cf-connecting-ip": "203.0.113.250" },
    data: {
      local_caller_name: `latency-${testInfo.project.name}`,
      display_name: "Latency Test Caller",
      callback_url: "http://127.0.0.1:39010/caller/connect/callback"
    }
  });
  const startPayload = await start.json();
  expect(start.ok(), JSON.stringify(startPayload)).toBe(true);

  const actionRequestStarted = deferred();
  const releaseActionResponse = deferred();
  await page.route("**/caller/connect/approve**", async (route) => {
    if (route.request().method() === "POST") {
      actionRequestStarted.resolve();
      await releaseActionResponse.promise;
    }
    await route.continue();
  });

  const approvalUrl = new URL(startPayload.data.approval_url);
  approvalUrl.searchParams.set(
    "fixture_clerk_user_id",
    `action-latency-${testInfo.project.name}`
  );
  await page.goto(approvalUrl.toString());

  const button = page.getByRole("button", { name: "Approve connection" });
  const responseMsPromise = observeTextResponse(page, button, "Approving…");
  await button.evaluate((element) => (element as HTMLButtonElement).click());
  await actionRequestStarted.promise;
  let responseMs: number;
  try {
    responseMs = await responseMsPromise;
  } finally {
    releaseActionResponse.resolve();
  }

  expect(responseMs).toBeLessThanOrEqual(20);
  await expect(page).toHaveURL(/\/caller\/connect\/callback\?/);
});

test("invalid forms do not present pending feedback", async ({ page }) => {
  await page.goto("/contact");
  const button = page.getByRole("button", { name: "Send message" });

  await button.evaluate((element) => (element as HTMLButtonElement).click());

  await expect(button).toHaveText("Send message");
  await expect(page.getByLabel("Name")).toBeFocused();
});

test("contact submission can retry after a fast failure", async ({ page }) => {
  await page.addInitScript(() => {
    const originalFetch = window.fetch.bind(window);
    let contactAttempts = 0;
    window.fetch = (input, init) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input instanceof Request
              ? input.url
              : String(input);
      if (url.includes("/api/contact")) {
        contactAttempts += 1;
        if (contactAttempts === 1) {
          return Promise.reject(new TypeError("Failed to fetch"));
        }
      }
      return originalFetch(input, init);
    };
  });
  await page.route("**/api/contact", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true })
    });
  });

  await page.goto("/contact");
  await fillValidContactForm(page);

  const button = page.getByRole("button", { name: "Send message" });
  await button.click();
  await expect(page.getByRole("status")).toContainText(
    "Check your connection and try again."
  );
  await nextMacrotask(page);
  await expect(button).toHaveText("Send message");
  await expect(button).toBeEnabled();

  await button.click();
  await expect(page.getByRole("status")).toContainText(
    "Message sent. We’ll get back to you soon."
  );
});

test("billing checkout can retry after a fast failure", async ({ page }) => {
  await page.addInitScript(() => {
    const originalFetch = window.fetch.bind(window);
    let checkoutAttempts = 0;
    window.fetch = (input, init) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input instanceof Request
              ? input.url
              : String(input);
      if (url.includes("/api/billing/checkout")) {
        checkoutAttempts += 1;
        if (checkoutAttempts === 1) {
          return Promise.reject(new TypeError("Failed to fetch"));
        }
      }
      return originalFetch(input, init);
    };
  });
  await page.route("**/api/billing/checkout", async (route) => {
    await route.fulfill({
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({
        ok: false,
        error: { message: "Retry checkout." }
      })
    });
  });

  await page.goto("/upgrade");
  const button = page.getByRole("button", { name: "Start $5/mo checkout" });
  await button.click();
  await expect(page.locator(".form-error")).toContainText("Failed to fetch");
  await nextMacrotask(page);
  await expect(button.locator("[data-immediate-action-feedback]")).toHaveText(
    "Choose monthly"
  );
  await expect(button).toBeEnabled();

  await button.click();
  await expect(page.locator(".form-error")).toContainText("Retry checkout.");
  await expect(button).toBeEnabled();
});

async function observeTextResponse(
  page: Page,
  feedback: Locator,
  expectedText: string
) {
  await feedback.evaluate((element, text) => {
    const recordResponse = () => {
      const startedAt = (
        window as Window & { __actionLatencyStartedAt?: number }
      ).__actionLatencyStartedAt;
      if (startedAt === undefined) {
        throw new Error("Action latency test missed the click event.");
      }
      document.documentElement.dataset.actionResponseMs = String(
        performance.now() - startedAt
      );
    };
    const observer = new MutationObserver(() => {
      if (element.textContent?.includes(text)) {
        recordResponse();
        observer.disconnect();
      }
    });
    observer.observe(element, {
      childList: true,
      subtree: true,
      characterData: true
    });
  }, expectedText);

  return page
    .waitForFunction(
      () => document.documentElement.dataset.actionResponseMs !== undefined
    )
    .then(() =>
      page.evaluate(() =>
        Number(document.documentElement.dataset.actionResponseMs)
      )
    );
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fillValidContactForm(page: Page) {
  await page.getByLabel("Name").fill("Latency Tester");
  await page.getByLabel("Email").fill("latency@example.com");
  await page.getByLabel("What can we help with?").selectOption("Support");
  await page
    .getByLabel("Message")
    .fill("This valid test message is deliberately held open.");
}

async function nextMacrotask(page: Page) {
  await page.evaluate(
    () => new Promise<void>((resolve) => setTimeout(resolve, 0))
  );
}
