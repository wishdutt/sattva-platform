import { router } from 'expo-router';
import { Text, View } from 'react-native';
import { useAuth } from '../src/auth';
import { config, theme } from '../src/config';
import { Button, Card, styles } from '../src/ui';

export default function Profile() {
  const { me, signOut } = useAuth();
  return (
    <View style={[styles.screen, { padding: 20, gap: 16 }]}>
      <Card style={{ gap: 4 }}>
        <Text style={styles.h2}>{me?.displayName}</Text>
        <Text style={styles.body}>{me?.email}</Text>
        <Text style={{ color: theme.brandLight, marginTop: 6, fontWeight: '600' }}>{me?.platformRole.toLowerCase()}</Text>
      </Card>
      <Card style={{ gap: 6 }}>
        <Text style={styles.h2}>Notifications</Text>
        <Text style={styles.body}>
          Event reminders are sent about 15 minutes before an event. Manage permission in your device settings.
        </Text>
      </Card>
      <Card style={{ gap: 6 }}>
        <Text style={styles.h2}>About</Text>
        <Text style={styles.body}>API: {config.apiUrl}</Text>
      </Card>
      <Button
        title="Sign out"
        variant="secondary"
        onPress={async () => {
          await signOut();
          router.replace('/login');
        }}
      />
    </View>
  );
}
