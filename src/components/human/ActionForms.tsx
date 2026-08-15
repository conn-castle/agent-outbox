"use client";

import { useEffect, useState } from "react";
import { useFormStatus } from "react-dom";
import { useSearchParams } from "next/navigation";
import { X } from "lucide-react";

import { submitHumanAnswer, undoHumanAnswer } from "../../../app/human/actions";
import type { JsonValue } from "../../server/human-answer.ts";
import type {
  HumanReviewAction,
  HumanReviewBulkAction,
  HumanReviewDetail,
  HumanReviewListRow
} from "../../server/human-review.ts";
import { HUMAN_REVIEW_VIEW_PARAM_KEYS } from "../../shared/human-review-view";
import { HumanIcon } from "./TypedContent";

/**
 * Hidden inputs carrying the current URL view state (search/status/sort/page)
 * so server-action redirects can restore the view instead of resetting it.
 */
export function ViewStateFields() {
  const searchParams = useSearchParams();
  return (
    <>
      {HUMAN_REVIEW_VIEW_PARAM_KEYS.map((key) => {
        const value = searchParams.get(key);
        return value ? (
          <input key={key} type="hidden" name={`view.${key}`} value={value} />
        ) : null;
      })}
    </>
  );
}

export function InlineQuickAction({
  row,
  action
}: {
  row: HumanReviewListRow;
  action: HumanReviewBulkAction;
}) {
  const semanticClass = destructiveActionValues.has(action.value)
    ? " destructive"
    : "";
  return (
    <form className="inline-action-form" action={submitHumanAnswer}>
      <ViewStateFields />
      <HumanAnswerFields
        target={row}
        actionValue={action.value}
        popupKind="none"
        actionLabel={action.display}
        noticeSubject={plainText(row.titleHtml)}
        returnToQueue
      />
      <SubmitButton
        className={`inline-action-button${semanticClass}`}
        icon={action.icon}
        label={action.display}
      />
    </form>
  );
}

export function ActionTrigger({
  detail,
  action,
  variant,
  active,
  onActivate
}: {
  detail: HumanReviewDetail;
  action: HumanReviewAction;
  variant: "primary" | "overflow";
  active: boolean;
  onActivate: () => void;
}) {
  const semanticClass = destructiveActionValues.has(action.value)
    ? " destructive"
    : "";
  if (!action.answerable) {
    return (
      <button
        className={`${
          variant === "primary" ? "action-button" : "secondary-button"
        }${semanticClass}`}
        type="button"
        disabled
      >
        <HumanIcon name={action.icon} />
        <span>{action.display}</span>
      </button>
    );
  }

  if (action.popupKind !== "none") {
    return (
      <button
        className={
          variant === "primary"
            ? `action-button action-trigger${semanticClass}${active ? " active" : ""}`
            : `secondary-button action-trigger${semanticClass}${active ? " active" : ""}`
        }
        type="button"
        aria-expanded={active}
        onClick={onActivate}
      >
        <HumanIcon name={action.icon} />
        <span>{action.display}</span>
      </button>
    );
  }

  return (
    <form className="action-form" action={submitHumanAnswer}>
      <ViewStateFields />
      <HumanAnswerFields
        target={detail}
        actionValue={action.value}
        popupKind={action.popupKind}
        actionLabel={action.display}
        noticeSubject={plainText(detail.titleHtml)}
      />
      <SubmitButton
        className={`${
          variant === "primary" ? "action-button" : "secondary-button"
        }${semanticClass}`}
        icon={action.icon}
        label={action.display}
      />
    </form>
  );
}

const destructiveActionValues = new Set([
  "decline_post",
  "delete",
  "delete_draft",
  "ignore",
  "reject_send",
  "roll_back"
]);

