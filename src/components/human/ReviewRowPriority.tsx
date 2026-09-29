import type { ReactNode } from "react";

import type { HumanReviewListRow } from "../../server/human-review.ts";
import { formatReviewPriority } from "./review-format";

// The visible priority pill shown after a review row's title. It is the only
// visible priority treatment on a row; the caller's row accent is separate.
export function ReviewRowPriority({
  priority,
  className,
  children
}: {
  priority: HumanReviewListRow["priority"];
  className?: string;
  children?: ReactNode;
}) {
  return (
    <span
      className={`row-priority priority-${priority}${className ? ` ${className}` : ""}`}
      aria-label={formatReviewPriority(priority)}
    >
      {children ?? priority.charAt(0).toUpperCase() + priority.slice(1)}
    </span>
  );
}
