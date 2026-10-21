import type {
  EventStatus,
  InvitationStatus,
  MemberRole,
  MemberStatus,
  PlatformRole,
  Reaction,
  RecordingStatus,
  SpeakerRequestStatus,
} from './constants';

export interface MeDto {
  userId: string;
  email: string;
  emailVerified: boolean;
  displayName: string;
  platformRole: PlatformRole;
  canCreateEvents: boolean;
}

export interface EventDto {
  id: string;
  title: string;
  description: string;
  startAt: string;
  durationMinutes: number;
  timeZone: string;
  status: EventStatus;
  organizerId: string;
  roomName: string;
  maxParticipants: number;
  maxSpeakers: number;
  recordingEnabled: boolean;
  chatEnabled: boolean;
  chatPersistence: boolean;
  thumbnailUrl: string | null;
  recordingActive: boolean;
  liveStartedAt: string | null;
  endedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** The caller's role in this event, if a member. */
  myRole: MemberRole | null;
  /** Whether the caller may moderate (approve speakers, remove participants). */
  canModerate: boolean;
}

export interface MemberDto {
  eventId: string;
  userId: string;
  email: string;
  displayName: string;
  role: MemberRole;
  status: MemberStatus;
  canModerate: boolean;
  joinedAt: string;
}

export interface InvitationDto {
  id: string;
  eventId: string;
  email: string;
  role: MemberRole;
  status: InvitationStatus;
  invitedBy: string;
  createdAt: string;
  expiresAt: string;
  acceptedAt: string | null;
}

export interface InvitationPreviewDto {
  eventId: string;
  eventTitle: string;
  role: MemberRole;
}

export interface SpeakerRequestDto {
  id: string;
  eventId: string;
  userId: string;
  displayName: string;
  status: SpeakerRequestStatus;
  createdAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
}

export interface ChatMessageDto {
  id: string;
  eventId: string;
  userId: string;
  displayName: string;
  role: MemberRole;
  text: string;
  createdAt: string;
  deleted: boolean;
}

export interface RecordingDto {
  id: string;
  eventId: string;
  status: RecordingStatus;
  startedAt: string;
  endedAt: string | null;
  durationSeconds: number | null;
  sizeBytes: number | null;
  /** Short-lived presigned URL, only present when READY and the caller is authorized. */
  playbackUrl: string | null;
}

export interface JoinTokenDto {
  serverUrl: string;
  token: string;
  roomName: string;
  identity: string;
  role: MemberRole;
  canPublish: boolean;
  expiresAt: string;
}

export interface ParticipantMetadata {
  role: MemberRole;
  displayName: string;
  speaker: boolean;
}

export interface CapacityDto {
  total: number;
  max: number;
  speakers: number;
  maxSpeakers: number;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
    requestId?: string;
  };
}

export interface Paginated<T> {
  items: T[];
  nextCursor: string | null;
}

/** Messages the backend publishes to the LiveKit room data channel. */
export type RoomDataMessage =
  | { type: 'chat'; message: ChatMessageDto }
  | { type: 'chat_deleted'; messageId: string }
  | { type: 'reaction'; emoji: Reaction; userId: string; displayName: string }
  | { type: 'speaker_request'; request: SpeakerRequestDto }
  | { type: 'speaker_request_resolved'; requestId: string; userId: string; status: SpeakerRequestStatus }
  | { type: 'speaker_approved'; requestId: string }
  | { type: 'speaker_revoked' }
  | { type: 'event_status'; status: EventStatus }
  | { type: 'recording'; active: boolean }
  | { type: 'settings'; chatEnabled: boolean };
