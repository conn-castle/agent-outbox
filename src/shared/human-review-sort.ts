import type { HumanReviewListRow } from "../server/human-review.ts";
import type {
  HumanReviewSort,
  HumanReviewSortDirection,
  HumanReviewSortRule
} from "./human-review-view.ts";

type HumanReviewSortView = {
  sorts: HumanReviewSortRule[];
};

const PRIORITY_WEIGHT = { urgent: 0, high: 1, normal: 2, low: 3 } as const;

export function compareHumanReviewRows(
  left: HumanReviewListRow,
  right: HumanReviewListRow,
  view: HumanReviewSortView
) {
  const rules = [
    ...view.sorts,
    { key: "updated_at" as const, direction: "desc" as const }
  ].filter(
    (rule, index, all) =>
      all.findIndex((candidate) => candidate.key === rule.key) === index
  );
  for (const rule of rules) {
    if (rule.key === "visual_score") {
      const compared = compareNullableNumbers(
        humanReviewVisualScore(left),
        humanReviewVisualScore(right),
        rule.direction
      );
      if (compared !== 0) return compared;
      continue;
    }
    const compared = compareByKey(left, right, rule.key);
    if (compared !== 0) return rule.direction === "asc" ? compared : -compared;
  }
  return compareText(left.inputItemId, right.inputItemId);
}

function compareByKey(
  left: HumanReviewListRow,
  right: HumanReviewListRow,
  key: HumanReviewSort
) {
  switch (key) {
    case "priority":
      return PRIORITY_WEIGHT[left.priority] - PRIORITY_WEIGHT[right.priority];
    case "type": {
      return compareHumanReviewTypeNames(
        left.rowType.display,
        right.rowType.display
      );
    }
    case "title":
      return compareHumanReviewTypeNames(
        plainText(left.titleHtml),
        plainText(right.titleHtml)
      );
    case "caller":
      return compareHumanReviewTypeNames(
        left.caller.displayName,
        right.caller.displayName
      );
    case "created_at":
      return left.createdAt.localeCompare(right.createdAt);
    case "updated_at":
      return left.updatedAt.localeCompare(right.updatedAt);
    case "visual_score":
      return 0;
  }
}

export function humanReviewVisualScore(row: HumanReviewListRow) {
  const visual = row.cardVisual;
  if (
    !visual ||
    (visual.kind !== "numeric_bar" && visual.kind !== "progress_ring")
  )
    return null;
  const { value, min_value: minimum, max_value: maximum } = visual.payload;
  if (
    !Number.isFinite(value) ||
    !Number.isFinite(minimum) ||
    !Number.isFinite(maximum) ||
    maximum <= minimum
  )
    return null;
  return Math.max(
    0,
    Math.min(100, ((value - minimum) / (maximum - minimum)) * 100)
  );
}

export function compareHumanReviewTypeNames(left: string, right: string) {
  return (
    compareText(asciiFold(left), asciiFold(right)) || compareText(left, right)
  );
}

function compareText(left: string, right: string) {
  const leftPoints = Array.from(left, (character) => character.codePointAt(0)!);
  const rightPoints = Array.from(right, (character) =>
    character.codePointAt(0)!
  );
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    const compared = (leftPoints[index] ?? 0) - (rightPoints[index] ?? 0);
    if (compared !== 0) return compared;
  }
  return leftPoints.length - rightPoints.length;
}

function asciiFold(value: string) {
  return value.replace(/[A-Z]/g, (character) => character.toLowerCase());
}

function compareNullableNumbers(
  left: number | null,
  right: number | null,
  direction: HumanReviewSortDirection
) {
  if (left === null) return right === null ? 0 : 1;
  if (right === null) return -1;
  return direction === "asc" ? left - right : right - left;
}

function plainText(value: string) {
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
