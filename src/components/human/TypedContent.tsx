import {
  Archive,
  Calendar,
  Check,
  ChevronDown,
  Clock,
  Download,
  ExternalLink,
  File,
  Inbox,
  Mail,
  Paperclip,
  Send,
  Trash,
  Upload,
  X,
  type LucideIcon
} from "lucide-react";

import type { JsonValue } from "../../server/human-answer.ts";
import type {
  HumanReviewAction,
  HumanReviewLinkButton
} from "../../server/human-review.ts";
import {
  isSafeColor,
  SUPPORTED_LUCIDE_ICON_NAMES
} from "../../shared/input-schema-rules.ts";

type SupportedLucideIconName = (typeof SUPPORTED_LUCIDE_ICON_NAMES)[number];

const iconMap = {
  archive: Archive,
  calendar: Calendar,
  check: Check,
  "chevron-down": ChevronDown,
  clock: Clock,
  download: Download,
  "external-link": ExternalLink,
  file: File,
  inbox: Inbox,
  mail: Mail,
  paperclip: Paperclip,
  send: Send,
  trash: Trash,
  upload: Upload,
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

export function AccentRail({ color }: { color: string | null }) {
  return (
    <span
      className="review-accent"
      style={color && isSafeColor(color) ? { backgroundColor: color } : {}}
      aria-hidden="true"
    />
  );
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
  visual: { kind: string; payload: JsonValue } | null;
}) {
  if (!visual || !isRecord(visual.payload)) {
    return null;
  }

  if (visual.kind === "numeric_bar") {
    const value = numericValue(visual.payload.value);
    const min = numericValue(visual.payload.min_value);
    const max = numericValue(visual.payload.max_value);
    const percent = boundedPercent(value, min, max);
    return (
      <div className="card-visual numeric-bar">
        <div className="visual-meta">
          <span>{stringValue(visual.payload.label)}</span>
          <strong>
            {stringValue(visual.payload.display)}
            {stringValue(visual.payload.unit)}
          </strong>
        </div>
        <div className="bar-track" aria-hidden="true">
          <span className="bar-fill" style={{ width: `${percent}%` }} />
        </div>
      </div>
    );
  }

  if (visual.kind === "progress_ring") {
    const value = numericValue(visual.payload.value);
    const min = numericValue(visual.payload.min_value);
    const max = numericValue(visual.payload.max_value);
    const percent = boundedPercent(value, min, max);
    const color = stringOrNull(visual.payload.color);
    const safeColor = color && isSafeColor(color) ? color : null;
    return (
      <div className="card-visual progress-ring">
        <span
          className="ring"
          style={
            {
              "--ring-progress": `${percent}%`,
              "--ring-color": safeColor ?? "#2563eb"
            } as React.CSSProperties
          }
          aria-hidden="true"
        />
        <div className="visual-meta">
          <span>{stringValue(visual.payload.label)}</span>
          <strong>{stringValue(visual.payload.display)}</strong>
        </div>
      </div>
    );
  }

  if (visual.kind === "pill") {
    const color = stringOrNull(visual.payload.color);
    const safeColor = color && isSafeColor(color) ? color : null;
    return (
      <span
        className="card-visual pill-visual"
        style={safeColor ? { borderColor: safeColor, color: safeColor } : {}}
      >
        <HumanIcon name={stringOrNull(visual.payload.icon)} />
        {stringValue(visual.payload.text)}
      </span>
    );
  }

  return null;
}

export function PopupMetadata({ action }: { action: HumanReviewAction }) {
  if (action.popupKind === "none") {
    return <span className="popup-chip">No popup</span>;
  }

  const payload = isRecord(action.popupPayload) ? action.popupPayload : {};
  const label = stringValue(payload.label) || popupKindLabel(action.popupKind);
  return (
    <div className="popup-metadata">
      <span className="popup-chip">{popupKindLabel(action.popupKind)}</span>
      <span>{label}</span>
      {action.options.length > 0 ? (
        <span>{action.options.length} options</span>
      ) : null}
    </div>
  );
}

function popupKindLabel(kind: HumanReviewAction["popupKind"]) {
  return kind.replace("_", " ");
}

function safeHref(url: string) {
  try {
    const parsed = new URL(url);
    return ["http:", "https:", "mailto:"].includes(parsed.protocol)
      ? url
      : null;
  } catch {
    return null;
  }
}

function isRecord(value: JsonValue): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: JsonValue | undefined) {
  return typeof value === "string" ? value : "";
}

function stringOrNull(value: JsonValue | undefined) {
  return typeof value === "string" ? value : null;
}

function numericValue(value: JsonValue | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function boundedPercent(value: number, min: number, max: number) {
  if (max <= min) {
    return 0;
  }
  return Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100));
}
