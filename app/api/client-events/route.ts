import { handleClientEventsRequest } from "../../../src/server/client-events";

export const runtime = "nodejs";

export async function POST(request: Request) {
  await handleClientEventsRequest(request);
  return new Response(null, { status: 204 });
}
