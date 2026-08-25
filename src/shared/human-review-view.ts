export const HUMAN_REVIEW_VIEW_PARAM_KEYS = [
  "search",
  "status",
  "sort",
  "page"
] as const;

export type HumanReviewView = {
  search: string;
  status: "pending" | "answered";
  sort: "priority" | "updated_at";
  page: number;
};

type SearchParamRecord = Record<string, string | string[] | undefined>;

export function firstSearchParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export function humanReviewViewFromRecord(
  params: SearchParamRecord | undefined
): HumanReviewView {
  return parseHumanReviewView((key) => firstSearchParam(params?.[key]));
}

export function humanReviewViewFromSearchParams(
  params: Pick<URLSearchParams, "get">
): HumanReviewView {
  return parseHumanReviewView((key) => params.get(key) ?? undefined);
}

export function writeHumanReviewView(
  params: URLSearchParams,
  view: HumanReviewView
) {
  setOrDelete(params, "search", view.search);
  setOrDelete(params, "status", view.status === "pending" ? "" : view.status);
  setOrDelete(params, "sort", view.sort === "priority" ? "" : view.sort);
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
    if (composeAction) {
      params.set("compose", composeAction);
    }
  }
  const query = params.toString();
  return query ? `/human?${query}` : "/human";
}

function parseHumanReviewView(
  read: (
    key: (typeof HUMAN_REVIEW_VIEW_PARAM_KEYS)[number]
  ) => string | undefined
): HumanReviewView {
  const status = read("status");
  const sort = read("sort");
  const rawPage = read("page");
  const parsedPage = rawPage && /^\d+$/.test(rawPage) ? Number(rawPage) : 1;

  return {
    search: read("search")?.trim() ?? "",
    status: status === "answered" ? "answered" : "pending",
    sort: sort === "updated_at" ? "updated_at" : "priority",
    page: Number.isSafeInteger(parsedPage) && parsedPage >= 1 ? parsedPage : 1
  };
}

function setOrDelete(params: URLSearchParams, key: string, value: string) {
  if (value) {
    params.set(key, value);
  } else {
    params.delete(key);
  }
}
