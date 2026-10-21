import { REACTIONS, parseParticipantMetadata, type EventDto, type Reaction } from '@lsp/shared';
import {
  AndroidAudioTypePresets,
  AudioSession,
  RoomContext,
  VideoTrack,
  isTrackReference,
  useLocalParticipant,
  useLocalParticipantPermissions,
  useParticipants,
  useTracks,
} from '@livekit/react-native';
import { useKeepAwake } from 'expo-keep-awake';
import { router, useLocalSearchParams } from 'expo-router';
import { Track, type Participant } from 'livekit-client';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '../../../src/auth';
import { theme } from '../../../src/config';
import { ensureMediaPermission, useChat, useLiveSession, useRoomMessages, type LiveSession } from '../../../src/live';
import { Button, ErrorText, RoundButton, StatusBadge, styles } from '../../../src/ui';

const isOnStage = (p: Participant) => {
  const meta = parseParticipantMetadata(p.metadata);
  return !!meta && (meta.role !== 'VIEWER' || meta.speaker);
};
const isHost = (p: Participant) => {
  const role = parseParticipantMetadata(p.metadata)?.role;
  return role === 'ORGANIZER' || role === 'BROADCASTER';
};

export default function LiveScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { api } = useAuth();
  const [event, setEvent] = useState<EventDto | null>(null);
  const session = useLiveSession(id);
  useKeepAwake();

  useEffect(() => {
    api
      .getEvent(id)
      .then((e) => {
        setEvent(e);
        if (e.status === 'LIVE') void session.connect();
      })
      .catch(() => router.back());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, id]);

  useRoomMessages(session, (msg) => {
    if (!event) return;
    if (msg.type === 'event_status') setEvent({ ...event, status: msg.status });
    if (msg.type === 'recording') setEvent({ ...event, recordingActive: msg.active });
    if (msg.type === 'settings') setEvent({ ...event, chatEnabled: msg.chatEnabled });
  });

  if (!event || session.state === 'connecting' || session.state === 'idle') {
    return (
      <View style={[styles.screen, { alignItems: 'center', justifyContent: 'center', gap: 12 }]}>
        <ActivityIndicator color={theme.muted} />
        <Text style={styles.body}>Joining…</Text>
      </View>
    );
  }
  if (event.status === 'ENDED' || session.errorCode === 'ROOM_DELETED') {
    return (
      <SafeAreaView style={[styles.screen, { alignItems: 'center', justifyContent: 'center', gap: 16, padding: 24 }]}>
        <Text style={styles.h1}>Event ended</Text>
        <Text style={[styles.body, { textAlign: 'center' }]}>Thanks for joining {event.title}.</Text>
        <Button title="Back to event" onPress={() => router.replace(`/events/${event.id}`)} />
      </SafeAreaView>
    );
  }
  if (session.state === 'error' && !session.join) {
    return (
      <SafeAreaView style={[styles.screen, { justifyContent: 'center', gap: 16, padding: 24 }]}>
        <ErrorText>{session.errorCode === 'EVENT_FULL' ? 'This event is full right now.' : session.error}</ErrorText>
        <Button title="Try again" onPress={() => void session.connect()} />
        <Button title="Back" variant="secondary" onPress={() => router.back()} />
      </SafeAreaView>
    );
  }
  return (
    <RoomContext.Provider value={session.room}>
      <LiveRoom event={event} session={session} />
    </RoomContext.Provider>
  );
}

function Stage() {
  const tracks = useTracks(
    [
      { source: Track.Source.Camera, withPlaceholder: true },
      { source: Track.Source.ScreenShare, withPlaceholder: false },
    ],
    { onlySubscribed: false },
  );
  const onStage = tracks.filter((t) => isOnStage(t.participant));
  const screen = onStage.find((t) => t.source === Track.Source.ScreenShare && isTrackReference(t));
  const hostCam = onStage.find((t) => t.source === Track.Source.Camera && isHost(t.participant) && isTrackReference(t));
  const main = screen ?? hostCam;
  const others = onStage.filter((t) => t !== main && t.source === Track.Source.Camera && isTrackReference(t));

  return (
    <View style={{ flex: 1, backgroundColor: '#000' }}>
      {main && isTrackReference(main) ? (
        <VideoTrack trackRef={main} style={{ flex: 1 }} objectFit={screen ? 'contain' : 'cover'} />
      ) : (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <Text style={styles.body}>Waiting for the host's video…</Text>
        </View>
      )}
      {others.length > 0 && (
        <View style={{ position: 'absolute', right: 8, top: 8, gap: 8 }}>
          {others.slice(0, 4).map((t) =>
            isTrackReference(t) ? (
              <View key={t.participant.identity} style={{ width: 96, height: 128, borderRadius: 10, overflow: 'hidden', backgroundColor: theme.surface2 }}>
                <VideoTrack trackRef={t} style={{ flex: 1 }} objectFit="cover" />
              </View>
            ) : null,
          )}
        </View>
      )}
    </View>
  );
}

