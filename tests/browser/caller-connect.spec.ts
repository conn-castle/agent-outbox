import { expect, test } from "@playwright/test";

// Each Playwright worker runs in its own process, so this module is evaluated
// once per worker with a distinct TEST_WORKER_INDEX (the documented equivalent
// of testInfo.workerIndex, globally unique across projects). Deriving the
// forwarded client IP from it keeps every worker in its own per-IP rate-limit
// window (30/min per operation kind), so concurrent projects/workers never
// share a bucket and trip sporadic 429s. 203.0.113.0/24 is TEST-NET-3, reserved
// for documentation/tests; the octet stays in 1..254 to remain a valid host.
const workerIndex = Number.parseInt(process.env.TEST_WORKER_INDEX ?? "0", 10);
const clientIpOctet = ((Number.isNaN(workerIndex) ? 0 : workerIndex) % 254) + 1;
const connectRequestHeaders = {
  "x-forwarded-for": `203.0.113.${clientIpOctet}`
};

test.beforeEach(({ page }) => {
  page.on("pageerror", (error) => {
    throw error;
  });
});

test("terminal pages derive persisted setup state instead of URL outcome text", async ({
  page,
  request
}, testInfo) => {
  const fixtureUserId = connectFixtureUserId(testInfo, "terminal");

  const approvedStart = await request.post("/api/caller/connect/device/start", {
    headers: connectRequestHeaders,
    data: {
      local_caller_name: connectCallerSlug(testInfo, "terminal-approved"),
      display_name: "Terminal Device Caller"
    }
  });
  const approvedStartPayload = await approvedStart.json();
  expect(approvedStart.ok(), JSON.stringify(approvedStartPayload)).toBe(true);

  await page.goto(
    `/caller/connect/device?user_code=${encodeURIComponent(
      approvedStartPayload.data.user_code
    )}&fixture_clerk_user_id=${fixtureUserId}`
  );
  await page.getByRole("button", { name: "Approve caller" }).click();
  await expect(page).toHaveURL(/\/caller\/connect\/success/);

  const forgedSuccessUrl = new URL(page.url());
  expect(forgedSuccessUrl.searchParams.get("setup_request_id") ?? "").toMatch(
    /^[0-9a-f-]{36}$/
  );
  forgedSuccessUrl.searchParams.set("flow", "browser");
  forgedSuccessUrl.searchParams.set("caller", "Forged Caller");
  await page.goto(forgedSuccessUrl.toString());

  await expect(
    page.getByRole("heading", { name: "Caller approved" })
  ).toBeVisible();
  await expect(page.getByLabel("Account")).toContainText("owner");
  await expect(page.getByLabel("Approval success")).toContainText(
    "Return to the CLI"
  );
  await expect(page.getByLabel("Approval success")).toContainText(
    "Terminal Device Caller"
  );
  await expect(page.getByLabel("Approval success")).not.toContainText(
    "Forged Caller"
  );

  const deniedStart = await request.post("/api/caller/connect/device/start", {
    headers: connectRequestHeaders,
    data: {
      local_caller_name: connectCallerSlug(testInfo, "terminal-denied"),
      display_name: "Terminal Canceled Caller"
    }
  });
  const deniedStartPayload = await deniedStart.json();
  expect(deniedStart.ok(), JSON.stringify(deniedStartPayload)).toBe(true);

  await page.goto(
    `/caller/connect/device?user_code=${encodeURIComponent(
      deniedStartPayload.data.user_code
    )}&fixture_clerk_user_id=${fixtureUserId}`
  );
  await page.getByRole("button", { name: "Cancel setup" }).click();
  await expect(page).toHaveURL(/\/caller\/connect\/error/);

  const forgedErrorUrl = new URL(page.url());
  expect(forgedErrorUrl.searchParams.get("setup_request_id") ?? "").toMatch(
    /^[0-9a-f-]{36}$/
  );
  forgedErrorUrl.searchParams.set("status", "409");
  forgedErrorUrl.searchParams.set("code", "setup_denied");
  forgedErrorUrl.searchParams.set("message", "Forged denial text");
  await page.goto(forgedErrorUrl.toString());

  await expect(
    page.getByRole("heading", { name: "Connect failed" })
  ).toBeVisible();
  await expect(page.getByLabel("Account")).toContainText("owner");
  await expect(page.getByLabel("Approval error")).toContainText(
    "Terminal Canceled Caller"
  );
  await expect(page.getByLabel("Approval error")).toContainText(
    "Caller setup was canceled."
  );
  await expect(page.getByLabel("Approval error")).toContainText("denied");
  await expect(page.getByLabel("Approval error")).not.toContainText(
    "Forged denial text"
  );

  await page.goto(
    `/caller/connect/error?status=409&code=caller_already_exists&message=Caller%20already%20exists&fixture_clerk_user_id=${fixtureUserId}`
  );
  await expect(
    page.getByRole("heading", { name: "Connect failed" })
  ).toBeVisible();
  await expect(page.getByLabel("Account")).toHaveCount(0);
  await expect(page.getByText("caller_already_exists")).toBeVisible();
  await expect(page.getByText("Caller already exists")).toBeVisible();
});

