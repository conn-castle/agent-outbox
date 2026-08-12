type SecurityHeader = { key: string; value: string };

const BASE_SECURITY_HEADERS: readonly SecurityHeader[] = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=()"
  }
];

export function applicationSecurityHeaders(appEnv: string | undefined) {
  return [
    ...BASE_SECURITY_HEADERS,
    ...(appEnv === "production"
      ? [
          {
            key: "Strict-Transport-Security",
            value: "max-age=31536000"
          }
        ]
      : [])
  ];
}
