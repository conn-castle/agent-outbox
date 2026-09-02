"use client";

import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type MouseEventHandler
} from "react";
import { useFormStatus } from "react-dom";
import { useSearchParams } from "next/navigation";
import { X } from "lucide-react";

import { submitHumanAnswer, undoHumanAnswer } from "../../../app/human/actions";
import type {
  HumanReviewAction,
  HumanReviewBulkAction,
  HumanReviewDetail,
  HumanReviewListRow
} from "../../server/human-review.ts";
import { HUMAN_REVIEW_VIEW_PARAM_KEYS } from "../../shared/human-review-view";
import type { HumanMutationOperation } from "../../shared/human-mutation";
import { HumanIcon } from "./TypedContent";
import { actionAppearanceClass } from "./action-appearance";

export type HumanMutationSubmission = {
  operation: HumanMutationOperation;
  inputItemIds: string[];
  formData: FormData;
};

export type OnHumanMutation = (submission: HumanMutationSubmission) => void;

const submittedHumanMutationForms = new WeakSet<HTMLFormElement>();

export function humanMutationFormProps(
  operation: HumanMutationOperation,
  inputItemIds: string[],
  onMutation: OnHumanMutation
) {
  return {
    onSubmit: (event: FormEvent<HTMLFormElement>) => {
      submitHumanMutationForm(
        event.currentTarget,
        operation,
        inputItemIds,
        onMutation,
        event
      );
    }
  };
}

function humanMutationButtonProps(
  operation: HumanMutationOperation,
  inputItemIds: string[],
  onMutation: OnHumanMutation
) {
  return {
    onClick: ((event) => {
      submitHumanMutationForm(
        event.currentTarget.form,
        operation,
        inputItemIds,
        onMutation,
        event
      );
    }) satisfies MouseEventHandler<HTMLButtonElement>
  };
}

function submitHumanMutationForm(
  form: HTMLFormElement | null,
  operation: HumanMutationOperation,
  inputItemIds: string[],
  onMutation: OnHumanMutation,
  event: { preventDefault: () => void; stopPropagation?: () => void }
) {
  const workspace = form?.closest<HTMLElement>(".human-workspace");
  if (
    !form ||
    workspace?.dataset.workspaceHydrated !== "true" ||
    !form.checkValidity()
  ) {
    return;
  }
  event.preventDefault();
  event.stopPropagation?.();
  if (submittedHumanMutationForms.has(form)) {
    return;
  }
  submittedHumanMutationForms.add(form);
  onMutation({
    operation,
    inputItemIds,
    formData: new FormData(form)
  });
}

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
  action,
  className,
  onMutation
}: {
  row: HumanReviewListRow;
  action: HumanReviewBulkAction;
  className?: string;
  onMutation: OnHumanMutation;
}) {
  return (
    <form
      className="inline-action-form"
      action={submitHumanAnswer}
      {...humanMutationFormProps("answer", [row.inputItemId], onMutation)}
    >
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
        className={
          className ?? actionAppearanceClass("inline-action-button", action)
        }
        icon={action.icon}
        label={action.display}
        {...humanMutationButtonProps("answer", [row.inputItemId], onMutation)}
      />
    </form>
  );
}

export function ActionTrigger({
  detail,
  action,
  variant,
  active,
  onActivate,
  onMutation
}: {
  detail: HumanReviewDetail;
  action: HumanReviewAction;
  variant: "primary" | "overflow";
  active: boolean;
  onActivate: () => void;
  onMutation: OnHumanMutation;
}) {
  const baseClass =
    variant === "primary" ? "action-button" : "secondary-button";
  const className = actionAppearanceClass(baseClass, action);
  if (!action.answerable) {
    return (
      <button
        className={className}
        type="button"
        title={action.display}
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
        className={`${className} action-trigger${active ? " active" : ""}`}
        type="button"
        title={action.display}
        aria-expanded={active}
        onClick={onActivate}
      >
        <HumanIcon name={action.icon} />
        <span>{action.display}</span>
      </button>
    );
  }

  return (
    <form
      className="action-form"
      action={submitHumanAnswer}
      {...humanMutationFormProps("answer", [detail.inputItemId], onMutation)}
    >
      <ViewStateFields />
      <HumanAnswerFields
        target={detail}
        actionValue={action.value}
        popupKind={action.popupKind}
        actionLabel={action.display}
        noticeSubject={plainText(detail.titleHtml)}
        returnToQueue
      />
      <SubmitButton
        className={className}
        icon={action.icon}
        label={action.display}
      />
    </form>
  );
}

