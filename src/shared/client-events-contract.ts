export const CLIENT_EVENT_BODY_BYTE_LIMIT = 8_192;
export const CLIENT_EVENT_BATCH_LIMIT = 8;

export const CLIENT_EVENT_NAMES = [
  "client_error",
  "hydration_error",
  "human_action_failed",
  "file_upload_failed",
  "ui_state_inconsistent"
] as const;

export const CLIENT_EVENT_CATEGORIES = [
  "browser_exception",
  "hydration",
  "network",
  "submission",
  "upload",
  "state"
] as const;

export type ClientEventName = (typeof CLIENT_EVENT_NAMES)[number];
export type ClientEventCategory = (typeof CLIENT_EVENT_CATEGORIES)[number];

export type ClientEvent = {
  name: ClientEventName;
  category?: ClientEventCategory;
};

export const CLIENT_EVENT_NAME_SET = new Set<ClientEventName>(
  CLIENT_EVENT_NAMES
);
export const CLIENT_EVENT_CATEGORY_SET = new Set<ClientEventCategory>(
  CLIENT_EVENT_CATEGORIES
);
