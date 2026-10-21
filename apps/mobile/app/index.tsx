import { Redirect } from 'expo-router';
import { ActivityIndicator, Text, View } from 'react-native';
import { useAuth } from '../src/auth';
import { theme } from '../src/config';
import { styles } from '../src/ui';

/** Splash: shown while the persisted session is restored, then routes to login or events. */
export default function Splash() {
  const { status } = useAuth();
  if (status === 'signed_in') return <Redirect href="/events" />;
  if (status === 'signed_out') return <Redirect href="/login" />;
  return (
    <View style={[styles.screen, { alignItems: 'center', justifyContent: 'center', gap: 16 }]}>
      <View style={{ width: 64, height: 64, borderRadius: 18, backgroundColor: theme.brand, alignItems: 'center', justifyContent: 'center' }}>
        <View style={{ width: 22, height: 22, borderRadius: 11, backgroundColor: '#fff' }} />
      </View>
      <Text style={styles.h1}>Stagecast</Text>
      <ActivityIndicator color={theme.muted} />
    </View>
  );
}
