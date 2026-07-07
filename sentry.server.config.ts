import * as Sentry from "@sentry/nextjs";

import {
  sentryCaptureEnabled,
  sentryRuntimeInitOptions
} from "./src/server/sentry";

if (sentryCaptureEnabled()) {
  Sentry.init(sentryRuntimeInitOptions());
}
