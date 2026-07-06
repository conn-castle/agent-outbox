import { withSentryConfig } from "@sentry/nextjs";
import type { NextConfig } from "next";

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

const sentryBuildEnabled =
  process.env.APP_ENV === "production" && process.env.CI !== "true";

const sentryConfig = {
  silent: true,
  sourcemaps: {
    disable: true
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
