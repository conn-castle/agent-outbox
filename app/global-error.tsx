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
      emitClientEvent("hydration_error", "hydration");
    } else {
      emitClientEvent("client_error", "browser_exception");
    }
  }, [error]);

  return (
    <html lang="en">
      <body>
        <main className="main">
          <section className="panel">
            <h1>Something went wrong</h1>
            <p>The application can be retried without resubmitting work.</p>
            <button className="action-button" type="button" onClick={reset}>
              Try again
            </button>
          </section>
        </main>
      </body>
    </html>
  );
}
