import assert from "node:assert/strict";
import test from "node:test";

import { authorizeAccountMembership } from "../src/server/authorization.ts";

test("account membership authorization denies cross-account human access", () => {
  assert.deepEqual(
    authorizeAccountMembership(
      {
        surface: "human",
        userId: "user_a",
        memberships: [
          {
            accountId: "account_a",
            userId: "user_a",
            role: "owner"
          }
        ]
      },
      "account_b"
    ),
    {
      ok: false,
      status: 403,
      surface: "human",
      code: "cross_account_denied",
      requestedAccountId: "account_b",
      userId: "user_a"
    }
  );
});
