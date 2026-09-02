const LISTENER_KEY = "__agentOutboxImmediateActionFeedback";
const ACTION_SELECTOR = "[data-immediate-action-label]";
const FEEDBACK_SELECTOR = "[data-immediate-action-feedback]";

type ImmediateActionWindow = Window & { [LISTENER_KEY]?: boolean };
const queuedSubmitters = new WeakSet<HTMLElement>();

function showImmediateActionFeedback(source: HTMLElement) {
  const label = source.dataset.immediateActionLabel;
  if (!label) return false;

  const form =
    source instanceof HTMLButtonElement || source instanceof HTMLInputElement
      ? source.form
      : source instanceof HTMLFormElement
        ? source
        : null;
  if (form && !form.checkValidity()) return false;

  const feedback = source.querySelector<HTMLElement>(FEEDBACK_SELECTOR);
  if (feedback) feedback.textContent = label;
  return true;
}

function isSubmitter(
  source: HTMLElement
): source is HTMLButtonElement | HTMLInputElement {
  return (
    (source instanceof HTMLButtonElement ||
      source instanceof HTMLInputElement) &&
    source.type === "submit" &&
    source.form !== null
  );
}

function deferSubmit(source: HTMLElement, event: Event) {
  if (!isSubmitter(source)) return;
  if (queuedSubmitters.has(source)) {
    event.preventDefault();
    return;
  }
  const form = source.form;
  if (!form) return;
  queuedSubmitters.add(source);
  event.preventDefault();
  window.setTimeout(() => {
    try {
      form.requestSubmit(source);
    } finally {
      queuedSubmitters.delete(source);
    }
  }, 0);
}

export function installImmediateActionFeedback() {
  if (typeof window === "undefined") return;
  const immediateWindow = window as ImmediateActionWindow;
  if (immediateWindow[LISTENER_KEY]) return;
  immediateWindow[LISTENER_KEY] = true;
  window.addEventListener(
    "click",
    (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const source = target.closest<HTMLElement>(ACTION_SELECTOR);
      if (!source) return;
      if (!showImmediateActionFeedback(source)) return;
      if (!isSubmitter(source)) return;
      deferSubmit(source, event);
      // Keep React form actions and onClick off this click task so pending
      // labels stay in the native capture path.
      event.stopPropagation();
    },
    true
  );
  window.addEventListener(
    "submit",
    (event) => {
      const submitter = (event as SubmitEvent).submitter;
      if (submitter instanceof HTMLElement) {
        const nested = submitter.closest<HTMLElement>(ACTION_SELECTOR);
        if (nested) {
          showImmediateActionFeedback(nested);
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

installImmediateActionFeedback();
