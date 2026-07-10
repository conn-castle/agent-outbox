import {
  defineCloudflareConfig,
  type OpenNextConfig
} from "@opennextjs/cloudflare";

const config: OpenNextConfig = defineCloudflareConfig({
  routePreloadingBehavior: "none"
});

config.buildCommand = "corepack pnpm run next:build";

export default config;
