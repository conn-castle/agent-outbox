import openapi from "../../../../docs/openapi.json";

export function GET() {
  return Response.json(openapi, {
    headers: {
      "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400",
      "Content-Disposition": 'inline; filename="agent-outbox-openapi.json"'
    }
  });
}