export function ActionComposer({
  detail,
  action,
  onCancel,
  onMutation
}: {
  detail: HumanReviewDetail;
  action: HumanReviewAction;
  onCancel: () => void;
  onMutation: OnHumanMutation;
}) {
  const minimumSelection =
    action.popupKind === "multi_select"
      ? action.popupPayload.min_selected
      : null;
  const [responseValid, setResponseValid] = useState(
    minimumSelection === null || minimumSelection === 0
  );

  useEffect(() => {
    setResponseValid(minimumSelection === null || minimumSelection === 0);
  }, [action.value, minimumSelection]);

  return (
    <form
      className="action-composer"
      action={submitHumanAnswer}
      {...humanMutationFormProps("answer", [detail.inputItemId], onMutation)}
    >
      <ViewStateFields />
      <HumanAnswerFields
        target={detail}
        actionValue={action.value}
        popupKind={action.popupKind}
        actionLabel={action.display}
        noticeSubject={plainText(detail.titleHtml)}
        returnToQueue
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
        <ActionResponseFields
          action={action}
          onValidityChange={setResponseValid}
        />
      </div>
      <footer>
        <button className="secondary-button" type="button" onClick={onCancel}>
          Cancel
        </button>
        <SubmitButton
          className={actionAppearanceClass("action-button", action)}
          icon={action.icon}
          label={action.display}
          disabled={!responseValid}
        />
      </footer>
    </form>
  );
}

export function UndoAnswerForm({
  detail,
  onMutation
}: {
  detail: HumanReviewDetail;
  onMutation: OnHumanMutation;
}) {
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
    <form
      action={undoHumanAnswer}
      {...humanMutationFormProps("undo", [detail.inputItemId], onMutation)}
    >
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

function ActionResponseFields({
  action,
  onValidityChange
}: {
  action: HumanReviewAction;
  onValidityChange: (valid: boolean) => void;
}) {
  switch (action.popupKind) {
    case "none":
      return null;
    case "free_text":
      return <FreeTextFields action={action} />;
    case "single_select":
      return <SingleSelectFields action={action} />;
    case "multi_select":
      return (
        <MultiSelectFields
          action={action}
          onValidityChange={onValidityChange}
        />
      );
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

function FreeTextFields({
  action
}: {
  action: Extract<HumanReviewAction, { popupKind: "free_text" }>;
}) {
  const payload = action.popupPayload;
  const multiline = payload.multiline === true;
  const props = {
    name: "response.text",
    placeholder: payload.placeholder ?? undefined,
    defaultValue: payload.default_value ?? undefined,
    minLength: payload.min_length ?? undefined,
    maxLength: payload.max_length ?? undefined,
    required: (payload.min_length ?? 0) > 0
  };

  return (
    <label className="action-field">
      <span>{payload.label}</span>
      {multiline ? <textarea {...props} rows={4} /> : <input {...props} />}
    </label>
  );
}

function SingleSelectFields({
  action
}: {
  action: Extract<HumanReviewAction, { popupKind: "single_select" }>;
}) {
  return (
    <fieldset className="choice-group">
      <legend>{popupLabel(action)}</legend>
      {action.options.map((option) => (
        <label key={option.value} className="choice-row">
          <input
            type="radio"
            name="response.value"
            value={option.value}
            required
          />
          <HumanIcon name={option.icon} />
          <span>{option.display}</span>
        </label>
      ))}
    </fieldset>
  );
}

function MultiSelectFields({
  action,
  onValidityChange
}: {
  action: Extract<HumanReviewAction, { popupKind: "multi_select" }>;
  onValidityChange: (valid: boolean) => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const { min_selected: min, max_selected: max } = action.popupPayload;
  const guidance = selectionGuidance(min, max);

  useEffect(() => setSelected(new Set()), [action.value]);

  useEffect(() => {
    onValidityChange(selected.size >= min && selected.size <= max);
  }, [max, min, onValidityChange, selected]);

  return (
    <fieldset className="choice-group">
      <legend>{popupLabel(action)}</legend>
      <p className="form-note" aria-live="polite">
        {guidance} {selected.size} selected.
      </p>
      {action.options.map((option) => (
        <label key={option.value} className="choice-row">
          <input
            type="checkbox"
            name="response.values"
            value={option.value}
            checked={selected.has(option.value)}
            disabled={!selected.has(option.value) && selected.size >= max}
            onChange={(event) => {
              setSelected((current) => {
                const next = new Set(current);
                if (event.target.checked) next.add(option.value);
                else next.delete(option.value);
                return next;
              });
            }}
          />
          <HumanIcon name={option.icon} />
          <span>{option.display}</span>
        </label>
      ))}
    </fieldset>
  );
}

function DatePickerFields({
  action
}: {
  action: Extract<HumanReviewAction, { popupKind: "date_picker" }>;
}) {
  const payload = action.popupPayload;
  const mode = payload.mode;
  const timezone = useDisplayTimezone(payload.display_timezone);
  const helperId = useId();
  const helper = payload.placeholder;

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
            aria-describedby={helper ? helperId : undefined}
            required
          />
        </label>
      ) : (
        <label className="action-field">
          <span>{popupLabel(action)}</span>
          <input
            type="datetime-local"
            name="response.value_local"
            min={localDateTimeBound(payload.min_value, timezone)}
            max={localDateTimeBound(payload.max_value, timezone)}
            aria-describedby={helper ? helperId : undefined}
            required
          />
        </label>
      )}
      {helper ? (
        <p className="form-note" id={helperId}>
          {helper}
        </p>
      ) : null}
      <p className="form-note">Displayed timezone: {timezone}</p>
    </div>
  );
}

function FileUploadFields({
  action
}: {
  action: Extract<HumanReviewAction, { popupKind: "file_upload" }>;
}) {
  const payload = action.popupPayload;
  const acceptMimeTypes = payload.accept_mime_types ?? [];
  const inputRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function assignFile(file: File | null) {
    const input = inputRef.current;
    if (!input) return;
    const transfer = new DataTransfer();
    if (file) transfer.items.add(file);
    input.files = transfer.files;
    setFileName(file?.name ?? null);
    setError(null);
  }

  return (
    <div className={`action-field file-drop${dragging ? " dragging" : ""}`}>
      <label>
        <span>{popupLabel(action)}</span>
        <input
          ref={inputRef}
          type="file"
          name="response.file"
          accept={acceptMimeTypes.join(",")}
          required
          onChange={(event) => {
            const file = event.currentTarget.files?.[0] ?? null;
            setFileName(file?.name ?? null);
            setError(null);
          }}
        />
        <span
          className="file-drop-target"
          onDragEnter={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={(event) => {
            event.preventDefault();
            if (!event.currentTarget.contains(event.relatedTarget as Node)) {
              setDragging(false);
            }
          }}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            const file = event.dataTransfer.files[0];
            if (!file) return;
            if (fileMatchesAccept(file, acceptMimeTypes)) {
              assignFile(file);
              return;
            }
            setError("That file type is not accepted for this action.");
          }}
        >
          <strong>{fileName ?? "Drop a file here"}</strong>
          <span>
            {fileName
              ? "Drop a replacement or choose another"
              : "or choose one"}
          </span>
        </span>
      </label>
      {error ? (
        <p className="form-note file-drop-error" role="alert">
          {error}
        </p>
      ) : null}
      {fileName ? (
        <button
          className="secondary-button"
          type="button"
          onClick={() => assignFile(null)}
        >
          Remove file
        </button>
      ) : null}
    </div>
  );
}

