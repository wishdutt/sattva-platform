import type { ConfigContext, ExpoConfig } from 'expo/config';

const bundleId = process.env.APP_BUNDLE_ID ?? 'com.example.stagecast';

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: 'Stagecast',
  slug: 'stagecast',
  scheme: 'stagecast',
  version: '0.1.0',
  orientation: 'default', // portrait + landscape for the live screen
  userInterfaceStyle: 'automatic',
  ios: {
    bundleIdentifier: bundleId,
    supportsTablet: true,
    infoPlist: {
      NSCameraUsageDescription: 'Your camera is used only when a host invites you on stage and you turn it on.',
      NSMicrophoneUsageDescription: 'Your microphone is used only when a host invites you on stage and you unmute.',
      // Keeps event audio playing when the app is backgrounded. Video does not play in the background.
      UIBackgroundModes: ['audio'],
    },
  },
  android: {
    package: bundleId,
    permissions: [
      'android.permission.CAMERA',
      'android.permission.RECORD_AUDIO',
      'android.permission.MODIFY_AUDIO_SETTINGS',
      'android.permission.BLUETOOTH_CONNECT',
      'android.permission.ACCESS_NETWORK_STATE',
      'android.permission.POST_NOTIFICATIONS',
    ],
  },
  plugins: [
    'expo-router',
    '@livekit/react-native-expo-plugin',
    [
      '@config-plugins/react-native-webrtc',
      {
        cameraPermission: 'Your camera is used only when a host invites you on stage and you turn it on.',
        microphonePermission: 'Your microphone is used only when a host invites you on stage and you unmute.',
      },
    ],
    ['expo-notifications', { color: '#4f46e5' }],
    ['expo-splash-screen', { backgroundColor: '#07090f', resizeMode: 'contain' }],
  ],
  experiments: { typedRoutes: false },
  extra: {
    apiUrl: process.env.EXPO_PUBLIC_API_URL,
    authMode: process.env.EXPO_PUBLIC_AUTH_MODE ?? 'cognito',
    cognitoUserPoolId: process.env.EXPO_PUBLIC_COGNITO_USER_POOL_ID,
    cognitoClientId: process.env.EXPO_PUBLIC_COGNITO_MOBILE_CLIENT_ID,
    eas: { projectId: process.env.EAS_PROJECT_ID },
  },
});
