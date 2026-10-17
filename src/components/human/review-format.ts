import {
  calendarTimestamp,
  utcFromLocalDateTime,
  zonedParts
} from "../../shared/local-datetime.ts";

const relativeTimestampFormatter = new Intl.RelativeTimeFormat("en", {
  numeric: "auto",
  style: "short"
});

const utcTimestampFormatter = new Intl.DateTimeFormat("en", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC"
});

export function formatQueueTimestamp(value: string, referenceTime: string) {
  const differenceMs =
    new Date(value).getTime() - new Date(referenceTime).getTime();
  const absoluteMs = Math.abs(differenceMs);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const week = 7 * day;

  if (absoluteMs < hour) {
    return relativeTimestampFormatter.format(
      Math.round(differenceMs / minute),
      "minute"
    );
  }
  if (absoluteMs < 2 * day) {
    return relativeTimestampFormatter.format(
      Math.round(differenceMs / hour),
      "hour"
    );
  }
  if (absoluteMs < 3 * week) {
    return relativeTimestampFormatter.format(
      Math.round(differenceMs / day),
      "day"
    );
  }
  return relativeTimestampFormatter.format(
    Math.round(differenceMs / week),
    "week"
  );
}

export function formatUtcTimestamp(value: string) {
  return utcTimestampFormatter.format(new Date(value));
}

export function formatExactUtcTimestamp(value: string) {
  return new Date(value).toISOString().replace("T", " ").replace("Z", " UTC");
}

export function formatReviewPriority(value: string) {
  switch (value) {
    case "urgent":
      return "Urgent priority";
    case "high":
      return "High priority";
    case "low":
      return "Low priority";
    default:
      return "Normal priority";
  }
}

export function visualUnitSuffix(display: string, unit: string | null) {
  const normalizedDisplay = display.trimEnd();
  if (!unit || normalizedDisplay.endsWith(unit)) {
    return null;
  }
  return unit === "%" ? unit : ` ${unit}`;
}

const MINUTE_MS = 60_000;

// Native bounds must use the same civil-minute resolver as form submission.
// Across a fold, projecting the UTC maximum directly can hide valid minutes.
export function localDateTimeBound(
  value: string | null,
  timezone: string,
  rounding: "up" | "down"
) {
  if (!value) return undefined;
  const parsed = new Date(value).getTime();
  if (!Number.isFinite(parsed)) return undefined;
  // Date truncates fractions beyond milliseconds; retain inclusive precision.
  const extraFraction = /\.\d{3}(\d+)Z$/.exec(value)?.[1] ?? "";
  const threshold =
    parsed + (rounding === "up" && /[1-9]/.test(extraFraction) ? 1 : 0);

  try {
    // Only offsets adjacent to the bound can affect its civil endpoint. Sample
    // either side of a transition, then search at most its offset difference.
    // Ordinary bounds need one resolver call, regardless of the action range.
    const day = 24 * 60 * MINUTE_MS;
    const offsets = [-day, 0, day].map((delta) => {
      const instant = parsed + delta;
      return (
        calendarTimestamp(zonedParts(new Date(instant), timezone)) -
        Math.floor(instant / 1000) * 1000
      );
    });
    const first = Math.min(...offsets);
    const last = Math.max(...offsets);
    const upward = rounding === "up";
    let civil = upward
      ? Math.ceil((threshold + first) / MINUTE_MS) * MINUTE_MS
      : Math.floor((threshold + last) / MINUTE_MS) * MINUTE_MS;
    const steps = Math.ceil((last - first) / MINUTE_MS);
    for (let index = 0; index <= steps; index += 1) {
      const bound = new Date(civil).toISOString().slice(0, 16);
      const resolved = utcFromLocalDateTime(bound, timezone);
      if (resolved !== null) {
        const instant = Date.parse(resolved);
        if (upward ? instant >= threshold : instant <= threshold) return bound;
      }
      civil += upward ? MINUTE_MS : -MINUTE_MS;
    }
  } catch {
    // Invalid zones or dates outside the native input's range have no bound.
    return undefined;
  }
  return undefined;
}