test("browser approval succeeds through the fixture Clerk identity and live database", async ({
  page,
  request
}, testInfo) => {
  const fixtureUserId = connectFixtureUserId(testInfo, "browser-approve");
  const start = await request.post("/api/caller/connect/browser/start", {
    headers: connectRequestHeaders,
    data: {
      local_caller_name: connectCallerSlug(testInfo, "browser-approve"),
      display_name: "Browser Approved Caller",
      callback_url: "http://127.0.0.1:39010/caller/connect/callback"
    }
  });
  const startPayload = await start.json();

  expect(start.ok(), JSON.stringify(startPayload)).toBe(true);
  expect(startPayload.ok).toBe(true);

  const approvalUrl = new URL(startPayload.data.approval_url);
  approvalUrl.searchParams.set("fixture_clerk_user_id", fixtureUserId);
  await page.goto(approvalUrl.toString());

  await expect(
    page.getByRole("heading", { name: "Approve caller setup" })
  ).toBeVisible();
  await expect(page.getByLabel("Caller setup request")).toContainText(
    "Browser Approved Caller"
  );
  await expect(
    page.getByRole("button", { name: "Cancel setup" })
  ).toBeVisible();
  await page.getByRole("button", { name: "Approve caller" }).click();

  await expect(page).toHaveURL(/\/caller\/connect\/callback\?/);
  const callbackUrl = new URL(page.url());
  expect(callbackUrl.searchParams.get("status")).toBe("approved");
  const setupCode = callbackUrl.searchParams.get("setup_code");
  expect(setupCode ?? "").toMatch(/^setup_/);

  const exchange = await request.post("/api/caller/connect/exchange", {
    headers: connectRequestHeaders,
    data: {
      setup_code: setupCode ?? ""
    }
  });
  const exchangePayload = await exchange.json();
  expect(exchange.ok(), JSON.stringify(exchangePayload)).toBe(true);
  expect(exchangePayload.data.caller.display_name).toBe(
    "Browser Approved Caller"
  );

  // Two-phase connect: the exchanged key is pending_activation and must not
  // authenticate data-plane requests until connect/activate succeeds.
  const connectApiKey = exchangePayload.data.credential.api_key;

  const pendingStatus = await request.get("/api/caller/status", {
    headers: { authorization: `Bearer ${connectApiKey}` }
  });
  const pendingStatusPayload = await pendingStatus.json();
  expect(pendingStatus.status(), JSON.stringify(pendingStatusPayload)).toBe(
    401
  );
  expect(pendingStatusPayload.error.code).toBe("invalid_caller_credentials");

  const activate = await request.post("/api/caller/connect/activate", {
    headers: {
      ...connectRequestHeaders,
      authorization: `Bearer ${connectApiKey}`
    },
    data: { setup_request_id: exchangePayload.data.setup_request_id }
  });
  const activatePayload = await activate.json();
  expect(activate.ok(), JSON.stringify(activatePayload)).toBe(true);
  expect(activatePayload.data.activated_key_id).toBe(
    exchangePayload.data.credential.key_id
  );

  const usableStatus = await request.get("/api/caller/status", {
    headers: { authorization: `Bearer ${connectApiKey}` }
  });
  const usableStatusPayload = await usableStatus.json();
  expect(usableStatus.ok(), JSON.stringify(usableStatusPayload)).toBe(true);
});

