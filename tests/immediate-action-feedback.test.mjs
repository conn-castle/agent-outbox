import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import ts from "typescript";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_SCRIPT = resolve(REPO_ROOT, "public/immediate-action-feedback.js");
const TS_SOURCE = resolve(
  REPO_ROOT,
  "src/components/actions/immediate-action-feedback.ts"
);

/**
 * @param {"public" | "typescript"} source
 */
function installFeedback(source) {
  /** @type {(() => void)[]} */
  const macrotasks = [];
  /** @type {{ click: Array<(event: object) => void>, submit: Array<(event: object) => void> }} */
  const documentListeners = { click: [], submit: [] };
  /** @type {{ click: Array<(event: object) => void>, submit: Array<(event: object) => void> }} */
  const windowListeners = { click: [], submit: [] };

  class Element {
    constructor() {
      /** @type {Element | null} */
      this.parentElement = null;
      /** @type {Map<string, string>} */
      this.attributes = new Map();
      /** @type {Element | null} */
      this.feedback = null;
      this.textContent = "";
    }

    /** @param {string} name */
    getAttribute(name) {
      return this.attributes.get(name) ?? null;
    }

    /**
     * @param {string} name
     * @param {string} value
     */
    setAttribute(name, value) {
      this.attributes.set(name, value);
    }

    get dataset() {
      return {
        immediateActionLabel:
          this.getAttribute("data-immediate-action-label") ?? undefined
      };
    }

    /**
     * @param {string} selector
     * @returns {Element | null}
     */
    closest(selector) {
      if (
        selector === "[data-immediate-action-label]" &&
        this.getAttribute("data-immediate-action-label")
      ) {
        return this;
      }
      return this.parentElement?.closest(selector) ?? null;
    }

    /** @param {string} selector */
    querySelector(selector) {
      if (selector === "[data-immediate-action-feedback]") return this.feedback;
      return null;
    }
  }

  class HTMLElement extends Element {}
  class Text {
    constructor() {
      /** @type {Element | null} */
      this.parentElement = null;
    }
  }
  class HTMLButtonElement extends HTMLElement {
    constructor() {
      super();
      this.type = "submit";
      /** @type {HTMLFormElement | null} */
      this.form = null;
      /** @type {number} */
      this.clickCount = 0;
    }

    click() {
      this.clickCount += 1;
      dispatchClick(this);
    }
  }
  class HTMLInputElement extends HTMLElement {
    constructor() {
      super();
      this.type = "submit";
      /** @type {HTMLFormElement | null} */
      this.form = null;
    }
  }
  class HTMLFormElement extends HTMLElement {
    constructor() {
      super();
      /** @type {HTMLButtonElement[]} */
      this.requestSubmitCalls = [];
      /** @type {Error | null} */
      this.requestSubmitError = null;
    }

    checkValidity() {
      return true;
    }

    /** @param {HTMLButtonElement} submitter */
    requestSubmit(submitter) {
      if (this.requestSubmitError) throw this.requestSubmitError;
      this.requestSubmitCalls.push(submitter);
    }
  }

  const form = new HTMLFormElement();
  const button = new HTMLButtonElement();
  const feedback = new HTMLElement();
  feedback.textContent = "Send message";
  button.form = form;
  button.feedback = feedback;
  button.setAttribute("data-immediate-action-label", "Sending…");

  const document = {
    /**
     * @param {string} type
     * @param {(event: object) => void} listener
     * @param {boolean} capture
     */
    addEventListener(type, listener, capture) {
      if (capture !== true) return;
      if (type === "click" || type === "submit") {
        documentListeners[type].push(listener);
      }
    },
    querySelectorAll() {
      return [];
    }
  };

  const window = {
    /** @param {() => void} callback */
    setTimeout(callback) {
      macrotasks.push(callback);
      return macrotasks.length;
    },
    /**
     * @param {string} type
     * @param {(event: object) => void} listener
     * @param {boolean} capture
     */
    addEventListener(type, listener, capture) {
      if (capture !== true) return;
      if (type === "click" || type === "submit") {
        windowListeners[type].push(listener);
      }
    }
  };

  const sandbox = {
    window,
    document,
    Element,
    HTMLElement,
    Text,
    HTMLButtonElement,
    HTMLInputElement,
    HTMLFormElement,
    WeakSet,
    exports: {},
    module: { exports: {} }
  };

  if (source === "public") {
    vm.runInNewContext(readFileSync(PUBLIC_SCRIPT, "utf8"), sandbox, {
      filename: "public/immediate-action-feedback.js"
    });
  } else {
    const compiled = ts.transpileModule(readFileSync(TS_SOURCE, "utf8"), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2024
      },
      fileName: "src/components/actions/immediate-action-feedback.ts"
    }).outputText;
    vm.runInNewContext(compiled, sandbox, {
      filename: "src/components/actions/immediate-action-feedback.ts"
    });
  }

  /**
   * @param {HTMLButtonElement | Text} [target]
   */
  function dispatchClick(target = button) {
    const event = {
      target,
      defaultPrevented: false,
      propagationStopped: false,
      immediateStopped: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      stopPropagation() {
        this.propagationStopped = true;
      },
      stopImmediatePropagation() {
        this.propagationStopped = true;
        this.immediateStopped = true;
      }
    };
    for (const listener of windowListeners.click) {
      if (event.immediateStopped) break;
      listener(event);
    }
    if (!event.propagationStopped) {
      for (const listener of documentListeners.click) {
        if (event.immediateStopped) break;
        listener(event);
      }
    }
    return event;
  }

  function flush() {
    const queued = macrotasks.splice(0, macrotasks.length);
    for (const callback of queued) callback();
  }

  return {
    button,
    form,
    feedback,
    click: dispatchClick,
    flush,
    macrotasks,
    /**
     * @param {(event: object) => void} listener
     */
    addWindowClickListener(listener) {
      windowListeners.click.push(listener);
    },
    Text
  };
}

