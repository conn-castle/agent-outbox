"use client";

import { useEffect } from "react";

// global-error replaces the root layout (globals.css's only other importer),
// so the recovery page must load the stylesheet itself.
import "./globals.css";

import {
  classifyReactError,
  emitClientEvent
} from "../src/client/client-events.ts";

export default function GlobalError({
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
    <html lang="en">
      <body>
        <main className="error-main">
          <section className="error-card" aria-labelledby="error-title">
            <a
              className="error-wordmark product-wordmark"
              href="/"
              aria-label="Agent Outbox home"
            >
              <img src="/agent-outbox-mark.svg" alt="" width="44" height="44" />
              <span>
                Agent <b>Outbox</b>
              </span>
            </a>
            <p className="error-eyebrow">
              <span aria-hidden="true" /> Recovery page
            </p>
            <h1 id="error-title">Something went wrong</h1>
            <p>
              We couldn&apos;t load Agent Outbox. Try again now, or contact us
              if the problem continues.
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
      </body>
    </html>
  );
}
