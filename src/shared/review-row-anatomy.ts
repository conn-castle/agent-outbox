export const REVIEW_ROW_SIZE_BEHAVIORS = {
  fixed: {
    label: "Fixed width + height",
    description: "Content does not change the slot's width or height."
  },
  horizontal: {
    label: "Width can grow",
    description:
      "Content can change the slot's width, but not its single-line height."
  },
  vertical: {
    label: "Height can grow",
    description:
      "The slot keeps its column width while content can increase its height."
  },
  both: {
    label: "Width + height can grow",
    description: "Content can affect both the slot's width and its height."
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
    fields: ["row_type.display", "row_type.icon"],
    owner: "caller",
    kind: "content",
    sizeBehavior: "horizontal"
  },
  corner: {
    label: "Corner metadata",
    fields: ["corner"],
    owner: "caller",
    kind: "content",
    sizeBehavior: "horizontal"
  },
  contextLinks: {
    label: "Context links",
    fields: ["link_buttons[]"],
    owner: "caller",
    kind: "content",
    sizeBehavior: "both"
  },
  skip: {
    label: "Skip",
    fields: ["skip_disabled"],
    owner: "product",
    kind: "control",
    sizeBehavior: "fixed"
  },
  overflowActions: {
    label: "More actions",
    fields: ["actions[].overflow"],
    owner: "product",
    kind: "control",
    sizeBehavior: "fixed"
  },
  title: {
    label: "Title + subtitle",
    fields: ["title", "subtitle"],
    owner: "caller",
    kind: "content",
    sizeBehavior: "vertical"
  },
  visual: {
    label: "Card visual",
    fields: ["card_visual"],
    owner: "caller",
    kind: "content",
    sizeBehavior: "vertical"
  },
  summary: {
    label: "Summary",
    fields: ["summary"],
    owner: "caller",
    kind: "content",
    sizeBehavior: "vertical"
  },
  details: {
    label: "Details",
    fields: [],
    owner: "product",
    kind: "control",
    sizeBehavior: "fixed"
  },
  actions: {
    label: "Action rail",
    fields: ["actions[]"],
    owner: "caller",
    kind: "content",
    sizeBehavior: "vertical"
  },
  scrollbar: {
    label: "Scrollbar gutter",
    fields: [],
    owner: "product",
    kind: "infrastructure",
    sizeBehavior: "fixed"
  },
  accent: {
    label: "Row accent",
    fields: ["row_accent_color"],
    owner: "caller",
    kind: "modifier",
    sizeBehavior: null
  },
  priority: {
    label: "Priority treatment",
    fields: ["priority"],
    owner: "caller",
    kind: "modifier",
    sizeBehavior: null
  }
} as const satisfies Record<
  string,
  {
    label: string;
    fields: readonly string[];
    owner: "caller" | "product";
    kind: ReviewRowAnatomyKind;
    sizeBehavior: ReviewRowSizeBehavior | null;
  }
>;

export type ReviewRowAnatomyPartKey = keyof typeof REVIEW_ROW_ANATOMY_PARTS;
