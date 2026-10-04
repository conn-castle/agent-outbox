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

// datetime-local inputs step by whole minutes, while stored UTC bounds may carry
// seconds and up to nine fractional digits. Rounding the minimum up keeps the
// earliest offered minute inside the server's inclusive full-precision range.
export function localDateTimeBound(
  value: string | null,
  timezone: string,
  rounding: "up" | "down"
) {
  if (!value) return undefined;
  const parsed = new Date(value).getTime();
  if (Number.isNaN(parsed)) return undefined;
  const minute = Math.floor(parsed / MINUTE_MS) * MINUTE_MS;
  const minimumInstant =
    rounding === "up" && hasSubMinutePrecision(value)
      ? minute + MINUTE_MS
      : minute;
  let instant = minimumInstant;
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  });
  const formatLocal = (timestamp: number) => {
    const parts = formatter.formatToParts(new Date(timestamp));
    const part = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((entry) => entry.type === type)?.value ?? "";
    return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}:${part("second")}`;
  };

  for (;;) {
    const bound = formatLocal(instant).slice(0, 16);
    if (rounding === "down") return bound;

    // Match utcFromLocalDateTime's three offset adjustments: during a fold,
    // the submitted civil minute may resolve to an earlier UTC occurrence.
    const desiredUtc = Date.parse(`${bound}:00Z`);
    let resolved = desiredUtc;
    for (let index = 0; index < 3; index += 1) {
      resolved += desiredUtc - Date.parse(`${formatLocal(resolved)}Z`);
    }
    if (resolved >= minimumInstant && formatLocal(resolved) === `${bound}:00`) {
      return bound;
    }
    // Advance through the repeated hour until the server accepts the minute.
    instant += MINUTE_MS;
  }
}

// Date keeps only milliseconds, so check the original string's digits.
function hasSubMinutePrecision(value: string) {
  const match = /:(\d{2})(?:\.(\d+))?Z$/.exec(value);
  return match !== null && (match[1] !== "00" || /[1-9]/.test(match[2] ?? ""));
}
