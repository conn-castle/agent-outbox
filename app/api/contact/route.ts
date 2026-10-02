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
  return handleContactRequest(request, async () => {
    const { env } = await getCloudflareContext({ async: true });
    const contactEnv = env as ContactCloudflareEnv;
    return {
      email: contactEnv.CONTACT_EMAIL,
      rateLimit: contactEnv.CONTACT_RATE_LIMIT
    };
  });
}
