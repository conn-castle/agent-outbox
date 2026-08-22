import { expect, test } from "@playwright/test";

test("API docs teach the workflow and expose the generated contract", async ({
  page
}) => {
  await page.goto("/docs/api");

  await expect(
    page.getByRole("heading", {
      name: "Build your first human checkpoint",
      level: 1
    })
  ).toBeVisible();
  await expect(
    page.getByText("Guides + executable contract are verified together")
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "1. Send a review request", level: 2 })
  ).toBeVisible();
  await expect(page.getByText("<caller_api_key>").first()).toBeVisible();

  const docsNavigation = page.getByRole("navigation", {
    name: "API sections"
  });
  await expect(
    docsNavigation.getByRole("link", { name: "How it works" })
  ).toHaveAttribute("href", "/docs/api/concepts");
  await expect(
    docsNavigation.getByRole("link", { name: "Review patterns" })
  ).toHaveAttribute("href", "/docs/api/capabilities");
  await expect(
    docsNavigation.getByRole("link", { name: "UI integration" })
  ).toHaveAttribute("href", "/docs/api/ui");

  await docsNavigation.getByRole("link", { name: "UI integration" }).click();
  await expect(
    page.getByRole("heading", { name: "Build a UI integration", level: 1 })
  ).toBeVisible();
  await expect(
    page.getByText("Never ship it in browser JavaScript", { exact: false })
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "OpenAPI 3.1 document" })
  ).toHaveAttribute("href", "/docs/api/openapi.json");

  await docsNavigation.getByRole("link", { name: "API reference" }).click();
  await expect(
    page.getByRole("heading", { name: "API reference", level: 1 })
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: /POST \/api\/input\/send/, level: 3 })
  ).toBeVisible();
  await expect(
    page.locator(
      '.api-docs-on-page a[href="#post-api-output-output-result-id-read"]'
    )
  ).toHaveText("POST /api/output/{output_result_id}/read");
  await expect(
    page.getByRole("link", { name: "Download the OpenAPI 3.1 document" })
  ).toHaveAttribute("href", "/docs/api/openapi.json");
  await expect(
    page.getByRole("heading", { name: "Error codes", level: 2 })
  ).toBeVisible();
  await expect(
    page.getByText("pending_content_conflict").first()
  ).toBeVisible();

  const openapiResponse = await page.request.get("/docs/api/openapi.json");
  expect(openapiResponse.ok()).toBe(true);
  expect(openapiResponse.headers()["content-disposition"]).toContain(
    "agent-outbox-openapi.json"
  );
  const openapi = await openapiResponse.json();
  expect(openapi.openapi).toBe("3.1.0");
  expect(openapi.paths["/api/input/send"].post.operationId).toBe("sendInput");

  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth
    )
  ).toBe(true);
});