test("device approval succeeds through the fixture Clerk identity and live database", async ({
  page,
  request
}, testInfo) => {
  const fixtureUserId = connectFixtureUserId(testInfo, "device-approve");
  const start = await request.post("/api/caller/connect/device/start", {
    headers: connectRequestHeaders,
    data: {
      local_caller_name: connectCallerSlug(testInfo, "device-approve"),
      display_name: "Device Approved Caller"
    }
  });
  const startPayload = await start.json();

  expect(start.ok(), JSON.stringify(startPayload)).toBe(true);
  expect(startPayload.ok).toBe(true);

  await page.goto(
    `/caller/connect/device?user_code=${encodeURIComponent(
      startPayload.data.user_code
    )}&fixture_clerk_user_id=${fixtureUserId}`
  );
  await expect(
    page.getByRole("heading", { name: "Verify device code" })
  ).toBeVisible();
  await expect(page.getByLabel("Caller setup request")).toContainText(
    "Device Approved Caller"
  );
  await expect(
    page.getByRole("button", { name: "Cancel setup" })
  ).toBeVisible();
  await page.getByRole("button", { name: "Approve caller" }).click();

  await expect(page).toHaveURL(/\/caller\/connect\/success/);
  await expect(
    page.getByRole("heading", { name: "Caller approved" })
  ).toBeVisible();
  await expect(page.getByLabel("Approval success")).toContainText(
    "Device Approved Caller"
  );

  const poll = await request.post("/api/caller/connect/device/poll", {
    headers: connectRequestHeaders,
    data: {
      device_code: startPayload.data.device_code
    }
  });
  const pollPayload = await poll.json();
  expect(poll.ok(), JSON.stringify(pollPayload)).toBe(true);
  expect(pollPayload.data.caller.display_name).toBe("Device Approved Caller");
});

test("manual device-code entry previews the caller before approval", async ({
  page,
  request
}, testInfo) => {
  const fixtureUserId = connectFixtureUserId(testInfo, "device-manual");
  const start = await request.post("/api/caller/connect/device/start", {
    headers: connectRequestHeaders,
    data: {
      local_caller_name: connectCallerSlug(testInfo, "device-manual"),
      display_name: "Manual Device Caller"
    }
  });
  const startPayload = await start.json();

  expect(start.ok(), JSON.stringify(startPayload)).toBe(true);
  expect(startPayload.ok).toBe(true);

  await page.goto(
    `/caller/connect/device?fixture_clerk_user_id=${fixtureUserId}`
  );
  await expect(
    page.getByRole("heading", { name: "Verify device code" })
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Enter the CLI code" })
  ).toBeVisible();

  await page.getByLabel("User code").fill(startPayload.data.user_code);
  await page.getByRole("button", { name: "Continue" }).click();

  await expect(page).toHaveURL(/\/caller\/connect\/device\?/);
  await expect(page.getByLabel("Account")).toContainText("owner");
  await expect(page.getByLabel("Caller setup request")).toContainText(
    "Manual Device Caller"
  );
  await expect(
    page.getByRole("button", { name: "Cancel setup" })
  ).toBeVisible();

  const pendingPoll = await request.post("/api/caller/connect/device/poll", {
    headers: connectRequestHeaders,
    data: {
      device_code: startPayload.data.device_code
    }
  });
  const pendingPayload = await pendingPoll.json();
  expect(pendingPoll.status(), JSON.stringify(pendingPayload)).toBe(202);
  expect(pendingPayload.error.code).toBe("authorization_pending");

  await page.getByRole("button", { name: "Approve caller" }).click();

  await expect(page).toHaveURL(/\/caller\/connect\/success/);
  await expect(
    page.getByRole("heading", { name: "Caller approved" })
  ).toBeVisible();
  await expect(page.getByLabel("Approval success")).toContainText(
    "Manual Device Caller"
  );

  const poll = await request.post("/api/caller/connect/device/poll", {
    headers: connectRequestHeaders,
    data: {
      device_code: startPayload.data.device_code
    }
  });
  const pollPayload = await poll.json();
  expect(poll.ok(), JSON.stringify(pollPayload)).toBe(true);
  expect(pollPayload.data.caller.display_name).toBe("Manual Device Caller");
});

