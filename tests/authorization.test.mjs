import assert from "node:assert/strict";
import test from "node:test";

import {
  authorizeAccountMembership,
  authorizeCallerAccount
} from "../src/server/authorization.ts";

test("authorization helpers deny cross-account human and caller access", () => {
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

  assert.deepEqual(
    authorizeCallerAccount(
      {
        surface: "caller",
        accountId: "account_a",
        callerId: "caller_a",
        keyId: "key_a"
      },
      { accountId: "account_a", callerId: "caller_b" }
    ),
    {
      ok: false,
      status: 403,
      surface: "caller",
      code: "caller_scope_denied",
      accountId: "account_a",
      callerId: "caller_a",
      requestedAccountId: "account_a",
      requestedCallerId: "caller_b"
    }
  );

  assert.deepEqual(
    authorizeCallerAccount(
      {
        surface: "caller",
        accountId: "account_a",
        callerId: "caller_a",
        keyId: "key_a"
      },
      { accountId: "account_b", callerId: "caller_b" }
    ),
    {
      ok: false,
      status: 403,
      surface: "caller",
      code: "cross_account_denied",
      accountId: "account_a",
      callerId: "caller_a",
      requestedAccountId: "account_b",
      requestedCallerId: "caller_b"
    }
  );
});
