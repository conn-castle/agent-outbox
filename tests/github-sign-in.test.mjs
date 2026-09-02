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
const CLERK_CALL_TIMEOUT_MS = 10_000;
const SAME_PAGE_FAILURE_DELAY_MS = 3_000;
const ACTIVE_ATTEMPT_RECOVERY_MS = 15_000;

/**
 * @param {{
 *   pathname?: string,
 *   signIn: null | {
 *     reset: () => Promise<{ error: null | { message?: string } }>,
 *     sso: (input: Record<string, string>) => Promise<{ error: null | { message?: string } }>
 *   },
 *   clerkLoaded?: boolean,
 *   onEvent: (event: string) => void
 * }} input
 */
function loadGitHubSignInButton({
  pathname = "/sign-in",
  signIn,
  clerkLoaded = true,
  onEvent
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
  let now = 0;
  /** @type {Map<number, { callback: () => void, dueAt: number }>} */
  const timers = new Map();
  /** @type {(() => void)[]} */
  const effectCleanups = [];
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
      timers.set(id, { callback, dueAt: now + delay });
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
            /** @param {() => void | (() => void)} effect */
            useEffect(effect) {
              const cleanup = effect();
              if (typeof cleanup === "function") effectCleanups.push(cleanup);
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
    /**
     * Moves a virtual clock forward to `target` milliseconds after mount,
     * running each timer that comes due in order and letting the promises it
     * unblocks settle before the next one. Timers armed along the way are due
     * relative to the moment they were armed, so delays accumulate the way they
     * do in a browser instead of collapsing by nominal duration.
     * @param {number} target
     */
    async advanceTo(target) {
      for (;;) {
        let dueId = /** @type {number | null} */ (null);
        let dueAt = Infinity;
        for (const [id, timer] of timers) {
          if (timer.dueAt > target || timer.dueAt >= dueAt) continue;
          dueId = id;
          dueAt = timer.dueAt;
        }
        if (dueId === null) break;
        const due = /** @type {{ callback: () => void, dueAt: number }} */ (
          timers.get(dueId)
        );
        timers.delete(dueId);
        now = due.dueAt;
        due.callback();
        await settle();
      }
      now = target;
    },
    unmount() {
      while (effectCleanups.length > 0) effectCleanups.pop()?.();
    },
    stateChanges
  };
}

function settle() {
  return new Promise((resolvePromise) => setImmediate(resolvePromise));
}

/** @param {() => import("react").ReactElement | null} Component */
async function clickGitHubButton(Component) {
  const section = Component();
  assert.ok(section);
  assert.equal(section.type, "section");
  const button = section.props.children[0];
  button.props.onClick();
  await settle();
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
  const loaded = loadGitHubSignInButton({
    signIn,
    onEvent: (event) => events.push(event)
  });

  await clickGitHubButton(loaded.GitHubSignInButton);
  await loaded.advanceTo(CLERK_CALL_TIMEOUT_MS);

  assert.deepEqual(calls, ["reset", "sso", "reset"]);
  assert.deepEqual(events, ["github_sign_in_clerk_timeout"]);
});

test("GitHub sign-in bounds a stuck Clerk reset instead of launching later", async () => {
  const calls = /** @type {unknown[]} */ ([]);
  const events = /** @type {unknown[]} */ ([]);
  let answerStuckReset = () => {};
  const signIn = {
    reset() {
      calls.push("reset");
      if (calls.length > 1) return Promise.resolve({ error: null });
      return new Promise((resolveReset) => {
        answerStuckReset = () => resolveReset({ error: null });
      });
    },
    async sso() {
      calls.push("sso");
      return { error: null };
    }
  };
  const loaded = loadGitHubSignInButton({
    signIn,
    onEvent: (event) => events.push(event)
  });

  await clickGitHubButton(loaded.GitHubSignInButton);
  await loaded.advanceTo(CLERK_CALL_TIMEOUT_MS);
  answerStuckReset();
  await settle();

  assert.deepEqual(calls, ["reset", "reset"]);
  assert.deepEqual(events, ["github_sign_in_clerk_timeout"]);
});

test("GitHub sign-in ignores an attempt abandoned before Clerk answers", async () => {
  const events = /** @type {unknown[]} */ ([]);
  let answerLaunch = () => {};
  const signIn = {
    async reset() {
      return { error: null };
    },
    sso() {
      return new Promise((resolveSso) => {
        answerLaunch = () => resolveSso({ error: { message: "too late" } });
      });
    }
  };
  const loaded = loadGitHubSignInButton({
    signIn,
    onEvent: (event) => events.push(event)
  });

  await clickGitHubButton(loaded.GitHubSignInButton);
  loaded.dispatchWindowEvent("pageshow");
  answerLaunch();
  await settle();

  assert.deepEqual(events, []);
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
  const loaded = loadGitHubSignInButton({
    signIn,
    onEvent: (event) => events.push(event)
  });

  await clickGitHubButton(loaded.GitHubSignInButton);
  await loaded.advanceTo(SAME_PAGE_FAILURE_DELAY_MS);

  assert.deepEqual(events, ["github_sign_in_same_page_stall"]);
});

/**
 * Clerk starts leaving the page, so the navigation monitor stands down, but the
 * page is still there. Only the recovery timer can close out this attempt.
 * @param {(event: string) => void} onEvent
 */
