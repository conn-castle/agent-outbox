"use client";

import { useClerk, useSignIn } from "@clerk/nextjs";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { emitClientEvent } from "../../client/client-events.ts";

const CLERK_CALL_TIMEOUT_MS = 10_000;
const SAME_PAGE_FAILURE_DELAY_MS = 3_000;
const ACTIVE_ATTEMPT_RECOVERY_MS = 15_000;
const NAVIGATION_POLL_INTERVAL_MS = 50;

class ClerkCallTimeoutError extends Error {
  constructor() {
    super("GitHub sign-in timed out.");
    this.name = "ClerkCallTimeoutError";
  }
}

type GitHubSignInFailure =
  | "github_sign_in_not_ready"
  | "github_sign_in_clerk_error"
  | "github_sign_in_clerk_timeout"
  | "github_sign_in_same_page_stall";

export function GitHubSignInButton() {
  const pathname = usePathname();
  const clerk = useClerk();
  const { signIn } = useSignIn();
  const [starting, setStarting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const activeAttemptRef = useRef(false);

  useEffect(() => {
    const recoverRestoredPage = () => {
      if (!activeAttemptRef.current) return;
      activeAttemptRef.current = false;
      setStarting(false);
      setMessage(null);
    };
    window.addEventListener("pageshow", recoverRestoredPage);
    return () => window.removeEventListener("pageshow", recoverRestoredPage);
  }, []);

  if (isSsoCallbackPath(pathname)) {
    return null;
  }

  const busy = starting || !clerk.loaded;

  async function startGitHubSignIn() {
    if (!clerk.loaded) {
      fail("github_sign_in_not_ready", setStarting, setMessage);
      return;
    }

    setMessage(null);
    setStarting(true);
    activeAttemptRef.current = true;
    const navigation = createNavigationMonitor();
    const recoveryTimeoutId = window.setTimeout(() => {
      if (!activeAttemptRef.current) return;
      activeAttemptRef.current = false;
      fail("github_sign_in_same_page_stall", setStarting, setMessage);
    }, ACTIVE_ATTEMPT_RECOVERY_MS);

    const failAttempt = (event: GitHubSignInFailure) => {
      activeAttemptRef.current = false;
      fail(event, setStarting, setMessage);
    };

    try {
      const reset = await signIn.reset();
      if (reset.error) {
        throw new Error("Clerk sign-in reset failed.");
      }

      const result = await withTimeout(
        signIn.sso({
          strategy: "oauth_github",
          redirectUrl: "/human",
          redirectCallbackUrl: "/sign-in/sso-callback"
        })
      );
      if (result.error) {
        failAttempt("github_sign_in_clerk_error");
        return;
      }

      if (await navigation.waitForSamePageFailure(SAME_PAGE_FAILURE_DELAY_MS)) {
        failAttempt("github_sign_in_same_page_stall");
      }
    } catch (error) {
      if (error instanceof ClerkCallTimeoutError) {
        // Promise.race cannot cancel Clerk's request. Reset its mutable local
        // attempt before enabling retry so a late settlement cannot poison the
        // next provider click.
        await signIn.reset().catch(() => undefined);
        failAttempt("github_sign_in_clerk_timeout");
      } else {
        failAttempt("github_sign_in_clerk_error");
      }
    } finally {
      navigation.cleanup();
      if (!activeAttemptRef.current) {
        window.clearTimeout(recoveryTimeoutId);
      }
    }
  }

  return (
    <section className="github-sign-in" aria-label="GitHub sign-in">
      <button
        className="github-sign-in-button"
        disabled={busy}
        onClick={() => void startGitHubSignIn()}
        type="button"
      >
        <GitHubMark />
        {busy ? "Opening GitHub…" : "Continue with GitHub"}
      </button>
      {message ? (
        <p className="github-sign-in-error" role="alert">
          {message}
        </p>
      ) : null}
      <div className="github-sign-in-divider" aria-hidden="true">
        <span>or</span>
      </div>
    </section>
  );
}

function fail(
  event: GitHubSignInFailure,
  setStarting: (value: boolean) => void,
  setMessage: (value: string | null) => void
) {
  emitClientEvent(event);
  setStarting(false);
  setMessage("Couldn’t start GitHub sign-in. Please try again.");
}

async function withTimeout<T>(operation: Promise<T>): Promise<T> {
  let timeoutId: number | null = null;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeoutId = window.setTimeout(
          () => reject(new ClerkCallTimeoutError()),
          CLERK_CALL_TIMEOUT_MS
        );
      })
    ]);
  } finally {
    if (timeoutId !== null) {
      window.clearTimeout(timeoutId);
    }
  }
}

function isSsoCallbackPath(pathname: string | null) {
  return (
    pathname === "/sign-in/sso-callback" ||
    pathname?.startsWith("/sign-in/sso-callback/") === true
  );
}

function createNavigationMonitor() {
  const startingHref = window.location.href;
  let navigated = false;
  let settled = false;
  let resolveWait: ((samePageFailure: boolean) => void) | null = null;
  let pollId: number | null = null;
  let timeoutId: number | null = null;

  const clearTimers = () => {
    if (pollId !== null) window.clearInterval(pollId);
    if (timeoutId !== null) window.clearTimeout(timeoutId);
    pollId = null;
    timeoutId = null;
  };
  const markNavigated = () => {
    navigated = true;
    if (resolveWait && !settled) {
      settled = true;
      clearTimers();
      resolveWait(false);
    }
  };
  const checkUrl = () => {
    if (window.location.href !== startingHref) markNavigated();
  };
  const cleanup = () => {
    clearTimers();
    window.removeEventListener("clerk:beforeunload", markNavigated);
    window.removeEventListener("pagehide", markNavigated);
    window.removeEventListener("beforeunload", markNavigated);
  };

  window.addEventListener("clerk:beforeunload", markNavigated);
  window.addEventListener("pagehide", markNavigated);
  window.addEventListener("beforeunload", markNavigated);

  return {
    waitForSamePageFailure(delayMs: number) {
      if (navigated || window.location.href !== startingHref) {
        return Promise.resolve(false);
      }
      return new Promise<boolean>((resolve) => {
        resolveWait = resolve;
        pollId = window.setInterval(checkUrl, NAVIGATION_POLL_INTERVAL_MS);
        timeoutId = window.setTimeout(() => {
          if (settled) return;
          checkUrl();
          settled = true;
          clearTimers();
          resolve(!navigated && window.location.href === startingHref);
        }, delayMs);
      });
    },
    cleanup
  };
}

function GitHubMark() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path
        fill="currentColor"
        d="M12 .7a11.3 11.3 0 0 0-3.6 22c.6.1.8-.2.8-.5v-2c-3.3.7-4-1.4-4-1.4-.5-1.4-1.3-1.8-1.3-1.8-1.1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 1.8 2.7 1.3 3.4 1 .1-.8.4-1.3.8-1.6-2.7-.3-5.5-1.3-5.5-5.9 0-1.3.5-2.4 1.2-3.2-.1-.3-.5-1.5.1-3.2 0 0 1-.3 3.3 1.2a11.5 11.5 0 0 1 6 0C17.5 5.3 18.5 5.6 18.5 5.6c.6 1.7.2 2.9.1 3.2.8.8 1.2 1.9 1.2 3.2 0 4.6-2.8 5.6-5.5 5.9.4.4.8 1.1.8 2.2v3.2c0 .3.2.6.8.5A11.3 11.3 0 0 0 12 .7Z"
      />
    </svg>
  );
}