test("browser approval can cancel a pending setup request", async ({
  page,
  request
}, testInfo) => {
  const fixtureUserId = connectFixtureUserId(testInfo, "browser-cancel");
  const start = await request.post("/api/caller/connect/browser/start", {
    headers: connectRequestHeaders,
    data: {
      local_caller_name: connectCallerSlug(testInfo, "browser-cancel"),
      display_name: "Browser Canceled Caller",
      callback_url: "http://127.0.0.1:39010/caller/connect/callback"
    }
  });
  const startPayload = await start.json();

  expect(start.ok(), JSON.stringify(startPayload)).toBe(true);

  const approvalUrl = new URL(startPayload.data.approval_url);
  approvalUrl.searchParams.set("fixture_clerk_user_id", fixtureUserId);
  await page.goto(approvalUrl.toString());

  await expect(
    page.getByRole("heading", { name: "Approve caller setup" })
  ).toBeVisible();
  await page.getByRole("button", { name: "Cancel setup" }).click();

  await expect(page).toHaveURL(/\/caller\/connect\/error/);
  await expect(page.getByLabel("Approval error")).toContainText("setup_denied");
  await expect(page.getByLabel("Approval error")).toContainText(
    "Caller setup was canceled"
  );
});

test("device approval can cancel a pending setup request", async ({
  page,
  request
}, testInfo) => {
  const fixtureUserId = connectFixtureUserId(testInfo, "device-cancel");
  const start = await request.post("/api/caller/connect/device/start", {
    headers: connectRequestHeaders,
    data: {
      local_caller_name: connectCallerSlug(testInfo, "device-cancel"),
      display_name: "Device Canceled Caller"
    }
  });
  const startPayload = await start.json();

  expect(start.ok(), JSON.stringify(startPayload)).toBe(true);

  await page.goto(
    `/caller/connect/device?user_code=${encodeURIComponent(
      startPayload.data.user_code
    )}&fixture_clerk_user_id=${fixtureUserId}`
  );
  await expect(
    page.getByRole("heading", { name: "Verify device code" })
  ).toBeVisible();
  await page.getByRole("button", { name: "Cancel setup" }).click();

  await expect(page).toHaveURL(/\/caller\/connect\/error/);
  await expect(page.getByLabel("Approval error")).toContainText("setup_denied");

  const poll = await request.post("/api/caller/connect/device/poll", {
    headers: connectRequestHeaders,
    data: {
      device_code: startPayload.data.device_code
    }
  });
  const pollPayload = await poll.json();
  expect(poll.status()).toBe(400);
  expect(pollPayload.error.code).toBe("invalid_request");
});

