import type { RoomDataMessage } from './dto';

const decoder = new TextDecoder();

/**
 * Parses a data-channel payload published by the backend.
 * Callers must additionally check that the packet has no sender participant
 * (server-originated) before trusting it — see `isServerPacket`.
 */
export function parseRoomData(payload: Uint8Array): RoomDataMessage | null {
  try {
    const value = JSON.parse(decoder.decode(payload)) as { type?: unknown };
    if (!value || typeof value !== 'object' || typeof value.type !== 'string') return null;
    return value as RoomDataMessage;
  } catch {
    return null;
  }
}

/**
 * Data sent through the LiveKit server API has no participant attached.
 * Clients cannot publish data (canPublishData=false), so any packet with a
 * participant is ignored.
 */
export const isServerPacket = (participant: unknown) => participant === undefined || participant === null;
