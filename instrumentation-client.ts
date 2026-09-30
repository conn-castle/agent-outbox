import posthog from "posthog-js";
import { sanitizeAnalyticsEvent } from "./src/client/posthog-privacy";

const POSTHOG_TOKEN = "phc_BHtwwAqkFjpvoWoJ2KwLTeRK9W9k5SWLw8ENhUZW2web";
const BROWSER_FIXTURE =
  process.env.AGENT_OUTBOX_COMPILED_BROWSER_FIXTURE === "1";

function fixtureCaptureEnabled() {
  return (
    BROWSER_FIXTURE &&
    new URLSearchParams(window.location.search).get(
      "__posthog_test_capture"
    ) === "1"
  );
}

const BROWSER_FIXTURE_CAPTURE = fixtureCaptureEnabled();

posthog.init(POSTHOG_TOKEN, {
  api_host: "/lantern",
  ui_host: "https://us.posthog.com",
  defaults: "2026-08-30",
  person_profiles: "identified_only",
  autocapture: true,
  capture_pageleave: true,
  capture_heatmaps: true,
  capture_performance: { web_vitals: true },
  disable_session_recording: true,
  disable_surveys: true,
  capture_dead_clicks: false,
  capture_exceptions: false,
  mask_all_text: true,
  mask_all_element_attributes: true,
  before_send: (event) => {
    const sanitized = sanitizeAnalyticsEvent(event, window.location.origin);
    return BROWSER_FIXTURE && !BROWSER_FIXTURE_CAPTURE ? null : sanitized;
  },
  // Flag evaluation bypasses before_send and includes unsanitized initial URLs.
  advanced_disable_flags: true,
  disable_external_dependency_loading: BROWSER_FIXTURE,
  opt_out_useragent_filter: BROWSER_FIXTURE_CAPTURE,
  request_batching: !BROWSER_FIXTURE_CAPTURE,
  loaded: (ph) => {
    const url = new URL(window.location.href);
    if (url.searchParams.get("owner") !== "1") return;

    ph.setInternalOrTestUser();
    ph.register({ is_owner: true });
    url.searchParams.delete("owner");
    window.history.replaceState(
      window.history.state,
      "",
      `${url.pathname}${url.search}${url.hash}`
    );
  }
});
