import '../src/polyfills';
import * as Notifications from 'expo-notifications';
import { Stack, router } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AuthProvider, useAuth } from '../src/auth';
import { theme } from '../src/config';

void SplashScreen.preventAutoHideAsync();

function Root() {
  const { status } = useAuth();
  useEffect(() => {
    if (status !== 'loading') void SplashScreen.hideAsync();
  }, [status]);

  // Tapping an event reminder opens that event.
  useEffect(() => {
    const sub = Notifications.addNotificationResponseReceivedListener((response) => {
      const eventId = response.notification.request.content.data?.eventId;
      if (typeof eventId === 'string') router.push(`/events/${eventId}`);
    });
    return () => sub.remove();
  }, []);

  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: theme.bg },
        headerTintColor: theme.text,
        contentStyle: { backgroundColor: theme.bg },
        headerShadowVisible: false,
      }}
    >
      <Stack.Screen name="index" options={{ headerShown: false }} />
      <Stack.Screen name="login" options={{ headerShown: false }} />
      <Stack.Screen name="forgot-password" options={{ title: 'Reset password' }} />
      <Stack.Screen name="events/index" options={{ title: 'My events' }} />
      <Stack.Screen name="events/[id]/index" options={{ title: 'Event' }} />
      <Stack.Screen name="events/[id]/live" options={{ headerShown: false, gestureEnabled: false }} />
      <Stack.Screen name="profile" options={{ title: 'Profile & settings' }} />
    </Stack>
  );
}

export default function Layout() {
  return (
    <SafeAreaProvider>
      <AuthProvider>
        <StatusBar style="light" />
        <Root />
      </AuthProvider>
    </SafeAreaProvider>
  );
}