function loadLaunchThatLeavesButNeverLands(onEvent) {
  let navigate = () => {};
  const loaded = loadGitHubSignInButton({
    signIn: {
      async reset() {
        return { error: null };
      },
      async sso() {
        navigate();
        return { error: null };
      }
    },
    onEvent
  });
  navigate = () => loaded.dispatchWindowEvent("pagehide");
  return loaded;
}

test("GitHub sign-in reports a launch that leaves the page but never lands", async () => {
  const events = /** @type {unknown[]} */ ([]);
  const loaded = loadLaunchThatLeavesButNeverLands((event) =>
    events.push(event)
  );

  await clickGitHubButton(loaded.GitHubSignInButton);
  await loaded.advanceTo(ACTIVE_ATTEMPT_RECOVERY_MS);

  assert.deepEqual(events, ["github_sign_in_same_page_stall"]);
});

test("GitHub sign-in stops reporting stalls once the button unmounts", async () => {
  const events = /** @type {unknown[]} */ ([]);
  const loaded = loadLaunchThatLeavesButNeverLands((event) =>
    events.push(event)
  );

  await clickGitHubButton(loaded.GitHubSignInButton);
  loaded.unmount();
  await loaded.advanceTo(ACTIVE_ATTEMPT_RECOVERY_MS);

  assert.deepEqual(events, []);
});

test("GitHub sign-in reports a Clerk timeout the watchdog would outrun", async () => {
  const calls = /** @type {unknown[]} */ ([]);
  const events = /** @type {unknown[]} */ ([]);
  let resets = 0;
  const signIn = {
    reset() {
      calls.push("reset");
      resets += 1;
      // Clerk answers the opening reset, then stops answering, so the cleanup
      // reset runs its own full timeout after the launch has already timed out.
      return resets === 1
        ? Promise.resolve({ error: null })
        : new Promise(() => {});
    },
    sso() {
      calls.push("sso");
      return new Promise(() => {});
    }
  };
  const loaded = loadGitHubSignInButton({
    signIn,
    onEvent: (event) => events.push(event)
  });

  await clickGitHubButton(loaded.GitHubSignInButton);

  await loaded.advanceTo(CLERK_CALL_TIMEOUT_MS);
  assert.deepEqual(calls, ["reset", "sso", "reset"]);
  assert.deepEqual(events, []);

  // The recovery timer was armed at click time and comes due here, mid-cleanup.
  // It must not claim a stall for a launch that already timed out.
  await loaded.advanceTo(ACTIVE_ATTEMPT_RECOVERY_MS);
  assert.deepEqual(events, []);

  await loaded.advanceTo(CLERK_CALL_TIMEOUT_MS * 2);
  assert.deepEqual(events, ["github_sign_in_clerk_timeout"]);
});

test("GitHub sign-in reports a Clerk timeout a slow reset pushed past the watchdog", async () => {
  const calls = /** @type {unknown[]} */ ([]);
  const events = /** @type {unknown[]} */ ([]);
  let answerOpeningReset = () => {};
  let resets = 0;
  const signIn = {
    reset() {
      calls.push("reset");
      resets += 1;
      // The opening reset answers slowly but inside its own deadline, pushing
      // every later deadline out with it. The cleanup reset never answers.
      if (resets > 1) return new Promise(() => {});
      return new Promise((resolveReset) => {
        answerOpeningReset = () => resolveReset({ error: null });
      });
    },
    sso() {
      calls.push("sso");
      return new Promise(() => {});
    }
  };
  const loaded = loadGitHubSignInButton({
    signIn,
    onEvent: (event) => events.push(event)
  });

  await clickGitHubButton(loaded.GitHubSignInButton);

  await loaded.advanceTo(9_000);
  answerOpeningReset();
  await settle();
  assert.deepEqual(calls, ["reset", "sso"]);

  // The launch is still inside its own deadline, which now runs to 19s. Nothing
  // may report a stall here just because 15s of wall clock has passed.
  await loaded.advanceTo(ACTIVE_ATTEMPT_RECOVERY_MS);
  assert.deepEqual(events, []);

  await loaded.advanceTo(19_000);
  assert.deepEqual(calls, ["reset", "sso", "reset"]);
  assert.deepEqual(events, []);

  await loaded.advanceTo(29_000);
  assert.deepEqual(events, ["github_sign_in_clerk_timeout"]);
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

test("GitHub sign-in label is hydration-safe while Clerk initializes", () => {
  const unloaded = loadGitHubSignInButton({
    signIn: null,
    clerkLoaded: false,
    onEvent() {}
  });
  const unloadedLabel =
    unloaded.GitHubSignInButton()?.props.children[0].props.children[1];
  assert.equal(unloadedLabel?.props.suppressHydrationWarning, true);
  assert.equal(unloadedLabel?.props.children, "Opening GitHub…");

  const loaded = loadGitHubSignInButton({
    signIn: null,
    clerkLoaded: true,
    onEvent() {}
  });
  const loadedLabel =
    loaded.GitHubSignInButton()?.props.children[0].props.children[1];
  assert.equal(loadedLabel?.props.suppressHydrationWarning, true);
  assert.equal(loadedLabel?.props.children, "Continue with GitHub");
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
