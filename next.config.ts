import { withSentryConfig } from "@sentry/nextjs";
import type { NextConfig } from "next";

import {
  runtimeRelease,
  sentryReleaseUploadConfig,
  sentryReleaseUploadEnabled
} from "./src/server/observability";

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