export function ActionComposer({
  detail,
  action,
  onCancel
}: {
  detail: HumanReviewDetail;
  action: HumanReviewAction;
  onCancel: () => void;
}) {
  return (
    <form className="action-composer" action={submitHumanAnswer}>
      <ViewStateFields />
      <HumanAnswerFields
        target={detail}
        actionValue={action.value}
        popupKind={action.popupKind}
        actionLabel={action.display}
        noticeSubject={plainText(detail.titleHtml)}
      />
      <header>
        <div>
          <span>Complete action</span>
          <strong>{action.display}</strong>
        </div>
        <button
          className="composer-close"
          type="button"
          onClick={onCancel}
          aria-label="Close action"
        >
          <X aria-hidden="true" />
        </button>
      </header>
      <div className="composer-fields">
        <ActionResponseFields action={action} />
      </div>
      <footer>
        <button className="secondary-button" type="button" onClick={onCancel}>
          Cancel
        </button>
        <SubmitButton
          className="action-button"
          icon={action.icon}
          label={`Submit ${action.display}`}
        />
      </footer>
    </form>
  );
}

export function UndoAnswerForm({ detail }: { detail: HumanReviewDetail }) {
  if (!detail.output) {
    return null;
  }

  if (!detail.output.undoEligible) {
    return (
      <button className="secondary-button" type="button" disabled>
        <span>Undo unavailable after caller read</span>
      </button>
    );
  }

  return (
    <form action={undoHumanAnswer}>
      <ViewStateFields />
      <input type="hidden" name="inputItemId" value={detail.inputItemId} />
      <input type="hidden" name="callerId" value={detail.caller.callerId} />
      <input
        type="hidden"
        name="outputResultId"
        value={detail.output.outputResultId}
      />
      <SubmitButton className="secondary-button" label="Undo answer" />
    </form>
  );
}

export function UndoNoticeForm({
  inputItemId,
  callerId,
  outputResultId
}: {
  inputItemId: string;
  callerId: string;
  outputResultId: string;
}) {
  return (
    <form className="notice-undo-form" action={undoHumanAnswer}>
      <ViewStateFields />
      <input type="hidden" name="inputItemId" value={inputItemId} />
      <input type="hidden" name="callerId" value={callerId} />
      <input type="hidden" name="outputResultId" value={outputResultId} />
      <SubmitButton className="notice-undo-button" label="Undo" />
    </form>
  );
}

function ActionResponseFields({ action }: { action: HumanReviewAction }) {
  switch (action.popupKind) {
    case "none":
      return null;
    case "free_text":
      return <FreeTextFields action={action} />;
    case "single_select":
      return <SingleSelectFields action={action} />;
    case "multi_select":
      return <MultiSelectFields action={action} />;
    case "date_picker":
      return <DatePickerFields action={action} />;
    case "file_upload":
      return <FileUploadFields action={action} />;
  }
}

function HumanAnswerFields({
  target,
  actionValue,
  popupKind,
  actionLabel,
  noticeSubject,
  returnToQueue = false
}: {
  target: Pick<HumanReviewDetail, "inputItemId" | "caller" | "currentRevision">;
  actionValue: string;
  popupKind: HumanReviewAction["popupKind"];
  actionLabel: string;
  noticeSubject: string;
  returnToQueue?: boolean;
}) {
  return (
    <>
      <input type="hidden" name="inputItemId" value={target.inputItemId} />
      <input type="hidden" name="callerId" value={target.caller.callerId} />
      <input
        type="hidden"
        name="expectedRevision"
        value={target.currentRevision}
      />
      <input type="hidden" name="actionValue" value={actionValue} />
      <input type="hidden" name="popupKind" value={popupKind} />
      <input type="hidden" name="noticeAction" value={actionLabel} />
      <input type="hidden" name="noticeSubject" value={noticeSubject} />
      {returnToQueue ? (
        <input type="hidden" name="returnToQueue" value="1" />
      ) : null}
    </>
  );
}

