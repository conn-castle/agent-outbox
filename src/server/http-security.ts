type SecurityHeader = { key: string; value: string };

export function applicationSecurityHeaders(
  appEnv: string | undefined,
  allowFixtureFrames = false
): SecurityHeader[] {
  const fixtureFramesEnabled = appEnv === "test" && allowFixtureFrames;
  const headers: SecurityHeader[] = [
    { key: "X-Content-Type-Options", value: "nosniff" },
    {
      key: "X-Frame-Options",
      value: fixtureFramesEnabled ? "SAMEORIGIN" : "DENY"
    },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    {
      key: "Permissions-Policy",
      value: "camera=(), microphone=(), geolocation=()"
    },
    ...(appEnv === "production"
      ? [
          {
            key: "Strict-Transport-Security",
            value: "max-age=31536000"
          }
        ]
      : [])
  ];
  return headers;
}
