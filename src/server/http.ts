import { NextResponse } from "next/server";

import { validateCallerBearer } from "./caller-auth";

export function missingConfigurationResponse(missing: readonly string[]) {
  return NextResponse.json(
    {
      ok: false,
      code: "missing_configuration",
      missing
    },
    { status: 503 }
  );
}

export function smokeBearerFailureResponse(request: Request) {
  const token = process.env.SMOKE_OR_CLEANUP_TOKEN;
  if (!token) {
    return missingConfigurationResponse(["SMOKE_OR_CLEANUP_TOKEN"]);
  }

  const result = validateCallerBearer(
    request.headers.get("authorization"),
    token
  );
  if (result.ok) {
    return null;
  }

  return NextResponse.json(
    {
      ok: false,
      code: result.code
    },
    { status: result.status }
  );
}
