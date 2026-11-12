const ALLOWED_ORIGINS = [
  /^https:\/\/(?:[a-z0-9-]+\.)*amartuvshin\.com$/,
  /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d{1,5})?$/,
  /^(?:t3code|amaraa-mode)(?:-dev)?:\/\/app$/,
];

const isAllowedOrigin = (origin: string | undefined): origin is string =>
  origin !== undefined && ALLOWED_ORIGINS.some((pattern) => pattern.test(origin));

export const corsHeaders = (origin: string | undefined): Record<string, string> =>
  isAllowedOrigin(origin)
    ? {
        "access-control-allow-origin": origin,
        "access-control-expose-headers": "set-auth-token",
        vary: "origin",
      }
    : {};

export const corsPreflightHeaders = (origin: string | undefined): Record<string, string> =>
  isAllowedOrigin(origin)
    ? {
        ...corsHeaders(origin),
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "authorization, content-type",
        "access-control-max-age": "600",
      }
    : {};
