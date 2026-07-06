import { validateCallerBearer } from "./caller-auth.ts";
import { postgresDriverImportProof } from "./database.ts";
import { runtimeConfigStatus } from "./env.ts";

const RUNTIME_CANARY_OUT_OF_SCOPE = [
  "full_human_review_queue_ui",
  "caller_registration",
  "steward_behavior"
] as const;

export function runtimeCanaryResponseBody(
  requestUrl: string,
  authorization: string | null
) {
  const publicBody = {
    ok: true,
    code: "runtime_canary_ok",
    origin: new URL(requestUrl).origin,
    one_app_api_origin: true,
    runtime: "nextjs-opennext-cloudflare"
  };
  const token = process.env.SMOKE_OR_CLEANUP_TOKEN;
  if (!token) {
    return publicBody;
  }

  const bearer = validateCallerBearer(authorization, token);
  if (!bearer.ok) {
    return publicBody;
  }

  return {
    ...publicBody,
    environment: runtimeConfigStatus(),
    postgres_driver: postgresDriverImportProof(),
    out_of_scope: RUNTIME_CANARY_OUT_OF_SCOPE
  };
}