function FreeTextFields({ action }: { action: HumanReviewAction }) {
  const payload = recordValue(action.popupPayload);
  const multiline = payload.multiline === true;
  const props = {
    name: "response.text",
    placeholder: stringValue(payload.placeholder),
    defaultValue: stringValue(payload.default_value),
    minLength: numberOrUndefined(payload.min_length),
    maxLength: numberOrUndefined(payload.max_length),
    required: true
  };

  return (
    <label className="action-field">
      <span>{stringValue(payload.label) || "Response"}</span>
      {multiline ? <textarea {...props} rows={4} /> : <input {...props} />}
    </label>
  );
}

function SingleSelectFields({ action }: { action: HumanReviewAction }) {
  return (
    <fieldset className="choice-group">
      <legend>{popupLabel(action)}</legend>
      {action.options.map((option, index) => (
        <label key={option.value} className="choice-row">
          <input
            type="radio"
            name="response.value"
            value={option.value}
            required
            defaultChecked={index === 0}
          />
          <HumanIcon name={option.icon} />
          <span>{option.display}</span>
        </label>
      ))}
    </fieldset>
  );
}

function MultiSelectFields({ action }: { action: HumanReviewAction }) {
  return (
    <fieldset className="choice-group">
      <legend>{popupLabel(action)}</legend>
      {action.options.map((option) => (
        <label key={option.value} className="choice-row">
          <input type="checkbox" name="response.values" value={option.value} />
          <HumanIcon name={option.icon} />
          <span>{option.display}</span>
        </label>
      ))}
    </fieldset>
  );
}

function DatePickerFields({ action }: { action: HumanReviewAction }) {
  const payload = recordValue(action.popupPayload);
  const mode = payload.mode === "datetime" ? "datetime" : "date";
  const timezone = useDisplayTimezone(payload.display_timezone);

  return (
    <div className="date-fields">
      <input type="hidden" name="response.mode" value={mode} />
      <input type="hidden" name="response.display_timezone" value={timezone} />
      {mode === "date" ? (
        <label className="action-field">
          <span>{popupLabel(action)}</span>
          <input
            type="date"
            name="response.value_date"
            min={stringValue(payload.min_value)}
            max={stringValue(payload.max_value)}
            required
          />
        </label>
      ) : (
        <label className="action-field">
          <span>{popupLabel(action)}</span>
          <input type="datetime-local" name="response.value_local" required />
        </label>
      )}
      <p className="form-note">Displayed timezone: {timezone}</p>
    </div>
  );
}

function FileUploadFields({ action }: { action: HumanReviewAction }) {
  const payload = recordValue(action.popupPayload);
  const acceptMimeTypes = Array.isArray(payload.accept_mime_types)
    ? payload.accept_mime_types.filter(
        (value): value is string => typeof value === "string"
      )
    : [];

  return (
    <label className="action-field">
      <span>{popupLabel(action)}</span>
      <input
        type="file"
        name="response.file"
        accept={acceptMimeTypes.join(",")}
        required
      />
    </label>
  );
}

function SubmitButton({
  className,
  icon,
  label
}: {
  className: string;
  icon?: string | null;
  label: string;
}) {
  const status = useFormStatus();
  return (
    <button className={className} type="submit" disabled={status.pending}>
      {icon ? <HumanIcon name={icon} /> : null}
      <span>{status.pending ? "Submitting" : label}</span>
    </button>
  );
}

function useDisplayTimezone(configured: JsonValue | undefined) {
  const configuredTimezone = stringValue(configured);
  const [browserTimezone, setBrowserTimezone] = useState("UTC");
  useEffect(() => {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (timezone) {
      setBrowserTimezone(timezone);
    }
  }, []);
  return configuredTimezone || browserTimezone;
}

function popupLabel(action: HumanReviewAction) {
  return stringValue(recordValue(action.popupPayload).label) || action.display;
}

function recordValue(value: JsonValue): Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value
    : {};
}

function stringValue(value: JsonValue | undefined) {
  return typeof value === "string" ? value : "";
}

function plainText(html: string) {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function numberOrUndefined(value: JsonValue | undefined) {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}
