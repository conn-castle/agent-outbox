export const SUPPORTED_LUCIDE_ICON_NAMES = [
  "archive",
  "at-sign",
  "calendar",
  "check",
  "chevron-down",
  "clock",
  "credit-card",
  "download",
  "external-link",
  "file",
  "flask-conical",
  "inbox",
  "mail",
  "message-square",
  "paperclip",
  "rocket",
  "send",
  "trash",
  "upload",
  "user-plus",
  "x"
] as const;

export const SUPPORTED_ACTION_TONES = [
  "neutral",
  "brand",
  "success",
  "warning",
  "danger"
] as const;

export const SUPPORTED_ACTION_STYLES = ["solid", "outline", "ghost"] as const;

export const SUPPORTED_COLORS = [
  "red",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
  "pink",
  "teal"
] as const;

export type SupportedColor = (typeof SUPPORTED_COLORS)[number];

export const SUPPORTED_COLOR_VALUES: Readonly<Record<SupportedColor, string>> =
  {
    red: "#b52b31",
    orange: "#a95123",
    yellow: "#965800",
    green: "#237a4b",
    blue: "#326b91",
    purple: "#745585",
    pink: "#9e4c67",
    teal: "#2d716f"
  };

const SUPPORTED_COLOR_SET = new Set<string>(SUPPORTED_COLORS);

export function isSupportedColor(value: string): value is SupportedColor {
  return SUPPORTED_COLOR_SET.has(value);
}

export function resolveSupportedColor(value: string): string | null {
  return isSupportedColor(value) ? SUPPORTED_COLOR_VALUES[value] : null;
}
