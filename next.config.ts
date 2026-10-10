import type { NextConfig } from "next";

/**
 * Security headers on every response.
 *
 * - frame-ancestors / X-Frame-Options: no page may be framed by another site.
 *   Otherwise a page elsewhere can lay an invisible dashboard (or a patient's
 *   cancel button) under its own and have someone click through it.
 * - base-uri / form-action / object-src: a stray injected <base> or <form>
 *   cannot redirect links or submissions off-site, and no plugins load.
 *   A full script CSP is deliberately not here: it needs per-request nonces
 *   wired through every page, and getting it wrong breaks the app. These
 *   directives cannot break anything this app does.
 * - HSTS: browsers refuse plain HTTP for two years once they have seen it.
 *   Only takes effect over HTTPS, which production is.
 * - nosniff: a response is only ever treated as its declared type.
 * - Referrer-Policy: other sites see our origin, never a full URL. The patient
 *   queue link carries its credential in the path, so the path must not leak.
 * - Permissions-Policy: the camera for this site only (scanning a bed's QR code
 *   at the bedside, ADR-022); no microphone or location, which nothing here
 *   uses and nothing injected should get.
 */
const SECURITY_HEADERS = [
  {
    key: "Content-Security-Policy",
    value: "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'",
  },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(self), microphone=(), geolocation=()" },
];

const nextConfig: NextConfig = {
  output: "standalone",
  // Do not advertise the framework and version to anyone scanning for them.
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
  },
};

export default nextConfig;
