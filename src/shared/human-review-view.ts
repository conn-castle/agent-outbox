import type { QueuePriority } from "../server/input-schema.ts";

export const HUMAN_REVIEW_VIEW_PARAM_KEYS = [
  "search",
  "status",
  "priority",
  "type",
  "order",
  "sort",
  "dir",
  "then",
  "then_dir",
  "page"
] as const;

export type HumanReviewSort =
  | "priority"
  | "type"
  | "visual_score"
  | "title"
  | "caller"
  | "created_at"
  | "updated_at";
export type HumanReviewSortDirection = "asc" | "desc";
export type HumanReviewSortRule = {
  key: HumanReviewSort;
  direction: HumanReviewSortDirection;
};

export type HumanReviewView = {
  search: string;
  status: "pending" | "answered";
  priorities: QueuePriority[];
  types: string[];
  sorts: HumanReviewSortRule[];
  page: number;
};

type SearchParamRecord = Record<string, string | string[] | undefined>;
const PRIORITIES = ["urgent", "high", "normal", "low"] as const;
const MAX_TYPE_FILTERS = 50;
const MAX_TYPE_LENGTH = 160;

export function firstSearchParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export function humanReviewViewFromRecord(
  params: SearchParamRecord | undefined
): HumanReviewView {
  return parseHumanReviewView(
    (key) => firstSearchParam(params?.[key]),
    (key) => {
      const value = params?.[key];
      return value === undefined ? [] : Array.isArray(value) ? value : [value];
    }
  );
}

export function humanReviewViewFromSearchParams(
  params: Pick<URLSearchParams, "get" | "getAll">
): HumanReviewView {
  return parseHumanReviewView(
    (key) => params.get(key) ?? undefined,
    (key) => params.getAll(key)
  );
}

export function writeHumanReviewView(
  params: URLSearchParams,
  view: HumanReviewView
) {
  for (const key of HUMAN_REVIEW_VIEW_PARAM_KEYS) params.delete(key);
  setOrDelete(params, "search", view.search);
  setOrDelete(params, "status", view.status === "pending" ? "" : view.status);
  replaceAll(params, "priority", canonicalPriorities(view.priorities));
  replaceAll(params, "type", canonicalTypes(view.types));
  if (!isDefaultHumanReviewOrdering(view)) {
    replaceAll(
      params,
      "order",
      canonicalSortRules(view.sorts).map(
        ({ key, direction }) => `${key}:${direction}`
      )
    );
  }
  setOrDelete(params, "page", view.page === 1 ? "" : String(view.page));
}

export function humanReviewHref(
  view: HumanReviewView,
  inputItemId?: string,
  composeAction?: string
) {
  const params = new URLSearchParams();
  writeHumanReviewView(params, view);
  if (inputItemId) {
    params.set("item", inputItemId);
    if (composeAction) params.set("compose", composeAction);
  }
  const query = params.toString();
  return query ? `/human?${query}` : "/human";
}

export function defaultHumanReviewSortDirection(
  sort: HumanReviewSort
): HumanReviewSortDirection {
  return sort === "visual_score" ||
    sort === "created_at" ||
    sort === "updated_at"
    ? "desc"
    : "asc";
}

export function isDefaultHumanReviewOrdering(
  view: Pick<HumanReviewView, "sorts">
) {
  return (
    view.sorts.length === 1 &&
    view.sorts[0]?.key === "priority" &&
    view.sorts[0]?.direction === "asc"
  );
}

export function humanReviewMatchesFacets(
  row: { priority: QueuePriority; rowType: { display: string } },
  view: Pick<HumanReviewView, "priorities" | "types">
) {
  return (
    (view.priorities.length === 0 || view.priorities.includes(row.priority)) &&
    (view.types.length === 0 || view.types.includes(row.rowType.display))
  );
}

