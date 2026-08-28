"use client";

import { useEffect, useState } from "react";

function utcLabel(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Expiration time unavailable";
  return `Expires ${date.toISOString().replace("T", " ").slice(0, 16)} UTC`;
}

function localLabel(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Expiration time unavailable";
  const formatted = new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short"
  }).format(date);
  return `Expires ${formatted}`;
}

export function LocalExpiry({ value }: { value: string }) {
  const [label, setLabel] = useState(() => utcLabel(value));

  useEffect(() => {
    setLabel(localLabel(value));
  }, [value]);

  return <time dateTime={value}>{label}</time>;
}
