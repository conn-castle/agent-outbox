export const CLIENT_EVENT_BODY_BYTE_LIMIT = 8_192;
export const CLIENT_EVENT_BATCH_LIMIT = 8;

export const CLIENT_EVENT_NAMES = [
  "client_error",
  "hydration_error",
  "github_sign_in_not_ready",
  "github_sign_in_clerk_error",
  "github_sign_in_clerk_timeout",
  "github_sign_in_same_page_stall",
  "human_action_failed",
  "file_upload_failed",
  "ui_state_inconsistent"
] as const;

export const CLIENT_EVENT_CATEGORIES = [
  "browser_exception",
  "hydration",
  "authentication",
  "network",
  "submission",
  "upload",
  "state"
] as const;

export type ClientEventName = (typeof CLIENT_EVENT_NAMES)[number];
export type ClientEventCategory = (typeof CLIENT_EVENT_CATEGORIES)[number];

export const CLIENT_EVENT_CATEGORY_BY_NAME = Object.freeze({
  client_error: "browser_exception",
  hydration_error: "hydration",
  github_sign_in_not_ready: "authentication",
  github_sign_in_clerk_error: "authentication",
  github_sign_in_clerk_timeout: "authentication",
  github_sign_in_same_page_stall: "authentication",
  human_action_failed: "submission",
  file_upload_failed: "upload",
  ui_state_inconsistent: "state"
} satisfies Record<ClientEventName, ClientEventCategory>);

export type ClientEvent = {
  name: ClientEventName;
};

export const CLIENT_EVENT_NAME_SET = new Set<ClientEventName>(
  CLIENT_EVENT_NAMES
);
