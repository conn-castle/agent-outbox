export const REVIEW_ROW_SIZE_BEHAVIORS = {
  fixed: {
    label: "Fixed width + height",
    description: "Content does not change the slot's width or height."
  },
  horizontal: {
    label: "Width can grow",
    description:
      "A single-line slot can widen with content until its available space is exhausted."
  },
  vertical: {
    label: "Height can grow",
    description:
      "The slot keeps its column width while additional or variant content can increase its height."
  },
  both: {
    label: "Width + height can grow",
    description: "Content can consume available width and add lines vertically."
  }
} as const;

export type ReviewRowSizeBehavior = keyof typeof REVIEW_ROW_SIZE_BEHAVIORS;
export type ReviewRowAnatomyKind =
  "content" | "control" | "infrastructure" | "modifier";

export const REVIEW_ROW_ANATOMY_VIEWPORTS = [
  { key: "wide", label: "Wide desktop", width: 1200 },
  { key: "desktop", label: "Desktop", width: 960 },
  { key: "compact", label: "Compact", width: 760 },
  { key: "phone", label: "Phone", width: 390 }
] as const;

export const REVIEW_ROW_ANATOMY_PARTS = {
  rowType: {
    label: "Row type",
    description: "Classifies the review with a display label and icon.",
    fields: ["row_type.display", "row_type.icon"],
    owner: "caller",
    kind: "content",
    sizeBehavior: "horizontal"
  },
  corner: {
    label: "Corner metadata",
    description:
      "Optional context such as an amount, environment, or count. When absent, Agent Outbox shows a visually distinct product-owned update timestamp fallback.",
    fields: ["corner"],
    owner: "caller",
    kind: "content",
    sizeBehavior: "horizontal"
  },
  contextLinks: {
    label: "Context links",
    description:
      "Zero to 32 link buttons, each with a display label, icon, and HTTP(S) URL.",
    fields: ["link_buttons[]"],
    owner: "caller",
    kind: "content",
    sizeBehavior: "both"
  },
  copyIdentifier: {
    label: "Copy identifier",
    description:
      "Copies the caller-provided caller_item_id rather than the internal database ID. The icon confirms success; failures expose the identifier for manual copying.",
    fields: ["caller_item_id"],
    owner: "product",
    kind: "control",
    sizeBehavior: "fixed"
  },
  feedback: {
    label: "Feedback",
    description:
      "Icon-only control for a local feedback draft, separate from answer buttons. The tooltip is Add feedback when empty and Edit feedback when a draft is present; a dot marks the latter. Saving does not submit an answer.",
    fields: [],
    owner: "product",
    kind: "control",
    sizeBehavior: "fixed"
  },
  skip: {
    label: "Snooze",
    description:
      "Moves the review behind other entries locally, without scheduling a reminder. skip_disabled makes it unavailable. The icon-only button keeps a tooltip and accessible name at every width.",
    fields: ["skip_disabled"],
    owner: "product",
    kind: "control",
    sizeBehavior: "fixed"
  },
  overflowActions: {
    label: "More actions",
    description:
      "Appears on pending rows when one or more actions use overflow: true. Answered rows keep the result and undo flow instead of live overflow decision controls.",
    fields: ["actions[].overflow"],
    owner: "product",
    kind: "control",
    sizeBehavior: "fixed"
  },
  title: {
    label: "Title + subtitle",
    description:
      "Required title and subtitle. The queue title opens details, so nested links in those fields are flattened to text in the row.",
    fields: ["title", "subtitle"],
    owner: "caller",
    kind: "content",
    sizeBehavior: "vertical"
  },
  visual: {
    label: "Card visual",
    description:
      "No visual, or one numeric_bar, progress_ring, or pill card visual.",
    fields: ["card_visual"],
    owner: "caller",
    kind: "content",
    sizeBehavior: "vertical"
  },
  summary: {
    label: "Summary",
    description: "Required summary describing the decision being requested.",
    fields: ["summary"],
    owner: "caller",
    kind: "content",
    sizeBehavior: "vertical"
  },
  details: {
    label: "Details",
    description:
      "Always available; opens the complete decision surface. The optional caller details field supplies a rich-content section labeled Details inside that surface.",
    fields: [],
    owner: "product",
    kind: "control",
    sizeBehavior: "fixed"
  },
  actions: {
    label: "Action rail",
    description:
      "Primary actions with overflow: false, each with a display label, icon, stable value, optional fixed tone and style, and its own popup.",
    fields: ["actions[]"],
    owner: "caller",
    kind: "content",
    sizeBehavior: "vertical"
  },
  scrollbar: {
    label: "Scrollbar gutter",
    description: "Reserved scrollbar gutter; not caller content.",
    fields: [],
    owner: "product",
    kind: "infrastructure",
    sizeBehavior: "fixed"
  },
  accent: {
    label: "Row accent",
    description: "Decorates the row container.",
    fields: ["row_accent_color"],
    owner: "caller",
    kind: "modifier",
    sizeBehavior: null
  },
  priority: {
    label: "Priority treatment",
    description:
      "Controls ordering and a restrained visible Low, Normal, High, or Urgent treatment; it never implies an unsupplied deadline.",
    fields: ["priority"],
    owner: "caller",
    kind: "modifier",
    sizeBehavior: null
  }
} as const satisfies Record<
  string,
  {
    label: string;
    description: string;
    fields: readonly string[];
    owner: "caller" | "product";
    kind: ReviewRowAnatomyKind;
    sizeBehavior: ReviewRowSizeBehavior | null;
  }
>;

export type ReviewRowAnatomyPartKey = keyof typeof REVIEW_ROW_ANATOMY_PARTS;
