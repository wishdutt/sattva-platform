'use client';

import {
  ApiError,
  isServerPacket,
  parseRoomData,
  type ChatMessageDto,
  type JoinTokenDto,
  type Reaction,
  type RoomDataMessage,
} from '@lsp/shared';
import { DisconnectReason, Room, RoomEvent, type RemoteParticipant } from 'livekit-client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from './auth';
import { isMockLiveKit } from './config';
import { errorMessage } from './hooks';

export type SessionState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'error';

type Listener = (msg: RoomDataMessage) => void;

/**
 * Owns one LiveKit Room for an event: obtains short-lived join tokens from the API,
 * connects, reconnects with a fresh token after unexpected disconnects, and fans out
 * server-originated data messages to subscribers.
 */
export function useLiveSession(eventId: string) {
  const { api } = useAuth();
  const [room] = useState(() => new Room({ adaptiveStream: true, dynacast: true, disconnectOnPageLeave: true }));
  const [state, setState] = useState<SessionState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [join, setJoin] = useState<JoinTokenDto | null>(null);
  const listeners = useRef(new Set<Listener>());
  const intentionalLeave = useRef(false);
  const retries = useRef(0);

  const connect = useCallback(async () => {
    intentionalLeave.current = false;
    setState('connecting');
    setError(null);
    setErrorCode(null);
    try {
      const token = await api.joinToken(eventId);
      setJoin(token);
      if (isMockLiveKit(token.serverUrl)) {
        throw new Error('The local API is running with mock LiveKit. Set LIVEKIT_URL/API_KEY/API_SECRET to stream media.');
      }
      await room.connect(token.serverUrl, token.token, { autoSubscribe: true });
      retries.current = 0;
      setState('connected');
    } catch (err) {
      setState('error');
      setError(errorMessage(err));
      setErrorCode(err instanceof ApiError ? err.code : null);
    }
  }, [api, eventId, room]);

  const leave = useCallback(async () => {
    intentionalLeave.current = true;
    await room.disconnect();
    setState('disconnected');
    await api.leave(eventId).catch(() => undefined);
  }, [api, eventId, room]);

  useEffect(() => {
    const onData = (payload: Uint8Array, participant?: RemoteParticipant) => {
      // Only trust packets sent by the server API (no sender participant).
      if (!isServerPacket(participant)) return;
      const msg = parseRoomData(payload);
      if (msg) listeners.current.forEach((l) => l(msg));
    };
    const onReconnecting = () => setState('reconnecting');
    const onReconnected = () => setState('connected');
    const onDisconnected = (reason?: DisconnectReason) => {
      if (intentionalLeave.current) return;
      const terminal =
        reason === DisconnectReason.PARTICIPANT_REMOVED ||
        reason === DisconnectReason.ROOM_DELETED ||
        reason === DisconnectReason.DUPLICATE_IDENTITY;
      if (terminal) {
        setState('disconnected');
        setErrorCode(DisconnectReason[reason]);
        return;
      }
      // Unexpected drop: back off and rejoin with a fresh, server-authorized token.
      setState('reconnecting');
      const attempt = ++retries.current;
      if (attempt > 5) {
        setState('error');
        setError('Connection lost. Check your network and rejoin.');
        return;
      }
      setTimeout(() => void connect(), Math.min(1000 * 2 ** attempt, 15_000));
    };
    room.on(RoomEvent.DataReceived, onData);
    room.on(RoomEvent.Reconnecting, onReconnecting);
    room.on(RoomEvent.Reconnected, onReconnected);
    room.on(RoomEvent.Disconnected, onDisconnected);
    return () => {
      room.off(RoomEvent.DataReceived, onData);
      room.off(RoomEvent.Reconnecting, onReconnecting);
      room.off(RoomEvent.Reconnected, onReconnected);
      room.off(RoomEvent.Disconnected, onDisconnected);
    };
  }, [room, connect]);

  // Leave cleanly when the component unmounts (frees the capacity slot immediately).
  useEffect(
    () => () => {
      intentionalLeave.current = true;
      void room.disconnect();
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

/** Chat history + live updates. Messages are sent through the API, which relays them to the room. */
export function useChat(session: LiveSession, eventId: string, enabled: boolean) {
  const { api } = useAuth();
  const [messages, setMessages] = useState<ChatMessageDto[]>([]);

  useEffect(() => {
    if (!enabled) return;
    api
      .listChat(eventId)
      .then((r) => setMessages(r.items))
      .catch(() => undefined);
  }, [api, eventId, enabled]);

  const upsert = useCallback((m: ChatMessageDto) => {
    setMessages((list) => (list.some((x) => x.id === m.id) ? list : [...list.slice(-199), m]));
  }, []);

  useRoomMessages(session, (msg) => {
    if (msg.type === 'chat') upsert(msg.message);
    if (msg.type === 'chat_deleted') {
      setMessages((list) => list.map((m) => (m.id === msg.messageId ? { ...m, deleted: true, text: '' } : m)));
    }
  });

  const send = useCallback(
    async (text: string) => {
      const m = await api.sendChat(eventId, text);
      upsert(m);
    },
    [api, eventId, upsert],
  );

  const remove = useCallback((messageId: string) => api.deleteChat(eventId, messageId), [api, eventId]);

  return { messages, send, remove };
}

export interface FloatingReaction {
  id: number;
  emoji: Reaction;
  left: number;
}

export function useReactions(session: LiveSession, eventId: string) {
  const { api, me } = useAuth();
  const [floating, setFloating] = useState<FloatingReaction[]>([]);
  const add = useCallback((emoji: Reaction) => {
    const id = Date.now() + Math.random();
    setFloating((f) => [...f.slice(-30), { id, emoji, left: 10 + Math.random() * 80 }]);
    setTimeout(() => setFloating((f) => f.filter((r) => r.id !== id)), 2700);
  }, []);
  useRoomMessages(session, (msg) => {
    // Our own reactions are shown optimistically when sent.
    if (msg.type === 'reaction' && msg.userId !== me?.userId) add(msg.emoji);
  });
  const react = useCallback(
    async (emoji: Reaction) => {
      add(emoji);
      await api.react(eventId, emoji).catch(() => undefined);
    },
    [api, eventId, add],
  );
  return { floating, react };
}
