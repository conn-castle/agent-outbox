import { smokeBearerFailureResponse } from "../../../../src/server/http";
import {
  RUNTIME_CRON_SCHEDULE,
  runScheduledCanary
} from "../../../../src/server/scheduled";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({
    ok: true,
    route_trigger_available: true,
    expected_cron_schedule: RUNTIME_CRON_SCHEDULE
  });
}

export async function POST(request: Request) {
  const authFailure = smokeBearerFailureResponse(request);
  if (authFailure) {
    return authFailure;
  }

  return NextResponse.json(
    runScheduledCanary({
      trigger: "route",
      cron: RUNTIME_CRON_SCHEDULE
    })
  );
}
