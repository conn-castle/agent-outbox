import { errors, expect, test } from "@playwright/test";

for (const path of ["/", "/human"]) {
  test(`a real hydration mismatch on ${path} emits exactly one hydration_error`, async ({
    page
  }) => {
    const events: unknown[] = [];
    const pageErrors: Error[] = [];
    page.on("pageerror", (error) => pageErrors.push(error));
    await page.route("**/api/client-events", async (route) => {
      events.push(...JSON.parse(route.request().postData() ?? "{}").events);
      await route.fulfill({ status: 202, body: "{}" });
    });
    // Change only server-rendered text, leaving matching RSC data untouched.
    const textPattern =
      path === "/"
        ? /(<h1[^>]*>)([^<]+)/
        : /(<span\b[^>]*data-testid="workspace-hydrated"[^>]*>)([^<]+)/;
    let altered = false;
    await page.route(
      (url) => url.pathname === path,
      async (route) => {
        if (route.request().resourceType() !== "document") {
          await route.continue();
          return;
        }
        const response = await route.fetch();
        const html = (await response.text()).replace(
          textPattern,
          (_match, open: string, text: string) => {
            altered = true;
            return `${open}Mismatch ${text}`;
          }
        );
        await route.fulfill({ response, body: html });
      }
    );

    await page.goto(path);
    expect(altered).toBe(true);
    if (path === "/human") {
      await expect(page.getByTestId("workspace-hydrated")).toHaveText(
        "hydrated"
      );
    } else {
      // The original heading must be restored by client hydration recovery.
      await expect(
        page.getByRole("heading", {
          level: 1,
          name: "Where agents wait for your decision.",
          exact: true
        })
      ).toBeVisible();
    }
    expect(
      pageErrors.some((error) =>
        error.message.includes("Minified React error #418")
      )
    ).toBe(true);
    await expect.poll(() => events).toEqual([{ name: "hydration_error" }]);

    // Observe subsequent requests for ten 50 ms flush intervals after recovery.
    // This catches delayed batches within the window; it cannot prove that no
    // duplicate will ever arrive beyond this bounded observation.
    await expect(
      page.waitForRequest(
        (request) => new URL(request.url()).pathname === "/api/client-events",
        { timeout: 500 }
      )
    ).rejects.toThrow(errors.TimeoutError);
    expect(events).toEqual([{ name: "hydration_error" }]);
  });
}
