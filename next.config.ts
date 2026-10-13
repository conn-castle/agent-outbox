import { withSentryConfig } from "@sentry/nextjs/config";
import type { NextConfig } from "next";
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { browserBuildConfig } from "./scripts/browser-build-config";

import {
  runtimeRelease,
  sentryReleaseUploadConfig,
  sentryReleaseUploadEnabled
} from "./src/server/observability";
import { applicationSecurityHeaders } from "./src/server/http-security";
import { HUMAN_MUTATION_REQUEST_BODY_BYTE_LIMIT } from "./src/server/request-body";

const sentryNextjsEdgeEntry =
  "./node_modules/@sentry/nextjs/build/esm/edge/index.js";

// Pinned pnpm 11.25 writes JSON to .modules.yaml. Use its installed location,
// including native platform defaults, rather than expanding the project root.
const modulesManifest = JSON.parse(
  readFileSync(resolve("node_modules/.modules.yaml"), "utf8")
);
if (typeof modulesManifest.virtualStoreDir !== "string") {
  throw new Error("pnpm virtual store metadata is missing; run make setup.");
}
const virtualStoreRoot = realpathSync(
  resolve("node_modules", modulesManifest.virtualStoreDir)
);
const storeRelativeToProject = relative(process.cwd(), virtualStoreRoot);
const externalVirtualStore =
  storeRelativeToProject === ".." ||
  storeRelativeToProject.startsWith(`..${sep}`) ||
  isAbsolute(storeRelativeToProject);

const publicAppHostname = process.env.PUBLIC_APP_BASE_URL
  ? new URL(process.env.PUBLIC_APP_BASE_URL).hostname
  : null;

const nextConfig: NextConfig = {
  ...browserBuildConfig(),
  allowedDevOrigins: [
    "127.0.0.1",
    ...(publicAppHostname && publicAppHostname !== "127.0.0.1"
      ? [publicAppHostname]
      : [])
  ],
  devIndicators:
    process.env.AGENT_OUTBOX_BROWSER_FIXTURE === "1" ? false : undefined,
  experimental: {
    turbopackAdditionalRoots: externalVirtualStore
      ? { pnpm: { path: virtualStoreRoot } }
      : undefined,
    turbopackFileSystemCacheForDev: true,
    turbopackFileSystemCacheForBuild: true,
    turbopackSeedCacheFromWorktree: true,
    // Next's Node middleware copy otherwise truncates valid forms at 10 MiB.
    // Leave headroom so the route can detect overflow before the copy truncates.
    // Repository Node launchers guard unrelated ingress at 10 MiB before Next.
    // OpenNext's external middleware path does not use this Next body copy.
    proxyClientMaxBodySize:
      HUMAN_MUTATION_REQUEST_BODY_BYTE_LIMIT + 1024 * 1024,
    serverActions: {
      bodySizeLimit: "34mb"
    }
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: applicationSecurityHeaders(
          process.env.APP_ENV,
          process.env.AGENT_OUTBOX_BROWSER_FIXTURE === "1"
        )
      }
    ];
  },
  outputFileTracingIncludes: {
    "/*": [
      "./node_modules/pg-cloudflare/dist/index.js",
      "./node_modules/pg-cloudflare/dist/index.js.map",
      "./node_modules/pg-cloudflare/esm/index.mjs"
    ]
  },
  reactStrictMode: true,
  skipTrailingSlashRedirect: true,
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
