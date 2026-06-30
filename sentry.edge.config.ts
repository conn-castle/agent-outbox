import * as Sentry from "@sentry/nextjs";

import { sentryCaptureEnabled } from "./src/server/sentry";

if (sentryCaptureEnabled()) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.APP_ENV,
    tracesSampleRate: 0.05
  });
}
