import {
  Archive,
  AtSign,
  Calendar,
  Check,
  ChevronDown,
  Clock,
  CreditCard,
  Download,
  ExternalLink,
  File,
  FlaskConical,
  Inbox,
  Mail,
  MessageSquare,
  Paperclip,
  Rocket,
  Send,
  Trash,
  Upload,
  UserPlus,
  X,
  type LucideIcon
} from "lucide-react";
import type { CSSProperties } from "react";

import type {
  HumanReviewLinkButton,
  HumanReviewListRow
} from "../../server/human-review.ts";
import {
  isHttpUrl,
  resolveSupportedColor,
  SUPPORTED_LUCIDE_ICON_NAMES
} from "../../shared/input-schema-rules.ts";
import { visualUnitSuffix } from "./review-format.ts";

type SupportedLucideIconName = (typeof SUPPORTED_LUCIDE_ICON_NAMES)[number];

const iconMap = {
  archive: Archive,
  "at-sign": AtSign,
  calendar: Calendar,
  check: Check,
  "chevron-down": ChevronDown,
  clock: Clock,
  "credit-card": CreditCard,
  download: Download,
  "external-link": ExternalLink,
  file: File,
  "flask-conical": FlaskConical,
  inbox: Inbox,
  mail: Mail,
  "message-square": MessageSquare,
  paperclip: Paperclip,
  rocket: Rocket,
  send: Send,
  trash: Trash,
  upload: Upload,
  "user-plus": UserPlus,
  x: X
} satisfies Record<SupportedLucideIconName, LucideIcon>;

const supportedIconNames = new Set<string>(SUPPORTED_LUCIDE_ICON_NAMES);

export function SafeHtml({
  html,
  className
}: {
  html: string;
  className?: string;
}) {
  return (
    <div
      className={className ? `typed-html ${className}` : "typed-html"}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

export function HumanIcon({ name }: { name: string | null }) {
  if (!name) {
    return null;
  }
  const Icon = supportedIconNames.has(name)
    ? iconMap[name as SupportedLucideIconName]
    : File;
  return <Icon className="human-icon" aria-hidden="true" />;
}

export function LinkButtons({ links }: { links: HumanReviewLinkButton[] }) {
  if (links.length === 0) {
    return null;
  }

  return (
    <span className="context-links" aria-label="Context links">
      {links.map((link) => {
        const href = safeHref(link.url);
        return href ? (
          <a
            key={`${link.displayOrder}-${link.url}`}
            href={href}
            target="_blank"
            rel="noreferrer"
          >
            <HumanIcon name={link.icon} />
            <span>{link.display}</span>
          </a>
        ) : null;
      })}
    </span>
  );
}

export function CardVisual({
  visual,
  compact = false
}: {
  visual: HumanReviewListRow["cardVisual"];
  compact?: boolean;
}) {
  if (!visual) {
    return null;
  }

  if (visual.kind === "numeric_bar") {
    return <NumericBar metrics={numericVisualMetrics(visual.payload)} />;
  }

  if (visual.kind === "progress_ring") {
    const metrics = numericVisualMetrics(visual.payload);
    const color = visual.payload.color;
    const paletteColor = color ? resolveSupportedColor(color) : null;
    if (compact) {
      return <NumericBar metrics={metrics} color={paletteColor} />;
    }
    return (
      <div className="card-visual progress-ring">
        <span
          className="ring"
          style={
            {
              "--ring-progress": `${metrics.percent}%`,
              "--ring-color": paletteColor ?? undefined
            } as CSSProperties
          }
          aria-hidden="true"
        >
          <span className="ring-value">{Math.round(metrics.percent)}%</span>
        </span>
        <VisualMeta metrics={metrics} />
      </div>
    );
  }

  if (visual.kind === "pill") {
    const color = visual.payload.color;
    const paletteColor = color ? resolveSupportedColor(color) : null;
    const icon = visual.payload.icon;
    return (
      <div
        className={`card-visual pill-visual${icon ? " pill-visual-with-icon" : ""}`}
        title={visual.payload.text}
        style={
          {
            "--visual-color": paletteColor ?? "var(--review-accent)",
            "--visual-foreground": paletteColor ? "#fff" : "var(--review-ink)"
          } as CSSProperties
        }
      >
        {icon ? (
          <span className="pill-visual-icon" aria-hidden="true">
            <HumanIcon name={icon} />
          </span>
        ) : null}
        <strong>{visual.payload.text}</strong>
      </div>
    );
  }

  return null;
}

type NumericVisualMetrics = ReturnType<typeof numericVisualMetrics>;

function NumericBar({
  metrics,
  color = null
}: {
  metrics: NumericVisualMetrics;
  color?: string | null;
}) {
  return (
    <div className="card-visual numeric-bar">
      <VisualMeta metrics={metrics} />
      <div className="bar-track" aria-hidden="true">
        <span
          className="bar-fill"
          style={
            {
              width: `${metrics.percent}%`,
              "--bar-color": color ?? undefined
            } as CSSProperties
          }
        />
      </div>
    </div>
  );
}

function VisualMeta({ metrics }: { metrics: NumericVisualMetrics }) {
  const unitSuffix = visualUnitSuffix(metrics.display, metrics.unit);
  return (
    <div className="visual-meta">
      <span>{metrics.label}</span>
      <strong>
        {metrics.display}
        {unitSuffix ? (
          <span
            className={`visual-unit${
              unitSuffix === "%" ? " visual-unit-percent" : ""
            }`}
          >
            {unitSuffix}
          </span>
        ) : null}
      </strong>
    </div>
  );
}

function numericVisualMetrics(
  payload: Extract<
    NonNullable<HumanReviewListRow["cardVisual"]>,
    { kind: "numeric_bar" | "progress_ring" }
  >["payload"]
) {
  return {
    label: payload.label,
    display: payload.display,
    unit: payload.unit,
    percent: boundedPercent(payload.value, payload.min_value, payload.max_value)
  };
}

export function safeHref(url: string) {
  return isHttpUrl(url) ? url : null;
}

function boundedPercent(value: number, min: number, max: number) {
  if (max <= min) {
    return 0;
  }
  return Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100));
}
