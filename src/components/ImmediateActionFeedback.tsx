"use client";

const LISTENER_KEY = "__agentOutboxImmediateActionFeedback";
const ACTION_SELECTOR = "[data-immediate-action-label]";
const FEEDBACK_SELECTOR = "[data-immediate-action-feedback]";

type ImmediateActionWindow = Window & { [LISTENER_KEY]?: boolean };

function showImmediateActionFeedback(source: HTMLElement) {
  const label = source.dataset.immediateActionLabel;
  if (!label) return;

  const form =
    source instanceof HTMLButtonElement || source instanceof HTMLInputElement
      ? source.form
      : source instanceof HTMLFormElement
        ? source
        : null;
  if (form && !form.checkValidity()) return;

  const feedback = source.querySelector<HTMLElement>(FEEDBACK_SELECTOR);
  if (feedback) feedback.textContent = label;
}

if (typeof window !== "undefined") {
  const immediateWindow = window as ImmediateActionWindow;
  if (!immediateWindow[LISTENER_KEY]) {
    immediateWindow[LISTENER_KEY] = true;
    window.addEventListener(
      "click",
      (event) => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        const source = target.closest<HTMLElement>(ACTION_SELECTOR);
        if (source) showImmediateActionFeedback(source);
      },
      true
    );
    window.addEventListener(
      "submit",
      (event) => {
        const submitter = (event as SubmitEvent).submitter;
        if (submitter instanceof HTMLElement) {
          const source = submitter.closest<HTMLElement>(ACTION_SELECTOR);
          if (source) {
            showImmediateActionFeedback(source);
            return;
          }
        }
        const form = event.target;
        if (form instanceof HTMLFormElement) {
          const source = Array.from(
            document.querySelectorAll<HTMLElement>(ACTION_SELECTOR)
          ).find(
            (candidate) =>
              (candidate instanceof HTMLButtonElement ||
                candidate instanceof HTMLInputElement) &&
              candidate.form === form
          );
          if (source) showImmediateActionFeedback(source);
        }
      },
      true
    );
  }
}

export function ImmediateActionFeedback() {
  return null;
}
