import assert from "node:assert/strict";
import test from "node:test";

import { safeErrorName, safeLogEvent } from "../src/server/logging.ts";

test("safeLogEvent strips request bodies and arbitrary caller-controlled fields", () => {
  /** @type {import("../src/server/logging.ts").RuntimeLogEvent & { request_body: string, caller_display_name: string }} */
  const unsafeEvent = {
    level: "error",
    error_id: "err_123",
    error_name: "DatabaseConnectionError",
    surface: "api",
    route: "/api/runtime/error",
    method: "GET",
    status_code: 500,
    duration_ms: 17,
    operation: "runtime.structured_error.canary",
    operation_kind: "output_check_read",
    account_id: "00000000-0000-4000-8000-000000000001",
    caller_id: "00000000-0000-4000-8000-000000000002",
    input_item_id: "00000000-0000-4000-8000-000000000301",
    limit_name: "output_check_read_requests_per_account_per_minute",
    limit_reason_code: "output_check_read_rate_limited",
    limit_resets_at: "2026-07-07T12:01:00.000Z",
    used_units: 121,
    limit_units: 120,
    message: "safe message",
    request_body: "raw review content",
    caller_display_name: "caller supplied name"
  };
  const event = safeLogEvent(unsafeEvent);

  assert.deepEqual(event, {
    level: "error",
    error_id: "err_123",
    error_name: "DatabaseConnectionError",
    surface: "api",
    route: "/api/runtime/error",
    method: "GET",
    status_code: 500,
    duration_ms: 17,
    operation: "runtime.structured_error.canary",
    operation_kind: "output_check_read",
    account_id: "00000000-0000-4000-8000-000000000001",
    caller_id: "00000000-0000-4000-8000-000000000002",
    input_item_id: "00000000-0000-4000-8000-000000000301",
    limit_name: "output_check_read_requests_per_account_per_minute",
    limit_reason_code: "output_check_read_rate_limited",
    limit_resets_at: "2026-07-07T12:01:00.000Z",
    used_units: 121,
    limit_units: 120,
    message: "safe message"
  });

  const unsafeName = new Error("raw detail");
  unsafeName.name = "Bad Error raw detail";
  assert.equal(safeErrorName(unsafeName), "Error");
  assert.equal(safeErrorName("raw thrown value"), "UnknownError");
  assert.equal(
    safeLogEvent({
      ...unsafeEvent,
      error_name: "Bad Error raw detail"
    }).error_name,
    "Error"
  );
});
