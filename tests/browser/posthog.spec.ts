import { expect, test } from "@playwright/test";
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

test("PostHog sends automatic owner pageviews and excludes protected interactions", async ({
  page
}) => {
  const events: CapturedEvent[] = [];
  const requests: string[] = [];
  await page.route("**/lantern/**", async (route) => {
    requests.push(route.request().url());
    const payload = route.request().postDataBuffer();
    if (payload) events.push(...decodedEvents(payload));
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
