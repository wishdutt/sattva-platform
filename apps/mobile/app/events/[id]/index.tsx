import { formatDuration, formatEventTime, type EventDto, type RecordingDto } from '@lsp/shared';
import { Stack, router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { Linking, ScrollView, Text, View } from 'react-native';
import { useAuth } from '../../../src/auth';
import { theme } from '../../../src/config';
import { Button, Card, ErrorText, StatusBadge, styles } from '../../../src/ui';

export default function EventDetails() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { api } = useAuth();
  const [event, setEvent] = useState<EventDto | null>(null);
  const [recordings, setRecordings] = useState<RecordingDto[]>([]);
  const [error, setError] = useState<string | null>(null);

  useFocusEffect(
    useCallback(() => {
      let active = true;
      const load = async () => {
        try {
          const e = await api.getEvent(id);
          if (!active) return;
          setEvent(e);
          if (e.status === 'ENDED' || e.recordingEnabled) setRecordings((await api.listRecordings(id)).items);
        } catch (err) {
          if (active) setError(err instanceof Error ? err.message : 'Event unavailable');
        }
      };
      void load();
      // Refresh while waiting so "Join" appears as soon as the host goes live.
      const t = setInterval(() => void load(), 15_000);
      return () => {
        active = false;
        clearInterval(t);
      };
    }, [api, id]),
  );

  if (error) {
    return (
      <View style={[styles.screen, { padding: 24 }]}>
        <ErrorText>{error}</ErrorText>
      </View>
    );
  }
  if (!event) return <View style={styles.screen} />;

  return (
    <ScrollView style={styles.screen} contentContainerStyle={{ padding: 20, gap: 16 }}>
      <Stack.Screen options={{ title: event.title }} />
      <StatusBadge status={event.status} />
      <Text style={styles.h1}>{event.title}</Text>
      <Text style={styles.body}>
        {formatEventTime(event.startAt)} · {event.durationMinutes} min
      </Text>
      {!!event.description && <Text style={[styles.body, { color: theme.text }]}>{event.description}</Text>}
      {event.recordingEnabled && (
        <Card>
          <Text style={{ color: theme.warning }}>This event may be recorded. You will see an indicator while recording is active.</Text>
        </Card>
      )}

      {event.status === 'LIVE' ? (
        <Button title="Join live event" variant="live" onPress={() => router.push(`/events/${event.id}/live`)} />
      ) : event.status === 'SCHEDULED' || event.status === 'READY' ? (
        <Card style={{ gap: 6 }}>
          <Text style={styles.h2}>Not live yet</Text>
          <Text style={styles.body}>This page refreshes automatically. You'll get a reminder before it starts.</Text>
        </Card>
      ) : (
        <Card>
          <Text style={styles.body}>This event has ended.</Text>
        </Card>
      )}

      {recordings.length > 0 && (
        <View style={{ gap: 10 }}>
          <Text style={styles.h2}>Recordings</Text>
          {recordings.map((r) => (
            <Card key={r.id} style={{ gap: 8 }}>
              <Text style={styles.body}>
                {formatEventTime(r.startedAt)}
                {r.durationSeconds != null ? ` · ${formatDuration(r.durationSeconds)}` : ''} · {r.status.toLowerCase()}
              </Text>
              {r.playbackUrl && (
                // Opens the short-lived private URL in the system player.
                <Button title="Watch replay" variant="secondary" onPress={() => void Linking.openURL(r.playbackUrl!)} />
              )}
            </Card>
          ))}
        </View>
      )}
    </ScrollView>
  );
}
