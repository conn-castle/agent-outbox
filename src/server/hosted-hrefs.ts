import { headers } from "next/headers";

import { hrefOnOrigin } from "../shared/hosted-origins.ts";

async function requestHost() {
  return (await headers()).get("host") ?? "";
}

export async function websiteHref(path: string) {
  return hrefOnOrigin("website", path, await requestHost());
}

export async function appHref(path: string) {
  return hrefOnOrigin("app", path, await requestHost());
}