test("rotate and revoke approval pages complete against live caller rows", async ({
  page,
  request
}, testInfo) => {
  const fixtureUserId = connectFixtureUserId(testInfo, "rotate-revoke");
  const caller = await connectCallerThroughDevice(
    page,
    request,
    testInfo,
    fixtureUserId,
    "rotate-revoke"
  );

  const rotateStart = await request.post("/api/caller/rotate/browser/start", {
    headers: connectRequestHeaders,
    data: {
      caller_id: caller.callerId,
      local_caller_name: caller.localCallerName,
      callback_url: "http://127.0.0.1:39010/caller/connect/callback"
    }
  });
  const rotateStartPayload = await rotateStart.json();
  expect(rotateStart.ok(), JSON.stringify(rotateStartPayload)).toBe(true);

  const rotateApprovalUrl = new URL(rotateStartPayload.data.approval_url);
  rotateApprovalUrl.searchParams.set("fixture_clerk_user_id", fixtureUserId);
  await page.goto(rotateApprovalUrl.toString());

  await expect(
    page.getByRole("heading", { name: "Approve key rotation" })
  ).toBeVisible();
  await expect(page.getByLabel("Caller setup request")).toContainText("rotate");
  await expect(page.getByLabel("Caller setup request")).toContainText(
    caller.displayName
  );
  await page.getByRole("button", { name: "Approve rotation" }).click();
  await expect(page).toHaveURL(/\/caller\/connect\/callback\?/);

  const rotateCallbackUrl = new URL(page.url());
  const rotateSetupCode = rotateCallbackUrl.searchParams.get("setup_code");
  expect(rotateSetupCode ?? "").toMatch(/^setup_/);

  const rotateExchange = await request.post("/api/caller/rotate/exchange", {
    headers: connectRequestHeaders,
    data: { setup_code: rotateSetupCode ?? "" }
  });
  const rotateExchangePayload = await rotateExchange.json();
  expect(rotateExchange.ok(), JSON.stringify(rotateExchangePayload)).toBe(true);
  const replacementApiKey =
    rotateExchangePayload.data.replacement_credential.api_key;

  const pendingStatus = await request.get("/api/caller/status", {
    headers: { authorization: `Bearer ${replacementApiKey}` }
  });
  const pendingStatusPayload = await pendingStatus.json();
  expect(pendingStatus.status(), JSON.stringify(pendingStatusPayload)).toBe(
    401
  );
  expect(pendingStatusPayload.error.code).toBe("invalid_caller_credentials");

  const activate = await request.post("/api/caller/rotate/activate", {
    headers: {
      ...connectRequestHeaders,
      authorization: `Bearer ${replacementApiKey}`
    },
    data: { setup_request_id: rotateStartPayload.data.setup_request_id }
  });
  const activatePayload = await activate.json();
  expect(activate.ok(), JSON.stringify(activatePayload)).toBe(true);
  expect(activatePayload.data.revoked_key_id).toBe(
    rotateExchangePayload.data.replaces_credential.key_id
  );

  const oldStatus = await request.get("/api/caller/status", {
    headers: { authorization: `Bearer ${caller.apiKey}` }
  });
  expect(oldStatus.status()).toBe(401);

  const revokeStart = await request.post("/api/caller/revoke/device/start", {
    headers: connectRequestHeaders,
    data: {
      caller_id: caller.callerId,
      local_caller_name: caller.localCallerName
    }
  });
  const revokeStartPayload = await revokeStart.json();
  expect(revokeStart.ok(), JSON.stringify(revokeStartPayload)).toBe(true);

  await page.goto(
    `/caller/revoke/device?user_code=${encodeURIComponent(
      revokeStartPayload.data.user_code
    )}&fixture_clerk_user_id=${fixtureUserId}`
  );
  await expect(
    page.getByRole("heading", { name: "Approve caller revoke" })
  ).toBeVisible();
  await expect(page.getByLabel("Caller setup request")).toContainText("revoke");
  await page.getByRole("button", { name: "Approve revoke" }).click();
  await expect(page).toHaveURL(/\/caller\/revoke\/success/);

  const revokePoll = await request.post("/api/caller/revoke/device/poll", {
    headers: connectRequestHeaders,
    data: { device_code: revokeStartPayload.data.device_code }
  });
  const revokePollPayload = await revokePoll.json();
  expect(revokePoll.ok(), JSON.stringify(revokePollPayload)).toBe(true);
  expect(revokePollPayload.data.setup_code).toMatch(/^setup_/);

  const revokeConfirm = await request.post("/api/caller/revoke/confirm", {
    headers: connectRequestHeaders,
    data: { setup_code: revokePollPayload.data.setup_code }
  });
  const revokeConfirmPayload = await revokeConfirm.json();
  expect(revokeConfirm.ok(), JSON.stringify(revokeConfirmPayload)).toBe(true);
  expect(revokeConfirmPayload.data.revoked_key_ids).toContain(
    rotateExchangePayload.data.replacement_credential.key_id
  );

  const revokedStatus = await request.get("/api/caller/status", {
    headers: { authorization: `Bearer ${replacementApiKey}` }
  });
  expect(revokedStatus.status()).toBe(401);
});

