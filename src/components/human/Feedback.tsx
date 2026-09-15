"use client";

import { MessageSquare } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

export function useFeedbackDrafts(accountId: string, userId: string) {
  const prefix = `agent-outbox:feedback:${accountId}:${userId}:`;
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const current = useRef(drafts);
  const activePrefix = useRef(prefix);

  useEffect(() => {
    activePrefix.current = prefix;
    current.current = {};
    setDrafts({});
    function load() {
      try {
        const next: Record<string, string> = {};
        for (let index = 0; index < localStorage.length; index++) {
          const key = localStorage.key(index);
          if (key?.startsWith(prefix)) {
            next[key.slice(prefix.length)] = localStorage.getItem(key) ?? "";
          }
        }
        current.current = next;
        setDrafts(next);
        setError(null);
      } catch {
        setError(
          "Feedback drafts could not be loaded from this browser. Check browser storage permissions."
        );
      }
    }
    load();
    function onStorage(event: StorageEvent) {
      if (event.key === null || event.key.startsWith(prefix)) load();
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [prefix]);

  function change(inputItemId: string, text: string) {
    if (activePrefix.current !== prefix) return false;
    const next = { ...current.current };
    if (text) next[inputItemId] = text;
    else delete next[inputItemId];
    try {
      if (text) localStorage.setItem(prefix + inputItemId, text);
      else localStorage.removeItem(prefix + inputItemId);
      current.current = next;
      setDrafts(next);
      setError(null);
      return true;
    } catch {
      setError(
        "Feedback changes could not be saved in this browser. Keep this page open to avoid losing your draft."
      );
      return false;
    }
  }

  function clearSubmitted(inputItemId: string, submitted: string) {
    if (activePrefix.current !== prefix) return;
    if (current.current[inputItemId] !== submitted) return;
    try {
      const stored = localStorage.getItem(prefix + inputItemId);
      // Another tab may have saved a newer draft before its storage event arrives.
      if (stored !== null && stored !== submitted) return;
    } catch {
      setError(
        "Your answer was sent, but its local feedback draft could not be cleared."
      );
      return;
    }
    change(inputItemId, "");
  }

  return {
    drafts: activePrefix.current === prefix ? drafts : {},
    change,
    clearSubmitted,
    error
  };
}

export function Feedback({
  value,
  onChange,
  error
}: {
  value: string;
  onChange: (text: string) => boolean;
  error: string | null;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const backdropPress = useRef(false);
  const [text, setText] = useState(value);
  const titleId = useId();
  const helpId = useId();
  const hasDraft = value.trim().length > 0;
  const label = hasDraft ? "Edit feedback" : "Add feedback";

  function outsideDialog(event: { clientX: number; clientY: number }) {
    const bounds = dialog.current?.getBoundingClientRect();
    return (
      !!bounds &&
      (event.clientX < bounds.left ||
        event.clientX > bounds.right ||
        event.clientY < bounds.top ||
        event.clientY > bounds.bottom)
    );
  }

  return (
    <>
      <button
        className={`feedback-button${hasDraft ? " has-feedback" : ""}`}
        type="button"
        title={label}
        aria-label={label}
        aria-haspopup="dialog"
        onClick={() => {
          setText(value);
          backdropPress.current = false;
          dialog.current?.showModal();
        }}
      >
        <MessageSquare aria-hidden="true" />
        {hasDraft ? <span className="feedback-dot" aria-hidden="true" /> : null}
      </button>
      <dialog
        ref={dialog}
        className="feedback-dialog"
        aria-labelledby={titleId}
        onCancel={(event) => event.stopPropagation()}
        onPointerDown={(event) => {
          event.stopPropagation();
          backdropPress.current = outsideDialog(event);
        }}
        onClick={(event) => {
          event.stopPropagation();
          if (backdropPress.current && outsideDialog(event))
            dialog.current?.close();
          backdropPress.current = false;
        }}
      >
        <div className="feedback-heading">
          <h2 id={titleId}>Feedback</h2>
        </div>
        <p id={helpId}>Save in this browser. Sent with your answer.</p>
        <textarea
          aria-label="Feedback"
          aria-describedby={helpId}
          autoFocus
          rows={5}
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
        {error ? <p role="alert">{error}</p> : null}
        <div className="feedback-actions">
          <button
            type="button"
            className="feedback-cancel"
            onClick={() => dialog.current?.close()}
          >
            Cancel
          </button>
          <button
            type="button"
            className="feedback-save"
            onClick={() => {
              if (onChange(text)) dialog.current?.close();
            }}
          >
            Save
          </button>
        </div>
      </dialog>
    </>
  );
}
