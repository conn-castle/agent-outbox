export const SUPPORTED_LUCIDE_ICON_NAMES = [
  "archive",
  "calendar",
  "check",
  "chevron-down",
  "clock",
  "download",
  "external-link",
  "file",
  "inbox",
  "mail",
  "paperclip",
  "send",
  "trash",
  "upload",
  "x"
] as const;

const DISALLOWED_COLOR_TOKENS = [
  "url(",
  "var(",
  "calc(",
  "expression",
  "@",
  "{",
  "}",
  ";",
  "<",
  ">"
];

const SAFE_NAMED_COLORS = new Set([
  "black",
  "white",
  "gray",
  "grey",
  "red",
  "green",
  "blue",
  "yellow",
  "orange",
  "purple",
  "pink",
  "brown",
  "cyan",
  "magenta",
  "lime",
  "navy",
  "teal",
  "olive",
  "maroon",
  "silver",
  "transparent"
]);

export function isSafeColor(value: string) {
  const normalized = value.trim().toLowerCase();
  if (
    !normalized ||
    DISALLOWED_COLOR_TOKENS.some((token) => normalized.includes(token))
  ) {
    return false;
  }

  return (
    SAFE_NAMED_COLORS.has(normalized) ||
    /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(
      normalized
    ) ||
    /^rgba?\(\s*(?:25[0-5]|2[0-4]\d|1?\d?\d)\s*,\s*(?:25[0-5]|2[0-4]\d|1?\d?\d)\s*,\s*(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\s*,\s*(?:0|1|0?\.\d+))?\s*\)$/.test(
      normalized
    ) ||
    /^hsla?\(\s*(?:360|3[0-5]\d|[12]?\d?\d)\s*,\s*(?:100|[1-9]?\d)%\s*,\s*(?:100|[1-9]?\d)%(?:\s*,\s*(?:0|1|0?\.\d+))?\s*\)$/.test(
      normalized
    )
  );
}
