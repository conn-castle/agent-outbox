export const CLIENT_EVENT_BODY_BYTE_LIMIT = 8_192;
export const CLIENT_EVENT_BATCH_LIMIT = 8;

export type ClientEventCategory =
  | "browser_exception"
  | "hydration"
  | "authentication"
  | "submission"
  | "upload"
  | "state";

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
} satisfies Record<string, ClientEventCategory>);

export type ClientEventName = keyof typeof CLIENT_EVENT_CATEGORY_BY_NAME;

export function isClientEventName(value: string): value is ClientEventName {
  return Object.hasOwn(CLIENT_EVENT_CATEGORY_BY_NAME, value);
}

export type ClientEvent = {
  name: ClientEventName;
};
