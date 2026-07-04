import { isIP } from "node:net";

export const TRUSTED_CLIENT_IP_HEADER = "cf-connecting-ip";

export function trustedClientIpAddress(request: Request) {
  const candidate = request.headers.get(TRUSTED_CLIENT_IP_HEADER)?.trim();

  if (candidate && isIP(candidate)) {
    return candidate;
  }

  return null;
}
