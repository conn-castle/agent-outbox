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
  resolveSupportedColor,
  SUPPORTED_LUCIDE_ICON_NAMES
} from "../../shared/input-schema-rules.ts";

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

export function HumanIcon({
  name,
  className
}: {
  name: string | null;
  className?: string;
}) {
  if (!name) {
    return null;
  }
  const Icon = supportedIconNames.has(name)
    ? iconMap[name as SupportedLucideIconName]
    : File;
  return <Icon className={className ?? "human-icon"} aria-hidden="true" />;
}

export function LinkButtons({ links }: { links: HumanReviewLinkButton[] }) {
  if (links.length === 0) {
    return null;
  }

  return (
    <div className="link-buttons" aria-label="Context links">
      {links.map((link) => {
        const href = safeHref(link.url);
        return href ? (
          <a
            key={`${link.displayOrder}-${link.url}`}
            className="secondary-button"
            href={href}
            target="_blank"
            rel="noreferrer"
          >
            <HumanIcon name={link.icon} />
            <span>{link.display}</span>
          </a>
        ) : null;
      })}
    </div>
  );
}

export function CardVisual({
  visual
}: {
  visual: HumanReviewListRow["cardVisual"];
}) {
  if (!visual) {
    return null;
  }

  if (visual.kind === "numeric_bar") {
    const metrics = numericVisualMetrics(visual.payload);
    return (
      <div className="card-visual numeric-bar">
        <div className="visual-meta">
          <span>{metrics.label}</span>
          <strong>
            {metrics.display}
            {metrics.unit ? (
              <span className="visual-unit">{metrics.unit}</span>
            ) : null}
          </strong>
        </div>
        <div className="bar-track" aria-hidden="true">
          <span className="bar-fill" style={{ width: `${metrics.percent}%` }} />
        </div>
      </div>
    );
  }

  if (visual.kind === "progress_ring") {
    const metrics = numericVisualMetrics(visual.payload);
    const color = visual.payload.color;
    const paletteColor = color ? resolveSupportedColor(color) : null;
    return (
      <div className="card-visual progress-ring">
        <span
          className="ring"
          style={
            {
              "--ring-progress": `${metrics.percent}%`,
              "--ring-color": paletteColor ?? "#326b91"
            } as React.CSSProperties
          }
          aria-hidden="true"
        ></span>
        <div className="visual-meta">
          <span>{metrics.label}</span>
          <strong>
            {metrics.display}
            {metrics.unit ? (
              <span className="visual-unit">{metrics.unit}</span>
            ) : null}
          </strong>
        </div>
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
        style={
          paletteColor
            ? ({ "--visual-color": paletteColor } as CSSProperties)
            : undefined
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
  try {
    const parsed = new URL(url);
    return ["http:", "https:", "mailto:"].includes(parsed.protocol)
      ? url
      : null;
  } catch {
    return null;
  }
}

function boundedPercent(value: number, min: number, max: number) {
  if (max <= min) {
    return 0;
  }
  return Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100));
}
