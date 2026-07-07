import { withSentryConfig } from "@sentry/nextjs";
import type { NextConfig } from "next";

import {
  runtimeRelease,
  sentryReleaseUploadConfig,
  sentryReleaseUploadEnabled
} from "./src/server/observability";

const sentryNextjsEdgeEntry =
  "./node_modules/@sentry/nextjs/build/esm/edge/index.js";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["127.0.0.1"],
  experimental: {
    serverActions: {
      bodySizeLimit: "34mb"
    }
  },
  outputFileTracingIncludes: {
    "/*": [
      "./node_modules/pg-cloudflare/dist/index.js",
      "./node_modules/pg-cloudflare/dist/index.js.map",
      "./node_modules/pg-cloudflare/esm/index.mjs"
    ]
  },
  reactStrictMode: true,
  poweredByHeader: false,
  turbopack: {
    // The app runs in Cloudflare workerd, so runtime Sentry imports should use
    // Sentry's own edge entry instead of bundling the Node server SDK graph.
    resolveAlias: {
      "@sentry/nextjs": sentryNextjsEdgeEntry
    },
    root: process.cwd()
  }
};

const sentryUploadConfig = sentryReleaseUploadConfig();
const sentryUploadEnabled = sentryReleaseUploadEnabled();
const sentryBuildEnabled =
  process.env.APP_ENV === "production" &&
  (process.env.CI !== "true" || sentryUploadEnabled);

const sentryConfig = {
  org: sentryUploadConfig?.org,
  project: sentryUploadConfig?.project,
  silent: true,
  release: {
    name: runtimeRelease() ?? undefined,
    create: sentryUploadEnabled,
    finalize: sentryUploadEnabled
  },
  sourcemaps: {
    disable: !sentryUploadEnabled,
    deleteSourcemapsAfterUpload: true
  },
  telemetry: false,
  webpack: {
    treeshake: {
      removeDebugLogging: true
    }
  }
};

export default sentryBuildEnabled
  ? withSentryConfig(nextConfig, sentryConfig)
  : nextConfig;
