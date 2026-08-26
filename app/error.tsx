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
      emitClientEvent("hydration_error");
    } else {
      emitClientEvent("client_error");
    }
  }, [error]);

  return (
    <main className="error-main">
      <section className="error-card" aria-labelledby="error-title">
        <p className="error-eyebrow">
          <span aria-hidden="true" /> Recovery page
        </p>
        <h1 id="error-title">Something went wrong</h1>
        <p>
          We couldn&apos;t load the review workspace. Trying again won&apos;t
          change any submitted work.
        </p>
        <div className="error-actions">
          <button className="button" type="button" onClick={reset}>
            Try again
          </button>
          <a className="button secondary" href="/contact">
            Contact us
          </a>
        </div>
      </section>
    </main>
  );
}
