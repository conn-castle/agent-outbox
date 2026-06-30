import { createHash, timingSafeEqual } from "node:crypto";

type CallerAuthResult =
  | { ok: true; callerId: "runtime-smoke-caller" }
  | {
      ok: false;
      status: 401 | 403;
      code:
        | "missing_authorization"
        | "invalid_authorization_scheme"
        | "invalid_bearer_token";
    };

function tokenDigest(value: string) {
  return createHash("sha256").update(value).digest();
}

export function validateCallerBearer(
  authorizationHeader: string | null,
  expectedToken: string
): CallerAuthResult {
  if (!authorizationHeader) {
    return {
      ok: false,
      status: 401,
      code: "missing_authorization"
    };
  }

  const [scheme, token, extra] = authorizationHeader.trim().split(/\s+/);
  if (scheme !== "Bearer" || !token || extra) {
    return {
      ok: false,
      status: 401,
      code: "invalid_authorization_scheme"
    };
  }

  const tokenMatches = timingSafeEqual(
    tokenDigest(token),
    tokenDigest(expectedToken)
  );
  if (!tokenMatches) {
    return {
      ok: false,
      status: 403,
      code: "invalid_bearer_token"
    };
  }

  return { ok: true, callerId: "runtime-smoke-caller" };
}
