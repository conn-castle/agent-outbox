export type AccountId = string;
export type UserId = string;

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

export type AuthorizedHumanAccountContext = {
  surface: "human";
  accountId: AccountId;
  userId: UserId;
  role: AccountMemberRole;
};

export type AccountMembershipAuthorizationDenial = {
  ok: false;
  status: 403;
  surface: "human";
  code: "account_membership_required" | "cross_account_denied";
  requestedAccountId: AccountId;
  userId: UserId;
};

export type HumanAccountAuthorizationResult =
  | ({ ok: true } & AuthorizedHumanAccountContext)
  | AccountMembershipAuthorizationDenial;

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
