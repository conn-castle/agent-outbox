import { postgresDriverImportProof } from "../../../../src/server/database";
import { runtimeConfigStatus } from "../../../../src/server/env";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET(request: Request) {
  return NextResponse.json({
    ok: true,
    code: "runtime_canary_ok",
    origin: new URL(request.url).origin,
    one_app_api_origin: true,
    runtime: "nextjs-opennext-cloudflare",
    environment: runtimeConfigStatus(),
    postgres_driver: postgresDriverImportProof(),
    out_of_scope: [
      "queue_lifecycle",
      "file_workflows",
      "billing_behavior",
      "cleanup_semantics",
      "steward_behavior"
    ]
  });
}
