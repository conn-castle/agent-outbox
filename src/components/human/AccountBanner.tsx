import type { AccountStatusData, StatusResult } from "../../server/status.ts";
import { formatUtcTimestamp } from "./review-format";

export function AccountBanner({
  banner
}: {
  banner: StatusResult<AccountStatusData>;
}) {
  if (!banner.ok) {
    return (
      <details className="account-banner" aria-label="Account status">
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
  const storageLimit = data.storage.limit_bytes
    ? `${Math.round((data.storage.stored_bytes / data.storage.limit_bytes) * 100)}%`
    : "unlimited";

  return (
    <details className="account-banner" aria-label="Account status">
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
            {data.effective_tier} · {data.billing_status.replace("_", " ")}
          </span>
        </header>
        <dl>
          <div>
            <dt>File uploads</dt>
            <dd>{data.file_upload_enabled ? "Enabled" : "Not enabled"}</dd>
          </div>
          <div>
            <dt>Storage used</dt>
            <dd>{storageLimit}</dd>
          </div>
          {data.grace_ends_at ? (
            <div>
              <dt>Grace ends</dt>
              <dd>{formatUtcTimestamp(data.grace_ends_at)}</dd>
            </div>
          ) : null}
        </dl>
        <div className="account-popover-actions">
          <a href="/upgrade">Manage plan</a>
          <a href="/sign-out">Sign out</a>
        </div>
      </div>
    </details>
  );
}
