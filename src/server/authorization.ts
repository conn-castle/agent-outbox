export type AccountId = string;
export type UserId = string;
export type CallerId = string;
export type CallerKeyId = string;

export type AccountMemberRole = "owner";

export type AccountMembership = {
  accountId: AccountId;
  userId: UserId;
  role: AccountMemberRole;
};

export type HumanAccountAuthorizationContext = {
  surface: "human";
  userId: UserId;
  memberships: readonly AccountMembership[];
};

export type CallerAccountAuthorizationContext = {
  surface: "caller";
  accountId: AccountId;
  callerId: CallerId;
  keyId?: CallerKeyId;
};

export type AccountScopedResource = {
  accountId: AccountId;
  callerId?: CallerId;
};

export type AuthorizedHumanAccountContext = {
  surface: "human";
  accountId: AccountId;
  userId: UserId;
  role: AccountMemberRole;
};

export type AuthorizedCallerAccountContext = {
  surface: "caller";
  accountId: AccountId;
  callerId: CallerId;
  keyId?: CallerKeyId;
};

export type AccountMembershipAuthorizationDenial = {
  ok: false;
  status: 403;
  surface: "human";
  code: "account_membership_required" | "cross_account_denied";
  requestedAccountId: AccountId;
  userId: UserId;
};

export type CallerAuthorizationDenial = {
  ok: false;
  status: 403;
  surface: "caller";
  code: "cross_account_denied" | "caller_scope_denied";
  accountId: AccountId;
  callerId: CallerId;
  requestedAccountId: AccountId;
  requestedCallerId?: CallerId;
};

export type HumanAccountAuthorizationResult =
  | ({ ok: true } & AuthorizedHumanAccountContext)
  | AccountMembershipAuthorizationDenial;

export type CallerAccountAuthorizationResult =
  ({ ok: true } & AuthorizedCallerAccountContext) | CallerAuthorizationDenial;

export function authorizeAccountMembership(
  context: HumanAccountAuthorizationContext,
  requestedAccountId: AccountId
): HumanAccountAuthorizationResult {
  const matchingMembership = context.memberships.find((membership) => {
    return (
      membership.accountId === requestedAccountId &&
      membership.userId === context.userId
    );
  });

  if (!matchingMembership) {
    const hasOtherMembership = context.memberships.some((membership) => {
      return (
        membership.userId === context.userId &&
        membership.accountId !== requestedAccountId
      );
    });

    return {
      ok: false,
      status: 403,
      surface: "human",
      code: hasOtherMembership
        ? "cross_account_denied"
        : "account_membership_required",
      requestedAccountId,
      userId: context.userId
    };
  }

  return {
    ok: true,
    surface: "human",
    accountId: requestedAccountId,
    userId: context.userId,
    role: matchingMembership.role
  };
}

export function authorizeCallerAccount(
  context: CallerAccountAuthorizationContext,
  resource: AccountScopedResource
): CallerAccountAuthorizationResult {
  if (context.accountId !== resource.accountId) {
    return {
      ok: false,
      status: 403,
      surface: "caller",
      code: "cross_account_denied",
      accountId: context.accountId,
      callerId: context.callerId,
      requestedAccountId: resource.accountId,
      requestedCallerId: resource.callerId
    };
  }

  if (resource.callerId && context.callerId !== resource.callerId) {
    return {
      ok: false,
      status: 403,
      surface: "caller",
      code: "caller_scope_denied",
      accountId: context.accountId,
      callerId: context.callerId,
      requestedAccountId: resource.accountId,
      requestedCallerId: resource.callerId
    };
  }

  return {
    ok: true,
    surface: "caller",
    accountId: context.accountId,
    callerId: context.callerId,
    keyId: context.keyId
  };
}
