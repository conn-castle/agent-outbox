"use client";

import { useEffect } from "react";

import {
  classifyReactError,
  emitClientEvent
} from "../src/client/client-events.ts";

export default function ErrorBoundary({
  error,
  reset
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    if (classifyReactError(error) === "hydration") {
      emitClientEvent("hydration_error", "hydration");
    } else {
      emitClientEvent("client_error", "browser_exception");
    }
  }, [error]);

  return (
    <main className="main">
      <section className="panel">
        <h1>Something went wrong</h1>
        <p>
          The review workspace can be retried without changing submitted work.
        </p>
        <button className="action-button" type="button" onClick={reset}>
          Try again
        </button>
      </section>
    </main>
  );
}
