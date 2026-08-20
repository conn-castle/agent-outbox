import type { AccountStatusData, StatusResult } from "../../server/status.ts";
import {
  accountHasHostedBilling,
  accountStorageLabel
} from "../../shared/account-display.ts";
import { formatUtcTimestamp } from "./review-format";

export function AccountBanner({
  banner
}: {
  banner: StatusResult<AccountStatusData>;
}) {
  if (!banner.ok) {
    return (
      <details
        className="account-banner"
        aria-label="Account status"
        data-dismissible-disclosure
      >
        <summary>
          <span className="account-avatar">!</span>
          <span>Account</span>
        </summary>
        <div className="account-popover">
          <strong>Account status unavailable</strong>
          <span>{banner.error.message}</span>
        </div>
      </details>
    );
  }

  const { data } = banner;
  const accountLabel = data.label ?? "Account";
  const summaryLabel = accountLabel.startsWith("Browser fixture account:")
    ? "Demo workspace"
    : accountLabel;
  const storageLimit = accountStorageLabel(
    data.storage.stored_bytes,
    data.storage.limit_bytes
  );
  const hostedBillingAvailable = accountHasHostedBilling(data);

  return (
    <details
      className="account-banner"
      aria-label="Account status"
      data-dismissible-disclosure
    >
      <summary>
        <span className="account-avatar">
          {summaryLabel.charAt(0).toUpperCase()}
        </span>
        <span>{summaryLabel}</span>
      </summary>
      <div className="account-popover">
        <header>
          <strong>{accountLabel}</strong>
          <span>
            {accountTierLabel(data.tier)} ·{" "}
            {billingStatusLabel(data.billing_status)}
          </span>
        </header>
        <dl>
          <div>
            <dt>Effective access</dt>
            <dd>{capitalize(data.effective_tier)}</dd>
          </div>
          <div>
            <dt>File uploads</dt>
            <dd>{data.file_upload_enabled ? "Enabled" : "Not enabled"}</dd>
          </div>
          <div>
            <dt>Storage used</dt>
            <dd>{storageLimit}</dd>
          </div>
          <div>
            <dt>Limits</dt>
            <dd>
              {data.active_limit_blocks.length === 0
                ? "No active blocks"
                : `${data.active_limit_blocks.length} active ${
                    data.active_limit_blocks.length === 1 ? "block" : "blocks"
                  }`}
            </dd>
          </div>
          {data.grace_ends_at ? (
            <div>
              <dt>Grace ends</dt>
              <dd>{formatUtcTimestamp(data.grace_ends_at)}</dd>
            </div>
          ) : null}
        </dl>
        {data.active_limit_blocks.length > 0 ? (
          <ul className="account-limit-blocks" aria-label="Active limit blocks">
            {data.active_limit_blocks.map((block) => (
              <li key={`${block.operation_kind}:${block.limit_name}`}>
                {block.limit_reason}
              </li>
            ))}
          </ul>
        ) : null}
        <div className="account-popover-actions">
          {hostedBillingAvailable ? <a href="/upgrade">Manage plan</a> : null}
          <a href="/sign-out">Sign out</a>
        </div>
      </div>
    </details>
  );
}

function accountTierLabel(tier: AccountStatusData["tier"]) {
  if (tier === "self_hosted") return "Self-hosted";
  return tier === "hosted_paid" ? "Hosted paid" : "Hosted free";
}

function billingStatusLabel(status: AccountStatusData["billing_status"]) {
  return status === "not_applicable"
    ? "Billing not applicable"
    : capitalize(status.replace("_", " "));
}

function capitalize(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