function FloatingReactions({ session }: { session: LiveSession }) {
  const [items, setItems] = useState<{ id: number; emoji: string; anim: Animated.Value; left: number }[]>([]);
  useRoomMessages(session, (msg) => {
    if (msg.type !== 'reaction') return;
    const anim = new Animated.Value(0);
    const id = Date.now() + Math.random();
    setItems((l) => [...l.slice(-15), { id, emoji: msg.emoji, anim, left: 10 + Math.random() * 70 }]);
    Animated.timing(anim, { toValue: 1, duration: 2400, useNativeDriver: true }).start(() =>
      setItems((l) => l.filter((x) => x.id !== id)),
    );
  });
  return (
    <View pointerEvents="none" style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 260 }}>
      {items.map((r) => (
        <Animated.Text
          key={r.id}
          style={{
            position: 'absolute',
            bottom: 0,
            left: `${r.left}%`,
            fontSize: 30,
            opacity: r.anim.interpolate({ inputRange: [0, 0.2, 1], outputRange: [0, 1, 0] }),
            transform: [{ translateY: r.anim.interpolate({ inputRange: [0, 1], outputRange: [0, -240] }) }],
          }}
        >
          {r.emoji}
        </Animated.Text>
      ))}
    </View>
  );
}

function LiveRoom({ event, session }: { event: EventDto; session: LiveSession }) {
  const { api } = useAuth();
  const { width, height } = useWindowDimensions();
  const landscape = width > height;
  const participants = useParticipants();
  const { localParticipant, isMicrophoneEnabled, isCameraEnabled } = useLocalParticipant();
  const permissions = useLocalParticipantPermissions();
  const canPublish = !!permissions?.canPublish;
  const [hand, setHand] = useState<'idle' | 'pending'>('idle');
  const [showChat, setShowChat] = useState(!landscape);
  const [text, setText] = useState('');
  const chat = useChat(session, event.id);
  const wasSpeaker = useRef(canPublish);

  // Speaker Mode is entered/exited only through server-side permission changes.
  useEffect(() => {
    if (canPublish && !wasSpeaker.current) {
      setHand('idle');
      Alert.alert("You're on stage", 'The host invited you to speak. Unmute when you are ready.');
      // Switch to a two-way communication profile (echo cancellation, voice routing) while on stage.
      void AudioSession.configureAudio({
        ios: { defaultOutput: 'speaker' },
        android: { preferredOutputList: ['bluetooth', 'headset', 'speaker'], audioTypeOptions: AndroidAudioTypePresets.communication },
      });
    }
    if (!canPublish && wasSpeaker.current) {
      void localParticipant.setMicrophoneEnabled(false).catch(() => undefined);
      void localParticipant.setCameraEnabled(false).catch(() => undefined);
    }
    wasSpeaker.current = canPublish;
  }, [canPublish, localParticipant]);

  useRoomMessages(session, (msg) => {
    if (msg.type === 'speaker_request_resolved' && msg.status === 'REJECTED') {
      setHand('idle');
      Alert.alert('Request declined', 'The host declined your request to speak.');
    }
  });

  async function toggleMic() {
    if (!isMicrophoneEnabled && !(await ensureMediaPermission('microphone'))) return;
    await localParticipant.setMicrophoneEnabled(!isMicrophoneEnabled);
  }
  async function toggleCam() {
    if (!isCameraEnabled && !(await ensureMediaPermission('camera'))) return;
    await localParticipant.setCameraEnabled(!isCameraEnabled);
  }
  async function toggleHand() {
    try {
      if (canPublish || hand === 'pending') {
        await api.lowerHand(event.id);
        setHand('idle');
      } else {
        await api.raiseHand(event.id);
        setHand('pending');
      }
    } catch (err) {
      Alert.alert('Could not update', err instanceof Error ? err.message : '');
    }
  }
  async function send() {
    if (!text.trim()) return;
    try {
      await chat.send(text);
      setText('');
    } catch (err) {
      Alert.alert('Message not sent', err instanceof Error ? err.message : '');
    }
  }
  async function react(emoji: Reaction) {
    await api.react(event.id, emoji).catch(() => undefined);
  }
  async function audioRoute() {
    if (Platform.OS === 'ios') await AudioSession.showAudioRoutePicker();
    else {
      const outputs = await AudioSession.getAudioOutputs();
      Alert.alert('Audio output', undefined, outputs.map((o) => ({ text: o, onPress: () => void AudioSession.selectAudioOutput(o) })));
    }
  }
  async function leave() {
    await session.leave();
    router.replace(`/events/${event.id}`);
  }

  const header = (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 10 }}>
      <StatusBadge status={event.status} />
      <Text style={[styles.h2, { flex: 1, fontSize: 16 }]} numberOfLines={1}>
        {event.title}
      </Text>
      {event.recordingActive && <Text style={{ color: '#fca5a5', fontWeight: '700', fontSize: 12 }}>● REC</Text>}
      <Text style={styles.body} accessibilityLabel={`${participants.length} participants`}>
        👥 {participants.length}
      </Text>
      {session.state === 'reconnecting' && <Text style={{ color: theme.warning, fontSize: 12 }}>Reconnecting…</Text>}
    </View>
  );

  const controls = (
    <View style={{ gap: 10, padding: 12 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'center', gap: 6 }}>
        {REACTIONS.slice(0, 6).map((r) => (
          <Pressable key={r} onPress={() => void react(r)} accessibilityLabel={`React ${r}`} style={{ padding: 6 }}>
            <Text style={{ fontSize: 24 }}>{r}</Text>
          </Pressable>
        ))}
      </View>
      <View style={{ flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 12 }}>
        {canPublish ? (
          <>
            <RoundButton label={isMicrophoneEnabled ? 'Mute' : 'Unmute'} icon={isMicrophoneEnabled ? '🎙️' : '🔇'} active={isMicrophoneEnabled} onPress={() => void toggleMic()} />
            <RoundButton label={isCameraEnabled ? 'Camera off' : 'Camera on'} icon={isCameraEnabled ? '📹' : '🚫'} active={isCameraEnabled} onPress={() => void toggleCam()} />
          </>
        ) : null}
        {event.maxSpeakers > 0 && (
          <RoundButton
            label={canPublish ? 'Leave stage' : hand === 'pending' ? 'Lower hand' : 'Raise hand'}
            icon={canPublish ? '⬇️' : '✋'}
            active={hand !== 'pending'}
            onPress={() => void toggleHand()}
          />
        )}
        <RoundButton label="Audio output" icon="🔊" onPress={() => void audioRoute()} />
        <RoundButton label={showChat ? 'Hide chat' : 'Show chat'} icon="💬" onPress={() => setShowChat((s) => !s)} />
        <RoundButton label="Leave event" icon="✕" active={false} onPress={() => void leave()} />
      </View>
      {canPublish && <Text style={{ color: theme.success, textAlign: 'center', fontWeight: '600' }}>Speaker mode — you're on stage</Text>}
    </View>
  );

  const chatPanel = showChat && (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: landscape ? undefined : 1, width: landscape ? 320 : undefined, backgroundColor: theme.surface }}>
      <FlatList
        data={chat.messages}
        keyExtractor={(m) => m.id}
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: 12, gap: 8 }}
        renderItem={({ item }) => (
          <Text style={{ color: theme.text }}>
            <Text style={{ fontWeight: '700' }}>{item.displayName} </Text>
            <Text style={{ color: item.deleted ? theme.muted : theme.text, fontStyle: item.deleted ? 'italic' : 'normal' }}>
              {item.deleted ? 'Message removed' : item.text}
            </Text>
          </Text>
        )}
      />
      <View style={{ flexDirection: 'row', gap: 8, padding: 10, borderTopWidth: 1, borderColor: theme.border }}>
        <TextInput
          value={text}
          onChangeText={setText}
          editable={event.chatEnabled}
          placeholder={event.chatEnabled ? 'Send a message' : 'Chat is turned off'}
          placeholderTextColor={theme.muted}
          maxLength={500}
          onSubmitEditing={() => void send()}
          returnKeyType="send"
          accessibilityLabel="Chat message"
          style={{ flex: 1, height: 42, borderRadius: 21, paddingHorizontal: 14, backgroundColor: theme.surface2, color: theme.text }}
        />
        <Button title="Send" onPress={() => void send()} disabled={!event.chatEnabled || !text.trim()} style={{ height: 42 }} />
      </View>
    </KeyboardAvoidingView>
  );

  if (landscape) {
    return (
      <View style={[styles.screen, { flexDirection: 'row' }]}>
        <View style={{ flex: 1 }}>
          <Stage />
          <FloatingReactions session={session} />
          <SafeAreaView edges={['bottom', 'left']} style={{ position: 'absolute', left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.45)' }}>
            {controls}
          </SafeAreaView>
        </View>
        {chatPanel}
      </View>
    );
  }
  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      {header}
      <View style={{ aspectRatio: 16 / 9, width: '100%' }}>
        <Stage />
        <FloatingReactions session={session} />
      </View>
      {controls}
      {chatPanel || <View style={{ flex: 1 }} />}
    </SafeAreaView>
  );
}
