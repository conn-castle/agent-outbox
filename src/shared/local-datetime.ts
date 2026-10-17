export function utcFromLocalDateTime(
  value: string | null,
  timezone: string
): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(
    value ?? ""
  );
  if (!match) {
    return null;
  }

  const desired = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: match[6] ? Number(match[6]) : 0
  };
  if (!validLocalDateTimeParts(desired)) {
    return null;
  }

  const desiredUtc = calendarTimestamp(desired);
  let instant = desiredUtc;

  try {
    // Preserve the existing three-adjustment choice of occurrence in a fold.
    for (let index = 0; index < 3; index += 1) {
      const parts = zonedParts(new Date(instant), timezone);
      const renderedUtc = calendarTimestamp(parts);
      instant += desiredUtc - renderedUtc;
    }
    const finalParts = zonedParts(new Date(instant), timezone);
    if (!sameLocalDateTimeParts(desired, finalParts)) {
      return null;
    }
  } catch {
    return null;
  }

  return new Date(instant).toISOString();
}

type LocalDateTimeParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

function validLocalDateTimeParts(parts: LocalDateTimeParts) {
  if (
    !Number.isSafeInteger(parts.year) ||
    !Number.isSafeInteger(parts.month) ||
    !Number.isSafeInteger(parts.day) ||
    !Number.isSafeInteger(parts.hour) ||
    !Number.isSafeInteger(parts.minute) ||
    !Number.isSafeInteger(parts.second) ||
    parts.year < 1 ||
    parts.month < 1 ||
    parts.month > 12 ||
    parts.day < 1 ||
    parts.hour < 0 ||
    parts.hour > 23 ||
    parts.minute < 0 ||
    parts.minute > 59 ||
    parts.second < 0 ||
    parts.second > 59
  ) {
    return false;
  }

  const date = new Date(
    calendarTimestamp({ ...parts, hour: 0, minute: 0, second: 0 })
  );
  return (
    date.getUTCFullYear() === parts.year &&
    date.getUTCMonth() === parts.month - 1 &&
    date.getUTCDate() === parts.day
  );
}

function sameLocalDateTimeParts(
  left: LocalDateTimeParts,
  right: LocalDateTimeParts
) {
  return (
    left.year === right.year &&
    left.month === right.month &&
    left.day === right.day &&
    left.hour === right.hour &&
    left.minute === right.minute &&
    left.second === right.second
  );
}

// Bounds reuse one zone through their adjustment loop. Retain only the most
// recently used formatter so caching stays bounded across server requests.
let lastTimezone: string | undefined;
let lastFormatter: Intl.DateTimeFormat | undefined;

export function zonedParts(date: Date, timezone: string) {
  if (lastTimezone !== timezone || !lastFormatter) {
    lastFormatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      // Neighboring offset samples can cross into the preceding ISO year.
      era: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23"
    });
    lastTimezone = timezone;
  }
  const parts = lastFormatter.formatToParts(date);
  const part = (type: string) =>
    Number(parts.find((entry) => entry.type === type)?.value);
  return {
    year:
      parts.find((entry) => entry.type === "era")?.value === "BC"
        ? 1 - part("year")
        : part("year"),
    month: part("month"),
    day: part("day"),
    hour: part("hour"),
    minute: part("minute"),
    second: part("second")
  };
}

// Date.UTC maps years 0–99 to 1900–1999. Explicit calendar setters preserve
// the accepted ISO year during validation and every resolver adjustment.
export function calendarTimestamp(parts: LocalDateTimeParts) {
  const date = new Date(0);
  date.setUTCFullYear(parts.year, parts.month - 1, parts.day);
  date.setUTCHours(parts.hour, parts.minute, parts.second, 0);
  return date.getTime();
}
