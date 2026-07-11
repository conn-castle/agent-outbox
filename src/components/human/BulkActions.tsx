"use client";

import { useFormStatus } from "react-dom";

import { submitBulkHumanAnswers } from "../../../app/human/actions";
import type {
  HumanReviewBulkAction,
  HumanReviewListRow
} from "../../server/human-review.ts";
import { ViewStateFields } from "./ActionForms";
import { HumanIcon } from "./TypedContent";

export function BulkActions({
  selectedRows,
  offPageSelectedCount
}: {
  selectedRows: HumanReviewListRow[];
  offPageSelectedCount: number;
}) {
  const pendingRows = selectedRows.filter((row) => row.status === "pending");
  const compatibleActions = commonNoPopupActions(pendingRows);
  const disabled = pendingRows.length === 0 || compatibleActions.length === 0;

  return (
    <form className="bulk-actions" action={submitBulkHumanAnswers}>
      <ViewStateFields />
      <div>
        <strong>Bulk action</strong>
        <span>
          {pendingRows.length} selected pending{" "}
          {pendingRows.length === 1 ? "row" : "rows"}
        </span>
        {offPageSelectedCount > 0 ? (
          <span>
            {offPageSelectedCount} selected on other pages{" "}
            {offPageSelectedCount === 1 ? "is" : "are"} not included.
          </span>
        ) : null}
      </div>
      {pendingRows.map((row) => (
        <input
          key={row.inputItemId}
          type="hidden"
          name="bulkItem"
          value={JSON.stringify({
            inputItemId: row.inputItemId,
            callerId: row.caller.callerId,
            expectedRevision: row.currentRevision
          })}
        />
      ))}
      <label>
        <span className="sr-only">Compatible no-popup action</span>
        <select name="bulkActionValue" disabled={disabled} required>
          {compatibleActions.map((action) => (
            <option key={action.value} value={action.value}>
              {action.display}
            </option>
          ))}
        </select>
      </label>
      <BulkSubmitButton disabled={disabled} action={compatibleActions[0]} />
    </form>
  );
}

function BulkSubmitButton({
  disabled,
  action
}: {
  disabled: boolean;
  action: HumanReviewBulkAction | undefined;
}) {
  const status = useFormStatus();
  return (
    <button
      className="secondary-button"
      type="submit"
      disabled={disabled || status.pending}
    >
      <HumanIcon name={action?.icon ?? "check"} />
      <span>{status.pending ? "Submitting" : "Apply"}</span>
    </button>
  );
}

function commonNoPopupActions(rows: HumanReviewListRow[]) {
  if (rows.length === 0) {
    return [];
  }

  const [first, ...rest] = rows;
  return first.bulkActions.filter((candidate) =>
    rest.every((row) =>
      row.bulkActions.some(
        (action) =>
          action.value === candidate.value &&
          action.display === candidate.display &&
          action.icon === candidate.icon
      )
    )
  );
}
