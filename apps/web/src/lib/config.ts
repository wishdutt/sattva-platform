export const config = {
  apiUrl: process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000',
  authMode: (process.env.NEXT_PUBLIC_AUTH_MODE ?? 'cognito') as 'cognito' | 'oidc' | 'dev',
  cognito: {
    userPoolId: process.env.NEXT_PUBLIC_COGNITO_USER_POOL_ID ?? '',
    clientId: process.env.NEXT_PUBLIC_COGNITO_WEB_CLIENT_ID ?? '',
  },
  oidc: {
    authority: process.env.NEXT_PUBLIC_OIDC_AUTHORITY ?? '',
    clientId: process.env.NEXT_PUBLIC_OIDC_CLIENT_ID ?? '',
    scope: process.env.NEXT_PUBLIC_OIDC_SCOPE ?? 'openid profile email',
    providerName: process.env.NEXT_PUBLIC_OIDC_PROVIDER_NAME ?? 'your organization account',
  },
};

/** True when the API is running with the mock LiveKit adapter (local development only). */
export const isMockLiveKit = (serverUrl: string) => serverUrl.includes('mock-livekit.invalid');
