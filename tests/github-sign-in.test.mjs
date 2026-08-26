import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import ts from "typescript";

const require = createRequire(import.meta.url);
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * @param {{
 *   pathname?: string,
 *   signIn: null | {
 *     reset: () => Promise<{ error: null | { message?: string } }>,
 *     sso: (input: Record<string, string>) => Promise<{ error: null | { message?: string } }>
 *   },
 *   clerkLoaded?: boolean,
 *   onEvent: (event: string) => void,
 *   timeoutMode?: "none" | "clerk" | "same-page"
 * }} input
 */
function loadGitHubSignInButton({
  pathname = "/sign-in",
  signIn,
  clerkLoaded = true,
  onEvent,
  timeoutMode = "none"
}) {
  const source = readFileSync(
    resolve(REPO_ROOT, "src/components/auth/GitHubSignInButton.tsx"),
    "utf8"
  );
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2024
    },
    fileName: "src/components/auth/GitHubSignInButton.tsx"
  }).outputText;
  const stateChanges = /** @type {unknown[]} */ ([]);
  let timerId = 0;
  const timers = new Map();
  /** @type {Map<string, () => void>} */
  const windowListeners = new Map();
  const windowStub = {
    location: { href: "https://app.agent-outbox.dev/sign-in" },
    /** @param {string} type @param {() => void} listener */
    addEventListener(type, listener) {
      windowListeners.set(type, listener);
    },
    /** @param {string} type */
    removeEventListener(type) {
      windowListeners.delete(type);
    },
    setInterval() {
      return ++timerId;
    },
    clearInterval() {},
    /** @param {() => void} callback @param {number} delay */
    setTimeout(callback, delay) {
      const id = ++timerId;
      timers.set(id, callback);
      if (
        (timeoutMode === "clerk" && delay === 10_000) ||
        (timeoutMode === "same-page" && delay === 3_000)
      ) {
        queueMicrotask(callback);
      }
      return id;
    },
    /** @param {number} id */
    clearTimeout(id) {
      timers.delete(id);
    }
  };
  const testModule = {
    exports: /** @type {Record<string, unknown>} */ ({})
  };

  vm.runInNewContext(
    compiled,
    {
      console,
      exports: testModule.exports,
      module: testModule,
      queueMicrotask,
      /** @param {string} specifier */
      require(specifier) {
        if (specifier === "@clerk/nextjs") {
          return {
            useClerk: () => ({ loaded: clerkLoaded }),
            useSignIn: () => ({
              signIn,
              fetchStatus: "idle",
              errors: []
            })
          };
        }
        if (specifier === "next/navigation") {
          return { usePathname: () => pathname };
        }
        if (specifier === "react") {
          return {
            /** @param {() => void} effect */
            useEffect(effect) {
              effect();
            },
            /** @param {unknown} initialValue */
            useRef(initialValue) {
              return { current: initialValue };
            },
            /** @param {unknown} initialValue */
            useState(initialValue) {
              return [
                initialValue,
                (/** @type {unknown} */ value) => stateChanges.push(value)
              ];
            }
          };
        }
        if (specifier === "../../client/client-events.ts") {
          return { emitClientEvent: onEvent };
        }
        return require(specifier);
      },
      window: windowStub
    },
    { filename: "src/components/auth/GitHubSignInButton.tsx" }
  );

  return {
    GitHubSignInButton:
      /** @type {() => import("react").ReactElement | null} */ (
        testModule.exports.GitHubSignInButton
      ),
    /** @param {string} type */
    dispatchWindowEvent(type) {
      windowListeners.get(type)?.();
    },
    stateChanges
  };
}

/** @param {() => import("react").ReactElement | null} Component */
async function clickGitHubButton(Component) {
  const section = Component();
  assert.ok(section);
  assert.equal(section.type, "section");
  const button = section.props.children[0];
  button.props.onClick();
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
}

