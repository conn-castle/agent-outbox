"use client";

import { useEffect, useState } from "react";
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
  const [selectedValue, setSelectedValue] = useState(
    compatibleActions[0]?.value ?? ""
  );
  const selectedAction =
    compatibleActions.find((action) => action.value === selectedValue) ??
    compatibleActions[0];

  useEffect(() => {
    if (!compatibleActions.some((action) => action.value === selectedValue)) {
      setSelectedValue(compatibleActions[0]?.value ?? "");
    }
  }, [compatibleActions, selectedValue]);

  if (pendingRows.length === 0 && offPageSelectedCount === 0) {
    return null;
  }

  return (
    <form className="bulk-actions" action={submitBulkHumanAnswers}>
      <ViewStateFields />
      <input
        type="hidden"
        name="noticeAction"
        value={selectedAction?.display ?? ""}
      />
      <div>
        <strong>
          {pendingRows.length} selected pending{" "}
          {pendingRows.length === 1 ? "row" : "rows"}
        </strong>
        <span>
          {compatibleActions.length > 0
            ? "Choose one shared action"
            : "No shared quick action"}
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
        <span className="sr-only">Compatible quick action</span>
        <select
          name="bulkActionValue"
          disabled={disabled}
          required
          value={selectedAction?.value ?? ""}
          onChange={(event) => setSelectedValue(event.target.value)}
        >
          {compatibleActions.map((action) => (
            <option key={action.value} value={action.value}>
              {action.display}
            </option>
          ))}
        </select>
      </label>
      <BulkSubmitButton disabled={disabled} action={selectedAction} />
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
      <span>
        {status.pending
          ? "Submitting"
          : action
            ? `Apply ${action.display}`
            : "Apply"}
      </span>
    </button>
  );
}

function commonNoPopupActions(rows: HumanReviewListRow[]) {
  if (rows.length === 0) {
    return [];
  }

  const [first, ...rest] = rows;
  return first.bulkActions.filter(
    (candidate) =>
      candidate.popupKind === "none" &&
      !candidate.overflow &&
      rest.every((row) =>
        row.bulkActions.some(
          (action) =>
            action.popupKind === "none" &&
            !action.overflow &&
            action.value === candidate.value &&
            action.display === candidate.display &&
            action.icon === candidate.icon
        )
      )
  );
}
