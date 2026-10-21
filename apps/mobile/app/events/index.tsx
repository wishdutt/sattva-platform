import { formatEventTime, type EventDto } from '@lsp/shared';
import { Link, Redirect, Stack, router } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { FlatList, Pressable, RefreshControl, Text, View } from 'react-native';
import { useAuth } from '../../src/auth';
import { theme } from '../../src/config';
import { registerForPush } from '../../src/push';
import { Card, ErrorText, StatusBadge, styles } from '../../src/ui';

export default function MyEvents() {
  const { api, status } = useAuth();
  const [events, setEvents] = useState<EventDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(true);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const res = await api.listEvents();
      const rank = (e: EventDto) => (e.status === 'LIVE' ? 0 : e.status === 'READY' ? 1 : e.status === 'SCHEDULED' ? 2 : 3);
      setEvents(res.items.filter((e) => e.status !== 'CANCELLED').sort((a, b) => rank(a) - rank(b) || a.startAt.localeCompare(b.startAt)));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load events');
    } finally {
      setRefreshing(false);
    }
  }, [api]);

  useEffect(() => {
    if (status !== 'signed_in') return;
    void load();
    registerForPush(api).catch(() => undefined);
  }, [status, load, api]);

  if (status === 'signed_out') return <Redirect href="/login" />;

  return (
    <View style={styles.screen}>
      <Stack.Screen
        options={{
          headerRight: () => (
            <Link href="/profile" style={{ color: theme.brandLight, fontWeight: '600' }}>
              Profile
            </Link>
          ),
        }}
      />
      <FlatList
        data={events}
        keyExtractor={(e) => e.id}
        contentContainerStyle={{ padding: 16, gap: 12 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void load()} tintColor={theme.muted} />}
        ListHeaderComponent={error ? <ErrorText>{error}</ErrorText> : undefined}
        ListEmptyComponent={
          !refreshing ? (
            <Card style={{ alignItems: 'center', paddingVertical: 40, gap: 8 }}>
              <Text style={styles.h2}>No events yet</Text>
              <Text style={[styles.body, { textAlign: 'center' }]}>When an organizer invites you, the event appears here.</Text>
            </Card>
          ) : undefined
        }
        renderItem={({ item }) => (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${item.title}, ${item.status}`}
            onPress={() => router.push(`/events/${item.id}`)}
            style={({ pressed }) => ({ opacity: pressed ? 0.8 : 1 })}
          >
            <Card style={{ gap: 8 }}>
              <StatusBadge status={item.status} />
              <Text style={styles.h2} numberOfLines={2}>
                {item.title}
              </Text>
              <Text style={styles.body}>{formatEventTime(item.startAt)}</Text>
            </Card>
          </Pressable>
        )}
      />
    </View>
  );
}