function parseHumanReviewView(
  readOne: (
    key: (typeof HUMAN_REVIEW_VIEW_PARAM_KEYS)[number]
  ) => string | undefined,
  readAll: (key: (typeof HUMAN_REVIEW_VIEW_PARAM_KEYS)[number]) => string[]
): HumanReviewView {
  const status = readOne("status");
  const sorts = parseSortRules(readAll("order"), readOne);
  const rawPage = readOne("page");
  const parsedPage = rawPage && /^\d+$/.test(rawPage) ? Number(rawPage) : 1;

  return {
    search: readOne("search")?.trim() ?? "",
    status: status === "answered" ? "answered" : "pending",
    priorities: canonicalPriorities(readAll("priority")),
    types: canonicalTypes(readAll("type")),
    sorts,
    page: Number.isSafeInteger(parsedPage) && parsedPage >= 1 ? parsedPage : 1
  };
}

function parseSort<TFallback extends HumanReviewSort | "none">(
  value: string | undefined,
  fallback: TFallback
): HumanReviewSort | TFallback {
  return value === "priority" ||
    value === "type" ||
    value === "visual_score" ||
    value === "title" ||
    value === "caller" ||
    value === "created_at" ||
    value === "updated_at"
    ? value
    : fallback;
}

function parseSortRules(
  values: readonly string[],
  readOne: (
    key: (typeof HUMAN_REVIEW_VIEW_PARAM_KEYS)[number]
  ) => string | undefined
): HumanReviewSortRule[] {
  const parsed = values.flatMap((value) => {
    const separator = value.lastIndexOf(":");
    if (separator < 1) return [];
    const key = parseSort(value.slice(0, separator), "none");
    const direction = parseDirection(value.slice(separator + 1), "none");
    return key === "none" || direction === "none" ? [] : [{ key, direction }];
  });
  if (parsed.length > 0) return canonicalSortRules(parsed);

  const primary = parseSort(readOne("sort"), "priority");
  const secondary = parseSort(readOne("then"), "none");
  return canonicalSortRules([
    {
      key: primary,
      direction: parseDirection(
        readOne("dir"),
        defaultHumanReviewSortDirection(primary)
      )
    },
    ...(secondary === "none" || secondary === primary
      ? []
      : [
          {
            key: secondary,
            direction: parseDirection(
              readOne("then_dir"),
              defaultHumanReviewSortDirection(secondary)
            )
          }
        ])
  ]);
}

function canonicalSortRules(rules: readonly HumanReviewSortRule[]) {
  const unique: HumanReviewSortRule[] = [];
  for (const rule of rules) {
    if (!unique.some((candidate) => candidate.key === rule.key))
      unique.push(rule);
  }
  return unique.length > 0
    ? unique
    : [{ key: "priority" as const, direction: "asc" as const }];
}

function parseDirection(
  value: string | undefined,
  fallback: HumanReviewSortDirection
): HumanReviewSortDirection;
function parseDirection<TFallback extends "none">(
  value: string | undefined,
  fallback: TFallback
): HumanReviewSortDirection | TFallback;
function parseDirection(
  value: string | undefined,
  fallback: HumanReviewSortDirection | "none"
) {
  return value === "asc" || value === "desc" ? value : fallback;
}

function canonicalPriorities(values: readonly string[]) {
  const selected = new Set(values);
  return PRIORITIES.filter((priority) => selected.has(priority));
}

function canonicalTypes(values: readonly string[]) {
  return [...new Set(values)]
    .filter(
      (value) => value.trim().length > 0 && value.length <= MAX_TYPE_LENGTH
    )
    .sort(compareText)
    .slice(0, MAX_TYPE_FILTERS);
}

function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function replaceAll(
  params: URLSearchParams,
  key: string,
  values: readonly string[]
) {
  params.delete(key);
  for (const value of values) params.append(key, value);
}

function setOrDelete(params: URLSearchParams, key: string, value: string) {
  if (value) params.set(key, value);
  else params.delete(key);
}
