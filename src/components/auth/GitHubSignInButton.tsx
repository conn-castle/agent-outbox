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
  const attemptCountRef = useRef(0);
  const activeAttemptRef = useRef<number | null>(null);
  const recoveryTimeoutRef = useRef<number | null>(null);

  // Ends whichever attempt is currently active and disarms its recovery timer.
  // Only refs are touched, so the mount-time closure stays correct forever.
  const endActiveAttempt = () => {
    activeAttemptRef.current = null;
    if (recoveryTimeoutRef.current !== null) {
      window.clearTimeout(recoveryTimeoutRef.current);
      recoveryTimeoutRef.current = null;
    }
  };

  useEffect(() => {
    const recoverRestoredPage = () => {
      if (activeAttemptRef.current === null) return;
      endActiveAttempt();
      setStarting(false);
      setMessage(null);
    };
    window.addEventListener("pageshow", recoverRestoredPage);
    return () => {
      window.removeEventListener("pageshow", recoverRestoredPage);
      // Without this a client-side route change leaves the recovery timer armed
      // and it reports a stall for an attempt nobody can see any more.
      endActiveAttempt();
    };
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
    const attemptId = ++attemptCountRef.current;
    // Recovery, unmount and a retry all end an attempt while its Clerk promises
    // may still be pending, so every step re-checks that it still owns the flow.
    const ownsAttempt = () => activeAttemptRef.current === attemptId;
    endActiveAttempt();
    activeAttemptRef.current = attemptId;
    const navigation = createNavigationMonitor();

    const failAttempt = (event: GitHubSignInFailure) => {
      if (!ownsAttempt()) return;
      endActiveAttempt();
      fail(event, setStarting, setMessage);
    };

    try {
      const reset = await withTimeout(signIn.reset());
      if (!ownsAttempt()) return;
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
      if (!ownsAttempt()) return;
      if (result.error) {
        failAttempt("github_sign_in_clerk_error");
        return;
      }

      // Clerk took the launch, so the page is expected to leave and never come
      // back. Nothing bounds the attempt from here: waitForSamePageFailure
      // returns straight away once a navigation starts, and the attempt then
      // stays open on a page that may still be sitting there. Arming earlier
      // instead races the reset and sso deadlines, which already bound their
      // own calls, and reports their timeouts as stalls.
      recoveryTimeoutRef.current = window.setTimeout(() => {
        if (!ownsAttempt()) return;
        endActiveAttempt();
        fail("github_sign_in_same_page_stall", setStarting, setMessage);
      }, ACTIVE_ATTEMPT_RECOVERY_MS);

      if (await navigation.waitForSamePageFailure(SAME_PAGE_FAILURE_DELAY_MS)) {
        failAttempt("github_sign_in_same_page_stall");
      }
    } catch (error) {
      if (error instanceof ClerkCallTimeoutError) {
        // Promise.race cannot cancel Clerk's request. Reset its mutable local
        // attempt before enabling retry so a late settlement cannot poison the
        // next provider click. Bound that reset too: an unbounded one would keep
        // the button disabled for as long as Clerk stays stuck.
        await withTimeout(signIn.reset()).catch(() => undefined);
        failAttempt("github_sign_in_clerk_timeout");
      } else {
        failAttempt("github_sign_in_clerk_error");
      }
    } finally {
      navigation.cleanup();
    }
  }

  return (
    <section className="github-sign-in" aria-label="GitHub sign-in">
      <button
        className="github-sign-in-button"
        disabled={busy}
        onClick={() => void startGitHubSignIn()}
        type="button"
        data-immediate-action-label="Opening GitHub…"
      >
        <GitHubMark />
        <span data-immediate-action-feedback>
          {busy ? "Opening GitHub…" : "Continue with GitHub"}
        </span>
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
