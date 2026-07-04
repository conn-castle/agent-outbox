import { runtimeCanaryResponseBody } from "../../../../src/server/runtime-canary";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET(request: Request) {
  return NextResponse.json(
    runtimeCanaryResponseBody(request.url, request.headers.get("authorization"))
  );
}
