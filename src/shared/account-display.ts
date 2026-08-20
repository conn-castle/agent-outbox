import type { AccountStatusData } from "../server/status.ts";

export function accountStorageLabel(
  storedBytes: number,
  limitBytes: number | null
) {
  if (limitBytes === null) return "Unlimited";
  if (limitBytes === 0) return "0 byte capacity";
  return `${Math.round((storedBytes / limitBytes) * 100)}%`;
}

export function accountHasHostedBilling(
  data: Pick<AccountStatusData, "tier" | "billing_status">
) {
  return (
    data.tier !== "self_hosted" && data.billing_status !== "not_applicable"
  );
}