test("review-row anatomy uses the live structure and exposes content sizing", async ({
  page
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/docs/api/ui");

  await expect(
    page.locator('[aria-label="Content sizing borders"]')
  ).toContainText("Width + height can grow");

  const previews = page.locator(
    ".canonical-anatomy-viewport > .human-row-anatomy-preview"
  );
  await expect(previews).toHaveCount(4);
  await expect(previews.nth(3).locator(".review-row-anatomy")).toBeVisible();

  const galleryWidth = await page
    .locator(".review-row-anatomy-gallery")
    .evaluate((gallery) => gallery.getBoundingClientRect().width);
  const wideFrame = page.locator(".canonical-anatomy-frame").first();
  expect((await wideFrame.boundingBox())!.width).toBeLessThanOrEqual(
    galleryWidth
  );
  await expect(
    wideFrame.getByRole("link", { name: "Open preview" })
  ).toHaveAttribute("href", "/docs/api/row-anatomy?width=1200&mode=anatomy");
  await wideFrame.getByRole("button", { name: "Show example" }).click();
  await expect(
    wideFrame.getByRole("button", { name: "Show anatomy" })
  ).not.toHaveAttribute("aria-pressed");
  await expect(
    wideFrame.getByText("Reply to Acme Corp about the revised launch date")
  ).toBeVisible();
  await expect(wideFrame.locator(".row-type .lucide-mail")).toBeVisible();
  const exampleHeadingStyles = await wideFrame.evaluate((frame) => {
    const corner = frame.querySelector<HTMLElement>(".corner-meta")!;
    const contextLink = frame.querySelector<HTMLElement>(".context-links a")!;
    const contextStyles = getComputedStyle(contextLink);
    return {
      cornerFontSize: getComputedStyle(corner).fontSize,
      contextFontSize: contextStyles.fontSize,
      contextColor: contextStyles.color,
      accentColor: getComputedStyle(
        frame.querySelector<HTMLElement>(".row-details-link")!
      ).color
    };
  });
  expect(exampleHeadingStyles.contextFontSize).toBe(
    exampleHeadingStyles.cornerFontSize
  );
  expect(exampleHeadingStyles.contextColor).toBe(
    exampleHeadingStyles.accentColor
  );
  await expect(wideFrame.locator(".anatomy-slot")).toHaveCount(0);
  await expect(
    wideFrame.getByRole("link", { name: "Open preview" })
  ).toHaveAttribute("href", "/docs/api/row-anatomy?width=1200&mode=example");
  await wideFrame.getByRole("button", { name: "Show anatomy" }).click();
  await expect(wideFrame.locator(".anatomy-slot")).not.toHaveCount(0);
  const wideViewport = wideFrame.locator(".canonical-anatomy-viewport");
  await expect(wideViewport).not.toHaveAttribute("title");
  expect(
    await wideViewport.evaluate(
      (viewport) => viewport.scrollWidth > viewport.clientWidth
    )
  ).toBe(true);
  await wideViewport.dispatchEvent("wheel", { deltaY: 240 });
  await expect
    .poll(() => wideViewport.evaluate((viewport) => viewport.scrollLeft))
    .toBe(0);
  await wideViewport.scrollIntoViewIfNeeded();
  await wideViewport.hover();
  await page.mouse.wheel(240, 0);
  await expect
    .poll(() => wideViewport.evaluate((viewport) => viewport.scrollLeft))
    .toBeGreaterThan(0);
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth
    )
  ).toBe(true);

  await page.goto("/human");
  const productionStructure = await page
    .locator(".review-row")
    .first()
    .evaluate((row) =>
      [...row.children].map((child) => child.classList.item(0))
    );
  await expect(
    page.locator(".review-row").first().locator(".row-footer")
  ).toHaveCount(0);

  await page.setViewportSize({ width: 960, height: 700 });
  await page.goto("/docs/api/row-anatomy?width=960");
  const anatomyStructure = await page
    .locator(".review-row-anatomy")
    .evaluate((row) =>
      [...row.children].map((child) => child.classList.item(0))
    );
  expect(anatomyStructure).toEqual(productionStructure);

  const desktopPositions = await page
    .locator(".review-row-anatomy")
    .evaluate((row) => ({
      bodyLeft: row.querySelector(".row-body")!.getBoundingClientRect().left,
      actionsLeft: row.querySelector(".row-actions")!.getBoundingClientRect()
        .left
    }));
  expect(desktopPositions.actionsLeft).toBeGreaterThan(
    desktopPositions.bodyLeft
  );
  const desktopSummarySlots = await page
    .locator(".review-row-anatomy")
    .evaluate((row) => ({
      summaryRight: row
        .querySelector(".row-summary-content")!
        .getBoundingClientRect().right,
      detailsLeft: row
        .querySelector(".row-details-link")!
        .getBoundingClientRect().left
    }));
  expect(desktopSummarySlots.summaryRight).toBeLessThanOrEqual(
    desktopSummarySlots.detailsLeft
  );
  const desktopVerticalGap = await page
    .locator(".review-row-anatomy")
    .evaluate((row) => {
      const title = row.querySelector(".row-link")!.getBoundingClientRect();
      const summary = row
        .querySelector(".row-summary-content")!
        .getBoundingClientRect();
      return summary.top - title.bottom;
    });
  expect(desktopVerticalGap).toBeGreaterThanOrEqual(4);
  expect(desktopVerticalGap).toBeLessThanOrEqual(8);
  const headingToTitleGap = await page
    .locator(".review-row-anatomy")
    .evaluate((row) => {
      const heading = row
        .querySelector(".row-heading")!
        .getBoundingClientRect();
      const title = row.querySelector(".row-link")!.getBoundingClientRect();
      return title.top - heading.bottom;
    });
  expect(headingToTitleGap).toBeGreaterThanOrEqual(4);
  expect(headingToTitleGap).toBeLessThanOrEqual(8);
  await expect(
    page.locator(".row-skip-button .lucide-skip-forward")
  ).toBeVisible();
  await expect(
    page.locator('.row-utilities summary[aria-label="More actions"]')
  ).toBeVisible();
  const overflowGeometry = await page
    .locator('.row-utilities summary[aria-label="More actions"]')
    .evaluate((summary) => {
      const button = summary.getBoundingClientRect();
      const icon = summary.querySelector("svg")!.getBoundingClientRect();
      return {
        buttonCenter: button.left + button.width / 2,
        iconCenter: icon.left + icon.width / 2
      };
    });
  expect(overflowGeometry.iconCenter).toBeCloseTo(
    overflowGeometry.buttonCenter,
    1
  );
  await page
    .locator('.row-utilities summary[aria-label="More actions"]')
    .click();
  await expect(
    page
      .locator(".row-utilities .row-overflow-menu")
      .getByText("Overflow action")
  ).toBeVisible();
  expect(
    await page
      .locator(".row-context")
      .evaluate((visual) => visual.getBoundingClientRect().height)
  ).toBeGreaterThan(28);

  await page.setViewportSize({ width: 760, height: 800 });
  await page.goto("/docs/api/row-anatomy?width=760");
  const compactSummaryDetails = await page
    .locator(".review-row-anatomy")
    .evaluate((row) => {
      const summary = row
        .querySelector(".row-summary-content")!
        .getBoundingClientRect();
      const details = row
        .querySelector(".row-details-link")!
        .getBoundingClientRect();
      return {
        summaryRight: summary.right,
        summaryCenter: summary.top + summary.height / 2,
        detailsLeft: details.left,
        detailsCenter: details.top + details.height / 2
      };
    });
  expect(compactSummaryDetails.detailsLeft).toBeGreaterThanOrEqual(
    compactSummaryDetails.summaryRight
  );
  expect(compactSummaryDetails.detailsCenter).toBeCloseTo(
    compactSummaryDetails.summaryCenter,
    0
  );
  const tabletActionGeometry = await page
    .locator(".review-row-anatomy .inline-actions")
    .evaluate((actions) => {
      const buttons = [...actions.querySelectorAll("button")].map((button) =>
        button.getBoundingClientRect()
      );
      return {
        actionRailRight: actions.parentElement!.getBoundingClientRect().right,
        lastButtonRight: buttons.at(-1)!.right,
        buttonWidths: buttons.map((button) => button.width)
      };
    });
  expect(tabletActionGeometry.lastButtonRight).toBeCloseTo(
    tabletActionGeometry.actionRailRight,
    0
  );
  expect(tabletActionGeometry.buttonWidths.every((width) => width <= 192)).toBe(
    true
  );
  await page
    .locator(".review-row-anatomy .inline-action-button")
    .first()
    .evaluate((button) => button.remove());
  const singleTabletActionGeometry = await page
    .locator(".review-row-anatomy .inline-actions")
    .evaluate((actions) => ({
      actionRailRight: actions.parentElement!.getBoundingClientRect().right,
      buttonRight: actions.querySelector("button")!.getBoundingClientRect()
        .right
    }));
  expect(singleTabletActionGeometry.buttonRight).toBeCloseTo(
    singleTabletActionGeometry.actionRailRight,
    0
  );

  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto("/docs/api/row-anatomy?width=390");
  const compactPositions = await page
    .locator(".review-row-anatomy")
    .evaluate((row) => ({
      bodyTop: row.querySelector(".row-body")!.getBoundingClientRect().top,
      actionsTop: row.querySelector(".row-actions")!.getBoundingClientRect().top
    }));
  expect(compactPositions.actionsTop).toBeGreaterThan(compactPositions.bodyTop);
  const compactHeadingOrder = await page
    .locator(".row-heading")
    .evaluate((heading) => ({
      typeCenter: (() => {
        const bounds = heading
          .querySelector(".row-type")!
          .getBoundingClientRect();
        return bounds.top + bounds.height / 2;
      })(),
      typeBottom: heading.querySelector(".row-type")!.getBoundingClientRect()
        .bottom,
      utilitiesCenter: (() => {
        const bounds = heading
          .querySelector(".row-utilities")!
          .getBoundingClientRect();
        return bounds.top + bounds.height / 2;
      })(),
      contextTop: heading
        .querySelector(".row-heading-context")!
        .getBoundingClientRect().top
    }));
  expect(compactHeadingOrder.utilitiesCenter).toBeCloseTo(
    compactHeadingOrder.typeCenter,
    0
  );
  expect(compactHeadingOrder.contextTop).toBeGreaterThanOrEqual(
    compactHeadingOrder.typeBottom
  );
  await expect(page.locator(".row-actions .row-overflow")).toHaveCount(0);
  const compactSideAlignment = await page
    .locator(".row-side")
    .evaluate((side) => {
      const visual = side
        .querySelector(".row-context")!
        .getBoundingClientRect();
      const details = side
        .querySelector(".row-details-link")!
        .getBoundingClientRect();
      return {
        visualCenter: visual.top + visual.height / 2,
        detailsCenter: details.top + details.height / 2,
        detailsRight: details.right,
        sideRight: side.getBoundingClientRect().right
      };
    });
  expect(compactSideAlignment.detailsCenter).toBeCloseTo(
    compactSideAlignment.visualCenter,
    0
  );
  expect(compactSideAlignment.detailsRight).toBeCloseTo(
    compactSideAlignment.sideRight,
    0
  );
  const compactContextAlignment = await page
    .locator(".row-heading-context")
    .evaluate((context) => ({
      contextRight: context.getBoundingClientRect().right,
      linksRight: context
        .querySelector(".context-links")!
        .getBoundingClientRect().right
    }));
  expect(compactContextAlignment.linksRight).toBeCloseTo(
    compactContextAlignment.contextRight,
    0
  );
  await page.goto("/docs/api/row-anatomy?width=390&mode=example");
  const compactExampleAccessibility = await page
    .locator(".review-row-example")
    .evaluate((row) => {
      const subtitle = row.querySelector<HTMLElement>(".row-subtitle")!;
      const actions = [
        ...row.querySelectorAll<HTMLElement>(".inline-action-button")
      ];
      return {
        subtitleWhiteSpace: getComputedStyle(subtitle).whiteSpace,
        subtitleFits: subtitle.scrollWidth <= subtitle.clientWidth,
        actionHeights: actions.map(
          (action) => action.getBoundingClientRect().height
        ),
        actionWidths: actions.map(
          (action) => action.getBoundingClientRect().width
        ),
        actionRailRight: row
          .querySelector<HTMLElement>(".row-actions")!
          .getBoundingClientRect().right,
        lastActionRight: actions.at(-1)!.getBoundingClientRect().right
      };
    });
  expect(compactExampleAccessibility.subtitleWhiteSpace).toBe("normal");
  expect(compactExampleAccessibility.subtitleFits).toBe(true);
  expect(
    compactExampleAccessibility.actionHeights.every((height) => height >= 44)
  ).toBe(true);
  expect(
    compactExampleAccessibility.actionWidths.every((width) => width <= 192)
  ).toBe(true);
  expect(compactExampleAccessibility.lastActionRight).toBeCloseTo(
    compactExampleAccessibility.actionRailRight,
    0
  );

  const titleSlot = page.locator(".review-row-anatomy .row-link");
  await expect(titleSlot).toHaveJSProperty("tagName", "A");
  await expect(titleSlot).toHaveAttribute("href", "#review-row-anatomy");
  await expect(titleSlot).toHaveAttribute(
    "aria-label",
    "Review row anatomy details"
  );
  const initialTitleBox = await titleSlot.boundingBox();
  expect(initialTitleBox).not.toBeNull();
  await page.locator(".review-row-anatomy .row-title").evaluate((title) => {
    title.textContent =
      "A realistic long review title that needs additional vertical space without changing its assigned column width";
  });
  await expect
    .poll(async () => (await titleSlot.boundingBox())?.height ?? 0)
    .toBeGreaterThan(initialTitleBox!.height);
  const expandedTitleBox = await titleSlot.boundingBox();
  expect(expandedTitleBox!.width).toBeCloseTo(initialTitleBox!.width, 0);

  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto("/docs/api/ui");
  const compactHeaderOverlap = await page
    .locator(".canonical-anatomy-frame")
    .first()
    .evaluate((frame) => {
      const heading = frame
        .querySelector(".canonical-anatomy-heading")!
        .getBoundingClientRect();
      const actions = frame
        .querySelector(".canonical-anatomy-actions")!
        .getBoundingClientRect();
      return (
        Math.max(
          0,
          Math.min(heading.right, actions.right) -
            Math.max(heading.left, actions.left)
        ) *
        Math.max(
          0,
          Math.min(heading.bottom, actions.bottom) -
            Math.max(heading.top, actions.top)
        )
      );
    });
  expect(compactHeaderOverlap).toBe(0);
});
