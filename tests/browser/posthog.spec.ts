import { expect, test, type Page } from "@playwright/test";
import { gunzipSync } from "node:zlib";

type CapturedEvent = { event: string; properties: Record<string, unknown> };

function decodedEvents(payload: Buffer): CapturedEvent[] {
  const text =
    payload[0] === 0x1f && payload[1] === 0x8b
      ? gunzipSync(payload).toString("utf8")
      : payload.toString("utf8");
  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : (parsed.batch ?? [parsed]);
}

// Chromium's protocol can omit Blob POST bodies. Observe the SDK's beacon
// argument while exercising its pagehide handler. The separate unmocked
// fixture-proxy test verifies that escaped beacons cannot reach PostHog.
async function captureUnloadEvents(page: Page): Promise<CapturedEvent[]> {
  const payloads = await page.evaluate(async () => {
    const original = navigator.sendBeacon;
    const payloads: Promise<number[]>[] = [];
    navigator.sendBeacon = function (url, data) {
      if (new URL(url, location.href).pathname.startsWith("/lantern/")) {
        if (!(data instanceof Blob))
          throw new Error("Expected a PostHog beacon Blob");
        payloads.push(
          data.arrayBuffer().then((buffer) => [...new Uint8Array(buffer)])
        );
      }
      return true;
    };
    try {
      window.dispatchEvent(new PageTransitionEvent("pagehide"));
      return await Promise.all(payloads);
    } finally {
      navigator.sendBeacon = original;
    }
  });
  return payloads.flatMap((bytes) => decodedEvents(Buffer.from(bytes)));
}

test("PostHog sends automatic owner pageviews and excludes protected interactions", async ({
  page,
  context
}) => {
  const events: CapturedEvent[] = [];
  const requests: string[] = [];
  // Observe payloads independently of route fulfillment. The compiled fixture
  // proxy also blocks beacons that escape browser interception during teardown.
  context.on("request", (request) => {
    if (!new URL(request.url()).pathname.startsWith("/lantern/")) return;
    requests.push(request.url());
    const payload = request.postDataBuffer();
    if (payload) events.push(...decodedEvents(payload));
  });
  await page.route("**/lantern/**", async (route) => {
    await route.fulfill({
      status: 200,
      body: "{}",
      contentType: "application/json"
    });
  });
  const pageviews = () => events.filter((event) => event.event === "$pageview");
  await page.goto(
    "/human?owner=1&user_code=private-device-code&__posthog_test_capture=1#private-hash"
  );
  await expect(page.getByTestId("workspace-hydrated")).toHaveText("hydrated");
  await expect(page).not.toHaveURL(/owner=1/);
  await expect(page).toHaveURL(
    /user_code=private-device-code&__posthog_test_capture=1#private-hash/
  );
  await expect.poll(() => pageviews().length).toBeGreaterThan(0);
  expect(pageviews()[0].properties.is_owner).toBe(true);
  // The review layout must retain its existing direct-child CSS contract.
  await expect(
    page.locator(".shell > .human-workspace.ph-no-capture")
  ).toBeVisible();
  await page
    .locator("a.row-link")
    .filter({ hasText: "Reply to Meridian about the renewal delay" })
    .click();
  await expect(page).toHaveURL(/item=/);
  expect(events.filter((event) => event.event === "$autocapture")).toHaveLength(
    0
  );
  await page.goBack();
  await expect(page).not.toHaveURL(/owner=1/);
  await expect(page).toHaveURL(
    /user_code=private-device-code&__posthog_test_capture=1#private-hash/
  );
  events.push(...(await captureUnloadEvents(page)));
  await expect
    .poll(() =>
      events.some(
        (event) =>
          event.event === "$pageleave" &&
          new URL(String(event.properties.$current_url)).pathname === "/human"
      )
    )
    .toBe(true);
  await page.goto("/privacy-policy?__posthog_test_capture=1");
  await expect
    .poll(() =>
      pageviews().some((event) =>
        String(event.properties.$current_url).endsWith("/privacy-policy")
      )
    )
    .toBe(true);
  const beforeNavigation = pageviews().length;
  await page
    .getByRole("link", { name: "Terms of Service", exact: true })
    .click();
  await expect(page).toHaveURL(/\/terms-of-service$/);
  await expect.poll(() => pageviews().length).toBeGreaterThan(beforeNavigation);
  for (const event of pageviews()) expect(event.properties.is_owner).toBe(true);
  events.push(...(await captureUnloadEvents(page)));
  await expect
    .poll(() =>
      events.some(
        (event) =>
          event.event === "$pageleave" &&
          new URL(String(event.properties.$current_url)).pathname ===
            "/terms-of-service"
      )
    )
    .toBe(true);
  const leaves = events.filter((event) => event.event === "$pageleave");
  expect(
    leaves.some(
      (event) =>
        new URL(String(event.properties.$current_url)).pathname === "/human"
    )
  ).toBe(true);
  for (const event of leaves) {
    const url = new URL(String(event.properties.$current_url));
    expect(url.search).toBe("");
    expect(url.hash).toBe("");
    expect(event.properties.is_owner).toBe(true);
  }
  await page.goto("about:blank");
  const sent = JSON.stringify(events);
  expect(sent).not.toContain("Reply to Meridian about the renewal delay");
  expect(sent).not.toContain("private-device-code");
  expect(sent).not.toContain("private-hash");
  expect(requests.some((url) => url.includes("/flags"))).toBe(false);
});

test("PostHog captures masked public clicks", async ({ page }) => {
  const events: CapturedEvent[] = [];
  await page.route("**/lantern/**", async (route) => {
    const payload = route.request().postDataBuffer();
    if (payload) events.push(...decodedEvents(payload));
    await route.fulfill({
      status: 200,
      body: "{}",
      contentType: "application/json"
    });
  });
  await page.goto("/?__posthog_test_capture=1");
  await page.getByRole("link", { name: "Explore the product" }).click();
  await expect
    .poll(() => events.filter((event) => event.event === "$autocapture").length)
    .toBeGreaterThan(0);
  const click = events.find((event) => event.event === "$autocapture")!;
  expect(click.properties.$event_type).toBe("click");
  expect(JSON.stringify(click)).not.toContain("Explore the product");
  expect(JSON.stringify(click)).not.toContain("#product");
});

test("browser fixture proxy absorbs unmocked unload beacons locally", async ({
  request
}) => {
  const response = await request.post("/lantern/e/", {
    data: { event: "$pageleave", properties: { fixture: true } }
  });
  expect(response.status()).toBe(200);
  expect(response.headers()["cache-control"]).toBe("no-store");
  expect(await response.json()).toEqual({});
});
