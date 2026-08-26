"use client";

import {
  ArrowUpRight,
  Check,
  CreditCard,
  LockKeyhole,
  LogOut,
  X
} from "lucide-react";
import type { MouseEvent } from "react";

import type {
  HumanAccountBannerData,
  HumanAccountUsageMetric
} from "../../server/human-review.ts";
import type { StatusResult } from "../../server/status.ts";
import {
  accountCanManageBilling,
  accountCanUpgrade,
  type HumanAccountIdentityDisplay
} from "../../shared/account-display.ts";
import { formatUtcTimestamp } from "./review-format";

export function AccountBanner({
  banner,
  identity
}: {
  banner: StatusResult<HumanAccountBannerData>;
  identity: HumanAccountIdentityDisplay;
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
        <div className="account-popover account-popover-error">
          <strong>Account details unavailable</strong>
          <span>{banner.error.message}</span>
          <a href="/sign-out">Sign out</a>
        </div>
      </details>
    );
  }

  const { data } = banner;
  const accountLabel = data.label ?? "Agent Outbox account";
  const summaryLabel = identity.name ?? identity.emailAddress ?? accountLabel;
  const canUpgrade = accountCanUpgrade(data);
  const canManageBilling = accountCanManageBilling(data);

  return (
    <details
      className="account-banner"
      aria-label="Account status"
      data-dismissible-disclosure
    >
      <summary>
        <span className="account-avatar">{avatarLetter(summaryLabel)}</span>
        <span>{summaryLabel}</span>
      </summary>
      <div className="account-popover">
        <header className="account-profile">
          <span className="account-profile-avatar" aria-hidden="true">
            {avatarLetter(summaryLabel)}
          </span>
          <span className="account-profile-copy">
            <strong>{identity.name ?? accountLabel}</strong>
            <span>
              {identity.emailAddress ?? "No email address on profile"}
            </span>
          </span>
          <span className="account-plan-badge">
            {accountTierLabel(data.tier)}
          </span>
          <button
            className="account-popover-close"
            type="button"
            aria-label="Close account menu"
            onClick={closeAccountMenu}
          >
            <X aria-hidden="true" size={17} />
          </button>
        </header>

        <dl className="account-identity-details">
          <div>
            <dt>Workspace</dt>
            <dd title={accountLabel}>{accountLabel}</dd>
          </div>
          <div>
            <dt>Sign-in</dt>
            <dd>
              {identity.signInMethods.length > 0
                ? identity.signInMethods.join(", ")
                : "Method unavailable"}
            </dd>
          </div>
        </dl>

        {canUpgrade ? (
          <section className="account-upgrade-card" aria-label="Upgrade plan">
            <span>
              <strong>Unlock file uploads</strong>
              <small>Paid plan: $5/month or $50/year.</small>
            </span>
            <a href="/upgrade">
              Upgrade <ArrowUpRight aria-hidden="true" size={15} />
            </a>
          </section>
        ) : null}

        <section
          className="account-usage"
          aria-labelledby="account-usage-title"
        >
          <header>
            <strong id="account-usage-title">Usage &amp; limits</strong>
            <span>
              {data.active_limit_blocks.length === 0
                ? "Within limits"
                : "Limits reached"}
            </span>
          </header>
          <UsageRow
            label="Storage"
            used={data.storage.stored_bytes}
            limit={data.storage.limit_bytes}
            unit="bytes"
          />
          {data.usage.map((metric) => (
            <UsageRow
              key={metric.limitName}
              label={usageLabel(metric)}
              used={metric.used}
              limit={metric.limit}
              unit={metric.unit}
              resetAt={metric.resetsAt}
            />
          ))}
        </section>

        <section className="account-inclusions" aria-label="Plan features">
          <div>
            <span
              className={data.file_upload_enabled ? "included" : "excluded"}
            >
              {data.file_upload_enabled ? (
                <Check aria-hidden="true" size={13} />
              ) : (
                <LockKeyhole aria-hidden="true" size={13} />
              )}
            </span>
            <span>
              <strong>File uploads</strong>
              <small>
                {data.file_upload_enabled ? "Included" : "Locked on Free"}
              </small>
            </span>
          </div>
          {data.grace_ends_at ? (
            <div className="account-grace">
              <span>!</span>
              <span>
                <strong>Billing grace period</strong>
                <small>Ends {formatUtcTimestamp(data.grace_ends_at)}</small>
              </span>
            </div>
          ) : null}
        </section>

        {data.active_limit_blocks.length > 0 ? (
          <ul className="account-limit-blocks" aria-label="Active limit blocks">
            {data.active_limit_blocks.map((block) => (
              <li key={`${block.operation_kind}:${block.limit_name}`}>
                {block.limit_reason}
              </li>
            ))}
          </ul>
        ) : null}

        <footer className="account-popover-actions">
          {canManageBilling ? (
            <a href="/upgrade">
              <CreditCard aria-hidden="true" size={15} />
              Manage billing
            </a>
          ) : (
            <span />
          )}
          <a href="/sign-out">
            <LogOut aria-hidden="true" size={15} />
            Sign out
          </a>
        </footer>
      </div>
    </details>
  );
}

function UsageRow({
  label,
  used,
  limit,
  unit,
  resetAt
}: {
  label: string;
  used: number;
  limit: number | null;
  unit: HumanAccountUsageMetric["unit"] | "bytes";
  resetAt?: string | null;
}) {
  return (
    <div className="account-usage-row">
      <span>
        <strong>{label}</strong>
        <small
          title={resetAt ? `Resets ${formatUtcTimestamp(resetAt)}` : undefined}
        >
          {usageValue(used, unit)} of{" "}
          {limit === null ? "unlimited" : usageValue(limit, unit)}
        </small>
      </span>
    </div>
  );
}

function usageLabel(metric: HumanAccountUsageMetric) {
  if (metric.limitName === "input_submissions_per_calendar_month")
    return "Submissions this month";
  if (metric.limitName === "input_submissions_per_day")
    return "Submissions today";
  if (
    metric.limitName === "authenticated_caller_api_requests_per_calendar_month"
  )
    return "API requests this month";
  return "Items in queue";
}

function usageValue(
  value: number,
  unit: HumanAccountUsageMetric["unit"] | "bytes"
) {
  if (unit === "bytes") return formatBytes(value);
  return new Intl.NumberFormat("en-US").format(value);
}

function formatBytes(value: number) {
  if (value < 1_000) return `${value} B`;
  if (value < 1_000_000) return `${trimDecimal(value / 1_000)} KB`;
  if (value < 1_000_000_000) return `${trimDecimal(value / 1_000_000)} MB`;
  return `${trimDecimal(value / 1_000_000_000)} GB`;
}

function trimDecimal(value: number) {
  return value >= 10
    ? Math.round(value).toString()
    : value.toFixed(1).replace(".0", "");
}

function accountTierLabel(tier: HumanAccountBannerData["tier"]) {
  if (tier === "self_hosted") return "Self-hosted";
  return tier === "hosted_paid" ? "Paid" : "Free";
}

function avatarLetter(value: string) {
  return value.trim().charAt(0).toUpperCase() || "A";
}

function closeAccountMenu(event: MouseEvent<HTMLButtonElement>) {
  const disclosure = event.currentTarget.closest("details");
  if (!disclosure) return;
  disclosure.open = false;
  disclosure.querySelector<HTMLElement>("summary")?.focus();
}
