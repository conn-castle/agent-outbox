"use client";

import { useEffect } from "react";

import {
  emitClientEvent,
  registerClientEventFlushListeners
} from "../../client/client-events.ts";
import { installImmediateActionFeedback } from "../actions/immediate-action-feedback";

installImmediateActionFeedback();

export function ClientEventsInit() {
  useEffect(() => {
    const onError = (event: Event) => {
      if (event instanceof ErrorEvent && event.error != null) {
        emitClientEvent("client_error");
      }
    };
    const onUnhandledRejection = () => {
      emitClientEvent("client_error");
    };

    window.addEventListener("error", onError, { capture: true });
    window.addEventListener("unhandledrejection", onUnhandledRejection, {
      capture: true
    });
    const unregisterFlush = registerClientEventFlushListeners(window);

    return () => {
      window.removeEventListener("error", onError, { capture: true });
      window.removeEventListener("unhandledrejection", onUnhandledRejection, {
        capture: true
      });
      unregisterFlush();
    };
  }, []);

  return null;
}
