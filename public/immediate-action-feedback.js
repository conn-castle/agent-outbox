(function () {
  if (window.__agentOutboxImmediateActionFeedback) return;
  window.__agentOutboxImmediateActionFeedback = true;
  var queuedSubmitters = new WeakSet();
  function show(source) {
    var label = source.getAttribute("data-immediate-action-label");
    if (!label) return false;
    var form = source.form || null;
    if (form && !form.checkValidity()) return false;
    var feedback = source.querySelector("[data-immediate-action-feedback]");
    if (feedback) feedback.textContent = label;
    return true;
  }
  function isSubmitter(source) {
    return (
      (source instanceof HTMLButtonElement ||
        source instanceof HTMLInputElement) &&
      source.type === "submit" &&
      source.form
    );
  }
  function deferSubmit(source, event) {
    if (!isSubmitter(source)) return;
    if (queuedSubmitters.has(source)) {
      event.preventDefault();
      return;
    }
    queuedSubmitters.add(source);
    event.preventDefault();
    var form = source.form;
    window.setTimeout(function () {
      try {
        form.requestSubmit(source);
      } finally {
        queuedSubmitters.delete(source);
      }
    }, 0);
  }
  document.addEventListener(
    "click",
    function (event) {
      var target = event.target;
      if (!(target instanceof Element)) return;
      var source = target.closest("[data-immediate-action-label]");
      if (!source) return;
      if (!show(source)) return;
      if (!isSubmitter(source)) return;
      deferSubmit(source, event);
      // Keep React form actions and onClick off this click task so pending
      // labels stay in the native capture path.
      event.stopPropagation();
    },
    true
  );
  document.addEventListener(
    "submit",
    function (event) {
      var submitter = event.submitter;
      if (submitter instanceof HTMLElement) {
        var nested = submitter.closest("[data-immediate-action-label]");
        if (nested) {
          show(nested);
          return;
        }
      }
      var form = event.target;
      if (!(form instanceof HTMLFormElement)) return;
      var candidates = document.querySelectorAll(
        "[data-immediate-action-label]"
      );
      for (var i = 0; i < candidates.length; i++) {
        var candidate = candidates[i];
        if (
          (candidate instanceof HTMLButtonElement ||
            candidate instanceof HTMLInputElement) &&
          candidate.form === form
        ) {
          show(candidate);
          return;
        }
      }
    },
    true
  );
})();
