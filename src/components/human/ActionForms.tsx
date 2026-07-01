"use client";

import { useEffect, useMemo, useState } from "react";
import { useFormStatus } from "react-dom";

import { submitHumanAnswer, undoHumanAnswer } from "../../../app/human/actions";
import type { JsonValue } from "../../server/human-answer.ts";
import type {
  HumanReviewAction,
  HumanReviewDetail
} from "../../server/human-review.ts";
import { HumanIcon } from "./TypedContent";

export function ActionForm({
  detail,
  action,
  variant
}: {
  detail: HumanReviewDetail;
  action: HumanReviewAction;
  variant: "primary" | "overflow";
}) {
  if (!action.answerable) {
    return (
      <button
        className={variant === "primary" ? "action-button" : "secondary-button"}
        type="button"
        disabled
      >
        <HumanIcon name={action.icon} />
        <span>{action.display}</span>
      </button>
    );
  }

  return (
    <form className="action-form" action={submitHumanAnswer}>
      <input type="hidden" name="inputItemId" value={detail.inputItemId} />
      <input type="hidden" name="callerId" value={detail.caller.callerId} />
      <input
        type="hidden"
        name="expectedRevision"
        value={detail.currentRevision}
      />
      <input type="hidden" name="actionValue" value={action.value} />
      <input type="hidden" name="popupKind" value={action.popupKind} />
      <ActionResponseFields action={action} />
      <SubmitButton
        className={variant === "primary" ? "action-button" : "secondary-button"}
        icon={action.icon}
        label={action.display}
      />
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
  }
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
  const [localDateTime, setLocalDateTime] = useState("");
  const utcValue = useMemo(
    () =>
      mode === "datetime" && localDateTime
        ? zonedDateTimeToUtc(localDateTime, timezone)
        : "",
    [localDateTime, mode, timezone]
  );

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
        <>
          <label className="action-field">
            <span>{popupLabel(action)}</span>
            <input
              type="datetime-local"
              value={localDateTime}
              onChange={(event) => setLocalDateTime(event.target.value)}
              required
            />
          </label>
          <input type="hidden" name="response.value_utc" value={utcValue} />
        </>
      )}
      <p className="form-note">Displayed timezone: {timezone}</p>
    </div>
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

function zonedDateTimeToUtc(value: string, timezone: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) {
    return "";
  }

  const desired = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5])
  };
  const desiredUtc = Date.UTC(
    desired.year,
    desired.month - 1,
    desired.day,
    desired.hour,
    desired.minute
  );
  let instant = desiredUtc;

  for (let index = 0; index < 3; index += 1) {
    const parts = zonedParts(new Date(instant), timezone);
    const renderedUtc = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute
    );
    instant += desiredUtc - renderedUtc;
  }

  return new Date(instant).toISOString();
}

function zonedParts(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const part = (type: string) =>
    Number(parts.find((entry) => entry.type === type)?.value);
  return {
    year: part("year"),
    month: part("month"),
    day: part("day"),
    hour: part("hour"),
    minute: part("minute")
  };
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

function numberOrUndefined(value: JsonValue | undefined) {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}
