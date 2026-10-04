import type { AccountStatusData } from "../server/status.ts";

export function accountCanUpgrade(data: Pick<AccountStatusData, "tier">) {
  return data.tier === "hosted_free";
}

export function accountCanManageBilling(
  data: Pick<AccountStatusData, "tier" | "billing_status">
) {
  return (
    data.tier === "hosted_paid" && data.billing_status !== "not_applicable"
  );
}

export type HumanAccountIdentityDisplay = {
  name: string | null;
  emailAddress: string | null;
  signInMethods: string[];
};

export function humanAccountIdentityOrFallback(
  profile: HumanAccountIdentityDisplay | null,
  accountLabel: string | null
): HumanAccountIdentityDisplay {
  if (profile) return profile;
  return {
    name: accountLabel,
    emailAddress: null,
    signInMethods: []
  };
}
