import Constants from 'expo-constants';

const extra = (Constants.expoConfig?.extra ?? {}) as Record<string, string | undefined>;

export const config = {
  apiUrl: extra.apiUrl ?? 'http://localhost:4000',
  authMode: (extra.authMode ?? 'cognito') as 'cognito' | 'dev',
  cognito: {
    userPoolId: extra.cognitoUserPoolId ?? '',
    clientId: extra.cognitoClientId ?? '',
  },
  easProjectId: (Constants.expoConfig?.extra?.eas as { projectId?: string } | undefined)?.projectId,
};

export const theme = {
  bg: '#07090f',
  surface: '#0d111a',
  surface2: '#151b28',
  border: 'rgba(255,255,255,0.08)',
  text: '#f1f5f9',
  muted: '#94a3b8',
  brand: '#4f46e5',
  brandLight: '#818cf8',
  live: '#e11d48',
  success: '#10b981',
  warning: '#f59e0b',
  danger: '#dc2626',
};