test("rotate and revoke alternate approval variants and error pages render", async ({
  page,
  request
}, testInfo) => {
  const fixtureUserId = connectFixtureUserId(
    testInfo,
    "rotate-revoke-variants"
  );
  const caller = await connectCallerThroughDevice(
    page,
    request,
    testInfo,
    fixtureUserId,
    "rotate-revoke-variants"
  );

  const rotateDeviceStart = await request.post(
    "/api/caller/rotate/device/start",
    {
      headers: connectRequestHeaders,
      data: {
        caller_id: caller.callerId,
        local_caller_name: caller.localCallerName
      }
    }
  );
  const rotateDeviceStartPayload = await rotateDeviceStart.json();
  expect(rotateDeviceStart.ok(), JSON.stringify(rotateDeviceStartPayload)).toBe(
    true
  );

  await page.goto(
    `/caller/rotate/device?user_code=${encodeURIComponent(
      rotateDeviceStartPayload.data.user_code
    )}&fixture_clerk_user_id=${fixtureUserId}`
  );
  await expect(
    page.getByRole("heading", { name: "Verify device code" })
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Approve key rotation" })
  ).toBeVisible();
  await expect(page.getByLabel("Caller setup request")).toContainText("rotate");
  await expect(page.getByLabel("Caller setup request")).toContainText(
    caller.displayName
  );
  await page.getByRole("button", { name: "Approve rotation" }).click();
  await expect(page).toHaveURL(/\/caller\/rotate\/success/);
  await expect(
    page.getByRole("heading", { name: "Rotation approved" })
  ).toBeVisible();
  await expect(page.getByLabel("Approval success")).toContainText(
    caller.displayName
  );

  const revokeBrowserStart = await request.post(
    "/api/caller/revoke/browser/start",
    {
      headers: connectRequestHeaders,
      data: {
        caller_id: caller.callerId,
        local_caller_name: caller.localCallerName,
        callback_url: "http://127.0.0.1:39010/caller/connect/callback"
      }
    }
  );
  const revokeBrowserStartPayload = await revokeBrowserStart.json();
  expect(
    revokeBrowserStart.ok(),
    JSON.stringify(revokeBrowserStartPayload)
  ).toBe(true);

  const revokeApprovalUrl = new URL(
    revokeBrowserStartPayload.data.approval_url
  );
  revokeApprovalUrl.searchParams.set("fixture_clerk_user_id", fixtureUserId);
  await page.goto(revokeApprovalUrl.toString());
  await expect(
    page.getByRole("heading", { name: "Approve caller revoke" })
  ).toBeVisible();
  await expect(page.getByLabel("Caller setup request")).toContainText("revoke");
  await expect(page.getByLabel("Caller setup request")).toContainText(
    caller.displayName
  );
  await page.getByRole("button", { name: "Approve revoke" }).click();
  await expect(page).toHaveURL(/\/caller\/connect\/callback\?/);
  const revokeCallbackUrl = new URL(page.url());
  expect(revokeCallbackUrl.searchParams.get("status")).toBe("approved");
  expect(revokeCallbackUrl.searchParams.get("setup_code") ?? "").toMatch(
    /^setup_/
  );

  const rotateDeniedStart = await request.post(
    "/api/caller/rotate/browser/start",
    {
      headers: connectRequestHeaders,
      data: {
        caller_id: caller.callerId,
        local_caller_name: caller.localCallerName,
        callback_url: "http://127.0.0.1:39010/caller/connect/callback"
      }
    }
  );
  const rotateDeniedStartPayload = await rotateDeniedStart.json();
  expect(rotateDeniedStart.ok(), JSON.stringify(rotateDeniedStartPayload)).toBe(
    true
  );

  const rotateDeniedApprovalUrl = new URL(
    rotateDeniedStartPayload.data.approval_url
  );
  rotateDeniedApprovalUrl.searchParams.set(
    "fixture_clerk_user_id",
    fixtureUserId
  );
  await page.goto(rotateDeniedApprovalUrl.toString());
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page).toHaveURL(/\/caller\/rotate\/error/);
  await expect(
    page.getByRole("heading", { name: "Rotation failed" })
  ).toBeVisible();
  await expect(page.getByLabel("Approval error")).toContainText("setup_denied");
  await expect(page.getByLabel("Approval error")).toContainText(
    "Caller rotate was canceled"
  );
  await expect(page.getByLabel("Approval error")).toContainText(
    caller.displayName
  );

  const revokeDeniedStart = await request.post(
    "/api/caller/revoke/browser/start",
    {
      headers: connectRequestHeaders,
      data: {
        caller_id: caller.callerId,
        local_caller_name: caller.localCallerName,
        callback_url: "http://127.0.0.1:39010/caller/connect/callback"
      }
    }
  );
  const revokeDeniedStartPayload = await revokeDeniedStart.json();
  expect(revokeDeniedStart.ok(), JSON.stringify(revokeDeniedStartPayload)).toBe(
    true
  );

  const revokeDeniedApprovalUrl = new URL(
    revokeDeniedStartPayload.data.approval_url
  );
  revokeDeniedApprovalUrl.searchParams.set(
    "fixture_clerk_user_id",
    fixtureUserId
  );
  await page.goto(revokeDeniedApprovalUrl.toString());
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page).toHaveURL(/\/caller\/revoke\/error/);
  await expect(
    page.getByRole("heading", { name: "Revoke failed" })
  ).toBeVisible();
  await expect(page.getByLabel("Approval error")).toContainText("setup_denied");
  await expect(page.getByLabel("Approval error")).toContainText(
    "Caller revoke was canceled"
  );
  await expect(page.getByLabel("Approval error")).toContainText(
    caller.displayName
  );
});

