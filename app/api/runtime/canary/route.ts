import { runtimeCanaryResponseBody } from "../../../../src/server/runtime-canary";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const authorization = request.headers.get("authorization")?.trim() ?? null;

  return NextResponse.json(
    runtimeCanaryResponseBody(request.url, authorization)
  );
}