test("GitHub sign-in resets abandoned Clerk state before provider launch", async () => {
  const calls = /** @type {unknown[]} */ ([]);
  const events = /** @type {unknown[]} */ ([]);
  const signIn = {
    async reset() {
      calls.push("reset");
      return { error: null };
    },
    async sso(/** @type {Record<string, string>} */ input) {
      calls.push({ sso: input });
      return { error: { message: "provider detail must stay private" } };
    }
  };
  const { GitHubSignInButton } = loadGitHubSignInButton({
    signIn,
    onEvent: (event) => events.push(event)
  });

  await clickGitHubButton(GitHubSignInButton);

  assert.equal(
    JSON.stringify(calls),
    JSON.stringify([
      "reset",
      {
        sso: {
          strategy: "oauth_github",
          redirectUrl: "/human",
          redirectCallbackUrl: "/sign-in/sso-callback"
        }
      }
    ])
  );
  assert.deepEqual(events, ["github_sign_in_clerk_error"]);
});

test("GitHub sign-in bounds a stuck Clerk call and resets before retry", async () => {
  const calls = /** @type {unknown[]} */ ([]);
  const events = /** @type {unknown[]} */ ([]);
  const signIn = {
    async reset() {
      calls.push("reset");
      return { error: null };
    },
    sso(/** @type {Record<string, string>} */ _input) {
      calls.push("sso");
      return new Promise(() => {});
    }
  };
  const { GitHubSignInButton } = loadGitHubSignInButton({
    signIn,
    onEvent: (event) => events.push(event),
    timeoutMode: "clerk"
  });

  await clickGitHubButton(GitHubSignInButton);

  assert.deepEqual(calls, ["reset", "sso", "reset"]);
  assert.deepEqual(events, ["github_sign_in_clerk_timeout"]);
});

test("GitHub sign-in reports a successful Clerk call that never navigates", async () => {
  const events = /** @type {unknown[]} */ ([]);
  const signIn = {
    async reset() {
      return { error: null };
    },
    async sso(/** @type {Record<string, string>} */ _input) {
      return { error: null };
    }
  };
  const { GitHubSignInButton } = loadGitHubSignInButton({
    signIn,
    onEvent: (event) => events.push(event),
    timeoutMode: "same-page"
  });

  await clickGitHubButton(GitHubSignInButton);

  assert.deepEqual(events, ["github_sign_in_same_page_stall"]);
});

test("GitHub sign-in reports Clerk readiness failures distinctly", async () => {
  const events = /** @type {unknown[]} */ ([]);
  const signIn = {
    async reset() {
      return { error: null };
    },
    async sso() {
      return { error: null };
    }
  };
  const { GitHubSignInButton } = loadGitHubSignInButton({
    signIn,
    clerkLoaded: false,
    onEvent: (event) => events.push(event)
  });

  const section = GitHubSignInButton();
  assert.ok(section);
  assert.equal(section.props.children[0].props.disabled, true);

  await clickGitHubButton(GitHubSignInButton);

  assert.deepEqual(events, ["github_sign_in_not_ready"]);
});

test("GitHub sign-in does not report a provider launch that navigates", async () => {
  const events = /** @type {unknown[]} */ ([]);
  let navigate = () => {};
  const signIn = {
    async reset() {
      return { error: null };
    },
    async sso() {
      navigate();
      return { error: null };
    }
  };
  const loaded = loadGitHubSignInButton({
    signIn,
    onEvent: (event) => events.push(event)
  });
  navigate = () => loaded.dispatchWindowEvent("beforeunload");

  await clickGitHubButton(loaded.GitHubSignInButton);

  assert.deepEqual(events, []);
});

test("GitHub sign-in silently recovers when a navigated page is restored", async () => {
  const events = /** @type {unknown[]} */ ([]);
  let navigate = () => {};
  const signIn = {
    async reset() {
      return { error: null };
    },
    async sso() {
      navigate();
      return { error: null };
    }
  };
  const loaded = loadGitHubSignInButton({
    signIn,
    onEvent: (event) => events.push(event)
  });
  navigate = () => loaded.dispatchWindowEvent("pagehide");

  await clickGitHubButton(loaded.GitHubSignInButton);
  loaded.dispatchWindowEvent("pageshow");

  assert.deepEqual(events, []);
  assert.ok(loaded.stateChanges.includes(false));
});

test("GitHub sign-in defers callback routes to Clerk's callback UI", () => {
  const { GitHubSignInButton } = loadGitHubSignInButton({
    pathname: "/sign-in/sso-callback",
    signIn: null,
    onEvent() {}
  });

  assert.equal(GitHubSignInButton(), null);
});