async function connectCallerThroughDevice(
  page: import("@playwright/test").Page,
  request: import("@playwright/test").APIRequestContext,
  testInfo: { project: { name: string }; retry: number },
  fixtureUserId: string,
  prefix: string
) {
  const localCallerName = connectCallerSlug(testInfo, prefix);
  const displayName = `Caller ${prefix} ${testInfo.project.name}`;
  const start = await request.post("/api/caller/connect/device/start", {
    headers: connectRequestHeaders,
    data: {
      local_caller_name: localCallerName,
      display_name: displayName
    }
  });
  const startPayload = await start.json();
  expect(start.ok(), JSON.stringify(startPayload)).toBe(true);

  await page.goto(
    `/caller/connect/device?user_code=${encodeURIComponent(
      startPayload.data.user_code
    )}&fixture_clerk_user_id=${fixtureUserId}`
  );
  await page.getByRole("button", { name: "Approve caller" }).click();
  await expect(page).toHaveURL(/\/caller\/connect\/success/);

  const poll = await request.post("/api/caller/connect/device/poll", {
    headers: connectRequestHeaders,
    data: {
      device_code: startPayload.data.device_code
    }
  });
  const pollPayload = await poll.json();
  expect(poll.ok(), JSON.stringify(pollPayload)).toBe(true);

  // Connect is two-phase: the poll credential is pending_activation and cannot
  // authenticate data-plane requests until connect/activate. Activate it here so
  // the helper returns a usable active key for the rotate/revoke flows below.
  const apiKey = pollPayload.data.credential.api_key;
  const activate = await request.post("/api/caller/connect/activate", {
    headers: {
      ...connectRequestHeaders,
      authorization: `Bearer ${apiKey}`
    },
    data: { setup_request_id: pollPayload.data.setup_request_id }
  });
  const activatePayload = await activate.json();
  expect(activate.ok(), JSON.stringify(activatePayload)).toBe(true);
  expect(activatePayload.data.activated_key_id).toBe(
    pollPayload.data.credential.key_id
  );

  return {
    callerId: pollPayload.data.caller.caller_id,
    localCallerName,
    displayName,
    apiKey
  };
}

function connectFixtureUserId(
  testInfo: { project: { name: string } },
  prefix: string
) {
  return `browser-connect-${prefix}-${testInfo.project.name}`;
}

function connectCallerSlug(
  testInfo: { project: { name: string }; retry: number },
  prefix: string
) {
  return `${prefix}-${testInfo.project.name}-${testInfo.retry}`;
}
