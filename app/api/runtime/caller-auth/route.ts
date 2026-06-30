import { validateCallerBearer } from "../../../../src/server/caller-auth";
import { missingConfigurationResponse } from "../../../../src/server/http";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const token = process.env.SMOKE_OR_CLEANUP_TOKEN;
  if (!token) {
    return missingConfigurationResponse(["SMOKE_OR_CLEANUP_TOKEN"]);
  }

  const result = validateCallerBearer(
    request.headers.get("authorization"),
    token
  );
  if (!result.ok) {
    return NextResponse.json(
      {
        ok: false,
        code: result.code
      },
      { status: result.status }
    );
  }

  return NextResponse.json({
    ok: true,
    code: "caller_auth_accepted",
    caller_id: result.callerId
  });
}
