import {
  ApiError,
  isServerPacket,
  parseRoomData,
  type ChatMessageDto,
  type JoinTokenDto,
  type RoomDataMessage,
} from '@lsp/shared';
import { AndroidAudioTypePresets, AudioSession } from '@livekit/react-native';
import NetInfo from '@react-native-community/netinfo';
import { DisconnectReason, Room, RoomEvent, type RemoteParticipant } from 'livekit-client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { PermissionsAndroid, Platform } from 'react-native';
import { useAuth } from './auth';

export type SessionState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'error';
type Listener = (msg: RoomDataMessage) => void;

/** Mobile counterpart of the web session hook: token from API, audio session, reconnection. */
export function useLiveSession(eventId: string) {
  const { api } = useAuth();
  const [room] = useState(() => new Room({ adaptiveStream: { pixelDensity: 'screen' }, dynacast: true }));
  const [state, setState] = useState<SessionState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [join, setJoin] = useState<JoinTokenDto | null>(null);
  const listeners = useRef(new Set<Listener>());
  const leaving = useRef(false);
  const retries = useRef(0);

  const connect = useCallback(async () => {
    leaving.current = false;
    setState('connecting');
    setError(null);
    setErrorCode(null);
    try {
      const token = await api.joinToken(eventId);
      setJoin(token);
      // Viewers mostly listen: use media audio routed to the loudspeaker by default.
      await AudioSession.configureAudio({
        android: {
          preferredOutputList: ['bluetooth', 'headset', 'speaker'],
          audioTypeOptions: AndroidAudioTypePresets.media,
        },
        ios: { defaultOutput: 'speaker' },
      });
      await AudioSession.startAudioSession();
      await room.connect(token.serverUrl, token.token, { autoSubscribe: true });
      retries.current = 0;
      setState('connected');
    } catch (err) {
      setState('error');
      setError(err instanceof Error ? err.message : 'Could not connect');
      setErrorCode(err instanceof ApiError ? err.code : null);
    }
  }, [api, eventId, room]);

  const leave = useCallback(async () => {
    leaving.current = true;
    await room.disconnect();
    await AudioSession.stopAudioSession();
    setState('disconnected');
    await api.leave(eventId).catch(() => undefined);
  }, [api, eventId, room]);

  useEffect(() => {
    const onData = (payload: Uint8Array, participant?: RemoteParticipant) => {
      if (!isServerPacket(participant)) return;
      const msg = parseRoomData(payload);
      if (msg) listeners.current.forEach((l) => l(msg));
    };
    const onReconnecting = () => setState('reconnecting');
    const onReconnected = () => setState('connected');
    const onDisconnected = (reason?: DisconnectReason) => {
      if (leaving.current) return;
      if (
        reason === DisconnectReason.PARTICIPANT_REMOVED ||
        reason === DisconnectReason.ROOM_DELETED ||
        reason === DisconnectReason.DUPLICATE_IDENTITY
      ) {
        setState('disconnected');
        setErrorCode(DisconnectReason[reason]);
        return;
      }
      setState('reconnecting');
      const attempt = ++retries.current;
      if (attempt > 5) {
        setState('error');
        setError('Connection lost.');
        return;
      }
      setTimeout(() => void connect(), Math.min(1000 * 2 ** attempt, 15_000));
    };
    room.on(RoomEvent.DataReceived, onData);
    room.on(RoomEvent.Reconnecting, onReconnecting);
    room.on(RoomEvent.Reconnected, onReconnected);
    room.on(RoomEvent.Disconnected, onDisconnected);
    // When the network comes back after a full drop, rejoin with a fresh token.
    const unsubscribeNet = NetInfo.addEventListener((s) => {
      if (s.isConnected && room.state === 'disconnected' && !leaving.current && retries.current > 0) void connect();
    });
    return () => {
      room.off(RoomEvent.DataReceived, onData);
      room.off(RoomEvent.Reconnecting, onReconnecting);
      room.off(RoomEvent.Reconnected, onReconnected);
      room.off(RoomEvent.Disconnected, onDisconnected);
      unsubscribeNet();
    };
  }, [room, connect]);

  useEffect(
    () => () => {
      leaving.current = true;
      void room.disconnect();
      void AudioSession.stopAudioSession();
      void api.leave(eventId).catch(() => undefined);
    },
    [room, api, eventId],
  );

  const subscribe = useCallback((l: Listener) => {
    listeners.current.add(l);
    return () => {
      listeners.current.delete(l);
    };
  }, []);

  return { room, state, error, errorCode, join, connect, leave, subscribe };
}

export type LiveSession = ReturnType<typeof useLiveSession>;

export function useRoomMessages(session: LiveSession, handler: Listener) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => session.subscribe((m) => ref.current(m)), [session]);
}

export function useChat(session: LiveSession, eventId: string) {
  const { api } = useAuth();
  const [messages, setMessages] = useState<ChatMessageDto[]>([]);
  useEffect(() => {
    api
      .listChat(eventId)
      .then((r) => setMessages(r.items))
      .catch(() => undefined);
  }, [api, eventId]);
  const upsert = useCallback(
    (m: ChatMessageDto) => setMessages((l) => (l.some((x) => x.id === m.id) ? l : [...l.slice(-199), m])),
    [],
  );
  useRoomMessages(session, (msg) => {
    if (msg.type === 'chat') upsert(msg.message);
    if (msg.type === 'chat_deleted') setMessages((l) => l.map((m) => (m.id === msg.messageId ? { ...m, deleted: true, text: '' } : m)));
  });
  const send = useCallback(async (text: string) => upsert(await api.sendChat(eventId, text)), [api, eventId, upsert]);
  return { messages, send };
}

/** Requests OS permissions before enabling capture (Android needs an explicit runtime prompt). */
export async function ensureMediaPermission(kind: 'camera' | 'microphone'): Promise<boolean> {
  if (Platform.OS !== 'android') return true; // iOS prompts on first capture using Info.plist strings
  const perm = kind === 'camera' ? PermissionsAndroid.PERMISSIONS.CAMERA : PermissionsAndroid.PERMISSIONS.RECORD_AUDIO;
  const result = await PermissionsAndroid.request(perm);
  return result === PermissionsAndroid.RESULTS.GRANTED;
}
