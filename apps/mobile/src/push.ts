import type { ApiClient } from '@lsp/shared';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { config } from './config';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

/**
 * Asks for notification permission and registers the Expo push token with the API so the
 * backend "reminders" job can notify the user ~15 minutes before their events start.
 */
export async function registerForPush(api: ApiClient): Promise<void> {
  if (!Device.isDevice || !config.easProjectId) return; // simulators / unconfigured builds
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('events', {
      name: 'Event reminders',
      importance: Notifications.AndroidImportance.HIGH,
    });
  }
  let { status } = await Notifications.getPermissionsAsync();
  if (status !== 'granted') status = (await Notifications.requestPermissionsAsync()).status;
  if (status !== 'granted') return;
  const token = await Notifications.getExpoPushTokenAsync({ projectId: config.easProjectId });
  await api.registerDevice(token.data, Platform.OS === 'ios' ? 'ios' : 'android');
}
