import path from 'node:path';
import type { NextConfig } from 'next';

const origin = (url: string | undefined) => (url ? new URL(url).origin : '');
const apiOrigin = origin(process.env.NEXT_PUBLIC_API_URL);
const livekitOrigin = process.env.NEXT_PUBLIC_LIVEKIT_WS_ORIGIN || 'wss://*.livekit.cloud';
const cognitoOrigins = 'https://cognito-idp.*.amazonaws.com https://*.amazoncognito.com';
// Non-AWS deployments: OIDC provider and S3-compatible storage (R2, MinIO…) origins.
const oidcOrigin = origin(process.env.NEXT_PUBLIC_OIDC_AUTHORITY);
const mediaOrigin = origin(process.env.NEXT_PUBLIC_MEDIA_ORIGIN) || 'https://*.amazonaws.com';
const isDev = process.env.NODE_ENV !== 'production';

// LiveKit Cloud uses wss for signaling and https for region discovery / TURN-over-TLS.
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ''}`,
  "style-src 'self' 'unsafe-inline'",
  `img-src 'self' data: blob: ${mediaOrigin} https://mock-storage.invalid`,
  `media-src 'self' blob: ${mediaOrigin}`,
  `connect-src 'self' ${apiOrigin} ${livekitOrigin} https://*.livekit.cloud ${cognitoOrigins} ${oidcOrigin} ${mediaOrigin} ${isDev ? 'ws://localhost:* http://localhost:*' : ''}`,
  // Silent OIDC token renewal runs in a hidden iframe on the provider's origin.
  `frame-src 'self' ${oidcOrigin}`,
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Docker image builds set NEXT_OUTPUT=standalone (self-contained server.js); Amplify/Vercel don't need it.
  ...(process.env.NEXT_OUTPUT === 'standalone'
    ? // `next build` runs with apps/web as cwd; trace from the monorepo root so workspace packages are included.
      { output: 'standalone' as const, outputFileTracingRoot: path.resolve(process.cwd(), '../..') }
    : {}),
  transpilePackages: ['@lsp/shared', '@lsp/ui'],
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: csp },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(self), microphone=(self), display-capture=(self), geolocation=()' },
          { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
        ],
      },
    ];
  },
};

export default nextConfig;
