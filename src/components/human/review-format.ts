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

export function formatReviewPriority(value: string) {
  switch (value) {
    case "urgent":
      return "Due now";
    case "high":
      return "High priority";
    case "low":
      return "Low priority";
    default:
      return "Routine";
  }
}
