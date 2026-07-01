import type { AccountStatusData, StatusResult } from "../../server/status.ts";

export function AccountBanner({
  banner
}: {
  banner: StatusResult<AccountStatusData>;
}) {
  if (!banner.ok) {
    return (
      <section className="account-banner" aria-label="Account status">
        <strong>Account status unavailable</strong>
        <span>{banner.error.message}</span>
      </section>
    );
  }

  const { data } = banner;
  const storageLimit = data.storage.limit_bytes
    ? `${Math.round((data.storage.stored_bytes / data.storage.limit_bytes) * 100)}%`
    : "unlimited";

  return (
    <section className="account-banner" aria-label="Account status">
      <div>
        <strong>{data.label ?? "Review account"}</strong>
        <span>
          {data.effective_tier} tier · {data.billing_status.replace("_", " ")}
        </span>
      </div>
      <div>
        <strong>File uploads</strong>
        <span>{data.file_upload_enabled ? "enabled" : "not enabled"}</span>
      </div>
      <div>
        <strong>Storage</strong>
        <span>{storageLimit}</span>
      </div>
      {data.grace_ends_at ? (
        <div>
          <strong>Downgrade grace ends</strong>
          <span>{formatTimestamp(data.grace_ends_at)}</span>
        </div>
      ) : null}
    </section>
  );
}

function formatTimestamp(value: string) {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC"
  }).format(new Date(value));
}
