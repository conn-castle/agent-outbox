export type LogLevel = "info" | "warn" | "error";

export type RuntimeLogEvent = {
  level: LogLevel;
  error_id?: string;
  error_name?: string;
  request_id?: string;
  environment?: string | null;
  release?: string | null;
  surface: "app" | "api" | "scheduled";
  route?: string;
  method?: string;
  status_code?: number;
  operation: string;
  message: string;
};

const SAFE_LOG_KEYS = new Set([
  "level",
  "error_id",
  "error_name",
  "request_id",
  "environment",
  "release",
  "surface",
  "route",
  "method",
  "status_code",
  "operation",
  "message"
]);

export function safeLogEvent(event: RuntimeLogEvent) {
  const safeEntries = Object.entries(event).filter(([key, value]) => {
    return SAFE_LOG_KEYS.has(key) && value !== undefined;
  });

  return Object.fromEntries(safeEntries);
}

export function emitRuntimeLog(event: RuntimeLogEvent) {
  const payload = safeLogEvent(event);
  const line = JSON.stringify(payload);

  if (event.level === "error") {
    console.error(line);
  } else if (event.level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }

  return payload;
}