function fileMatchesAccept(file: File, acceptMimeTypes: string[]) {
  if (acceptMimeTypes.length === 0) {
    return true;
  }
  return acceptMimeTypes.some((type) => {
    if (type.endsWith("/*")) {
      return file.type.startsWith(type.slice(0, -1));
    }
    if (type.startsWith(".")) {
      return file.name.toLowerCase().endsWith(type.toLowerCase());
    }
    return file.type === type;
  });
}

function SubmitButton({
  className,
  icon,
  label,
  disabled = false,
  onClick
}: {
  className: string;
  icon?: string | null;
  label: string;
  disabled?: boolean;
  onClick?: MouseEventHandler<HTMLButtonElement>;
}) {
  const status = useFormStatus();
  return (
    <button
      className={className}
      type="submit"
      title={label}
      disabled={disabled || status.pending}
      onClick={onClick}
    >
      {icon ? <HumanIcon name={icon} /> : null}
      <span>{label}</span>
    </button>
  );
}

function useDisplayTimezone(configured: string | null) {
  const [browserTimezone, setBrowserTimezone] = useState("UTC");
  useEffect(() => {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (timezone) {
      setBrowserTimezone(timezone);
    }
  }, []);
  return configured || browserTimezone;
}

function popupLabel(action: HumanReviewAction) {
  return action.popupKind === "none"
    ? action.display
    : action.popupPayload.label || action.display;
}

function stringValue(value: string | null | undefined) {
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

function selectionGuidance(min: number, max: number) {
  if (min === max) return `Choose exactly ${min}.`;
  if (min === 0) return `Choose up to ${max}.`;
  return `Choose ${min} to ${max}.`;
}

function localDateTimeBound(value: string | null, timezone: string) {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((entry) => entry.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}`;
}