for (const source of /** @type {const} */ (["public", "typescript"])) {
  test(`${source} immediate-action feedback releases the submitter after requestSubmit`, () => {
    const { form, click, flush, macrotasks } = installFeedback(source);

    click();
    click();
    assert.equal(macrotasks.length, 1);
    assert.equal(form.requestSubmitCalls.length, 0);

    flush();
    assert.equal(form.requestSubmitCalls.length, 1);

    click();
    flush();
    assert.equal(form.requestSubmitCalls.length, 2);
  });

  test(`${source} immediate-action feedback releases the submitter if requestSubmit throws`, () => {
    const { form, click, flush } = installFeedback(source);
    form.requestSubmitError = new Error("requestSubmit failed");

    click();
    assert.throws(() => flush(), /requestSubmit failed/);
    assert.equal(form.requestSubmitCalls.length, 0);

    form.requestSubmitError = null;
    click();
    flush();
    assert.equal(form.requestSubmitCalls.length, 1);
  });

  test(`${source} immediate-action feedback defers labeled non-submit clicks`, () => {
    const { button, form, click, flush, macrotasks } = installFeedback(source);
    button.type = "button";

    click();
    assert.equal(macrotasks.length, 1);
    assert.equal(button.clickCount, 0);
    assert.equal(form.requestSubmitCalls.length, 0);

    flush();
    assert.equal(button.clickCount, 1);
    assert.equal(form.requestSubmitCalls.length, 0);

    click();
    flush();
    assert.equal(button.clickCount, 2);
  });

  test(`${source} immediate-action feedback does not suppress later window capture listeners`, () => {
    const { click, addWindowClickListener } = installFeedback(source);
    let extra = 0;
    addWindowClickListener(() => {
      extra += 1;
    });
    click();
    assert.equal(extra, 1);
  });

  test(`${source} immediate-action feedback resolves labeled clicks from a text node`, () => {
    const {
      button,
      form,
      click,
      flush,
      Text: TextNode
    } = installFeedback(source);
    const textNode = new TextNode();
    textNode.parentElement = button;
    click(textNode);
    flush();
    assert.equal(form.requestSubmitCalls.length, 1);
  });
}
