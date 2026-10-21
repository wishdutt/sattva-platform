import type { NextConfig } from 'next';

const apiOrigin = process.env.NEXT_PUBLIC_API_URL ? new URL(process.env.NEXT_PUBLIC_API_URL).origin : '';
const livekitOrigin = process.env.NEXT_PUBLIC_LIVEKIT_WS_ORIGIN ?? 'wss://*.livekit.cloud';
const cognitoOrigins = 'https://cognito-idp.*.amazonaws.com https://*.amazoncognito.com';
const isDev = process.env.NODE_ENV !== 'production';

// LiveKit Cloud uses wss for signaling and https for region discovery / TURN-over-TLS.
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ''}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://*.amazonaws.com https://mock-storage.invalid",
  "media-src 'self' blob: https://*.amazonaws.com",
  `connect-src 'self' ${apiOrigin} ${livekitOrigin} https://*.livekit.cloud ${cognitoOrigins} ${isDev ? 'ws://localhost:* http://localhost:*' : ''}`,
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

const nextConfig: NextConfig = {
  reactStrictMode: true,
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
