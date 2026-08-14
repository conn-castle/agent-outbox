import { getCloudflareContext } from "@opennextjs/cloudflare";

import {
  type ContactEmailBinding,
  type ContactRateLimitBinding,
  handleContactRequest
} from "../../../src/server/contact";

export const runtime = "nodejs";

type ContactCloudflareEnv = CloudflareEnv & {
  CONTACT_EMAIL?: ContactEmailBinding;
  CONTACT_RATE_LIMIT?: ContactRateLimitBinding;
};

export async function POST(request: Request) {
  try {
    const { env } = await getCloudflareContext({ async: true });
    const contactEnv = env as ContactCloudflareEnv;
    if (!contactEnv.CONTACT_EMAIL || !contactEnv.CONTACT_RATE_LIMIT) {
      throw new Error("Contact bindings are not configured");
    }

    return handleContactRequest(request, {
      email: contactEnv.CONTACT_EMAIL,
      rateLimit: contactEnv.CONTACT_RATE_LIMIT
    });
  } catch {
    return Response.json(
      {
        ok: false,
        code: "send_failed",
        message: "Your message was not sent. Please try again shortly."
      },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    );
  }
}
