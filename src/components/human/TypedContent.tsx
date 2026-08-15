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

import type { JsonValue } from "../../server/human-answer.ts";
import type {
  HumanReviewLinkButton,
  HumanReviewListRow
} from "../../server/human-review.ts";
import {
  isSafeColor,
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
  if (!visual || !isRecord(visual.payload)) {
    return null;
  }

  if (visual.kind === "numeric_bar") {
    const metrics = numericVisualMetrics(visual.payload);
    const tone = visualTone(visual.payload, metrics.percent);
    return (
      <div className={`card-visual numeric-bar signal-${tone}`}>
        <div className="visual-meta">
          <span>{metrics.label}</span>
          <strong>
            {metrics.display}
            {metrics.unit}
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
    const color = stringOrNull(visual.payload.color);
    const safeColor = color && isSafeColor(color) ? color : null;
    const tone = visualTone(visual.payload, metrics.percent);
    const fallbackColor =
      tone === "positive"
        ? "#39714f"
        : tone === "caution"
          ? "#906000"
          : tone === "critical"
            ? "#ad463b"
            : "#667074";
    return (
      <div className="card-visual progress-ring">
        <span
          className="ring"
          style={
            {
              "--ring-progress": `${metrics.percent}%`,
              "--ring-color": safeColor ?? fallbackColor
            } as React.CSSProperties
          }
          aria-hidden="true"
        />
        <div className="visual-meta">
          <span>{metrics.label}</span>
          <strong>{metrics.display}</strong>
        </div>
      </div>
    );
  }

  if (visual.kind === "pill") {
    const color = stringOrNull(visual.payload.color);
    const safeColor = color && isSafeColor(color) ? color : null;
    return (
      <span
        className={`card-visual pill-visual signal-${visualTone(visual.payload, null)}`}
        style={safeColor ? { borderColor: safeColor, color: safeColor } : {}}
      >
        <HumanIcon name={stringOrNull(visual.payload.icon)} />
        {stringValue(visual.payload.text)}
      </span>
    );
  }

  return null;
}

export function ReviewSignal({
  visual
}: {
  visual: HumanReviewListRow["cardVisual"];
}) {
  if (!visual || !isRecord(visual.payload)) {
    return <span className="review-signal-empty">No signal</span>;
  }

  if (visual.kind === "numeric_bar" || visual.kind === "progress_ring") {
    const metrics = numericVisualMetrics(visual.payload);
    const tone = visualTone(visual.payload, metrics.percent);
    const risk = queueRisk(visual.payload, tone);
    const state = queueRiskLabel(risk);
    return (
      <div
        className={`review-signal signal-risk-${risk}`}
        aria-label={`${state}. ${metrics.label || "Signal"}: ${metrics.display}${metrics.unit}`}
        title={metrics.label || "Signal"}
      >
        <span className="signal-state">{state}</span>
        <strong>
          {metrics.label || "Signal"} · {metrics.display}
          {metrics.unit}
        </strong>
      </div>
    );
  }

  if (visual.kind === "pill") {
    const tone = visualTone(visual.payload, null);
    const risk = queueRisk(visual.payload, tone);
    const state = queueRiskLabel(risk);
    const label = stringValue(visual.payload.label) || "Signal";
    const value = stringValue(visual.payload.text);
    return (
      <div
        className={`review-signal signal-risk-${risk}`}
        aria-label={`${state}. ${label}: ${value}`}
        title={label}
      >
        <span className="signal-state">{state}</span>
        <strong>
          {label} · {value}
        </strong>
      </div>
    );
  }

  return <span className="review-signal-empty">No signal</span>;
}

function queueRisk(
  payload: Record<string, JsonValue>,
  tone: ReturnType<typeof visualTone>
) {
  const explicitRisk = stringOrNull(payload.queue_risk);
  if (
    explicitRisk === "high" ||
    explicitRisk === "medium" ||
    explicitRisk === "low"
  ) {
    return explicitRisk;
  }
  if (tone === "critical") return "high";
  if (tone === "positive") return "low";
  return "medium";
}

function queueRiskLabel(risk: ReturnType<typeof queueRisk>) {
  if (risk === "high") return "High risk";
  if (risk === "low") return "Low risk";
  return "Medium risk";
}

function signalTone(percent: number) {
  if (percent >= 75) return "positive";
  if (percent >= 50) return "caution";
  return "critical";
}

function visualTone(
  payload: Record<string, JsonValue>,
  percent: number | null
) {
  const explicitTone = stringOrNull(payload.tone);
  if (
    explicitTone === "positive" ||
    explicitTone === "caution" ||
    explicitTone === "critical" ||
    explicitTone === "neutral"
  ) {
    return explicitTone;
  }
  return percent === null ? "neutral" : signalTone(percent);
}

function numericVisualMetrics(payload: Record<string, JsonValue>) {
  return {
    label: stringValue(payload.label),
    display: stringValue(payload.display),
    unit: stringValue(payload.unit),
    percent: boundedPercent(
      numericValue(payload.value),
      numericValue(payload.min_value),
      numericValue(payload.max_value)
    )
  };
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
