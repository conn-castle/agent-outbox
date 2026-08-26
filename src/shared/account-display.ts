import type { AccountStatusData } from "../server/status.ts";

export function accountStorageLabel(
  storedBytes: number,
  limitBytes: number | null
) {
  if (limitBytes === null) return "Unlimited";
  if (limitBytes === 0) return "0 byte capacity";
  return `${Math.round((storedBytes / limitBytes) * 100)}%`;
}

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
