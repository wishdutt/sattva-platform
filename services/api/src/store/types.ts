import type {
  EventStatus,
  InvitationStatus,
  MemberRole,
  MemberStatus,
  PlatformRole,
  RecordingStatus,
  SpeakerRequestStatus,
} from '@lsp/shared';

export interface UserRecord {
  userId: string;
  email: string;
  displayName: string;
  platformRole: PlatformRole;
  createdAt: string;
  updatedAt: string;
}

export interface DeviceRecord {
  userId: string;
  pushToken: string;
  platform: 'ios' | 'android' | 'web';
  updatedAt: string;
}

export interface EventRecord {
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
  thumbnailKey: string | null;
  activeRecordingId: string | null;
  activeStreamSessionId: string | null;
  liveStartedAt: string | null;
  endedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Optimistic-locking counter, incremented on every update. */
  version: number;
}

export interface MemberRecord {
  eventId: string;
  userId: string;
  email: string;
  displayName: string;
  role: MemberRole;
  status: MemberStatus;
  canModerate: boolean;
  /** Denormalized for the "my events" index sort key. */
  eventStartAt: string;
  joinedAt: string;
  updatedAt: string;
}

export interface InvitationRecord {
  id: string;
  eventId: string;
  email: string;
  role: MemberRole;
  status: InvitationStatus;
  tokenHash: string;
  invitedBy: string;
  createdAt: string;
  expiresAt: string;
  acceptedAt: string | null;
  acceptedBy: string | null;
}

export type ParticipantState = 'ADMITTED' | 'CONNECTED' | 'LEFT';

export interface ParticipantSessionRecord {
  eventId: string;
  userId: string;
  role: MemberRole;
  state: ParticipantState;
  admittedAt: string;
  connectedAt: string | null;
  leftAt: string | null;
  livekitSid: string | null;
}

export interface CapacityRecord {
  eventId: string;
  /** Admitted or connected participants (all roles). */
  total: number;
  /** Admitted hosts (ORGANIZER / BROADCASTER). */
  hosts: number;
  /** Approved audience speakers. */
  speakers: number;
}

export interface SpeakerRequestRecord {
  id: string;
  eventId: string;
  userId: string;
  displayName: string;
  status: SpeakerRequestStatus;
  createdAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
}

export interface StreamSessionRecord {
  id: string;
  eventId: string;
  startedAt: string;
  startedBy: string;
  endedAt: string | null;
  peakParticipants: number;
}

export interface ChatMessageRecord {
  id: string;
  eventId: string;
  userId: string;
  displayName: string;
  role: MemberRole;
  text: string;
  createdAt: string;
  deleted: boolean;
  deletedBy: string | null;
  /** Epoch seconds for DynamoDB TTL. */
  ttl: number;
}

export interface RecordingRecord {
  id: string;
  eventId: string;
  egressId: string | null;
  status: RecordingStatus;
  s3Key: string;
  startedBy: string;
  startedAt: string;
  endedAt: string | null;
  durationSeconds: number | null;
  sizeBytes: number | null;
  error: string | null;
}

export interface AuditRecord {
  id: string;
  scope: string;
  action: string;
  actorId: string | null;
  targetId: string | null;
  details: Record<string, unknown>;
  at: string;
  ttl: number;
}

export type AdmitResult = { status: 'admitted' } | { status: 'already_admitted' } | { status: 'full' };

export type ApproveResult =
  | { status: 'approved'; request: SpeakerRequestRecord }
  | { status: 'not_pending'; request: SpeakerRequestRecord | null }
  | { status: 'speaker_limit' };

/**
 * Domain-level persistence port. Every method that enforces an invariant
 * (single-use invitations, capacity, speaker slots) is atomic in each implementation.
 */
export interface Store {
  // Users
  getUser(userId: string): Promise<UserRecord | null>;
  upsertUser(user: UserRecord): Promise<void>;
  putDevice(device: DeviceRecord): Promise<void>;
  listDevices(userId: string): Promise<DeviceRecord[]>;

  // Events
  createEvent(event: EventRecord, organizer: MemberRecord): Promise<void>;
  getEvent(eventId: string): Promise<EventRecord | null>;
  /** Applies `changes` if the event status is in `ifStatusIn` (when given). Throws ConditionFailedError otherwise. */
  updateEvent(
    eventId: string,
    changes: Partial<Omit<EventRecord, 'id' | 'version'>>,
    opts?: { ifStatusIn?: EventStatus[]; ifActiveRecordingId?: string | null },
  ): Promise<EventRecord>;
  listEventsByOrganizer(organizerId: string): Promise<EventRecord[]>;
  listEventsByStatus(status: EventStatus): Promise<EventRecord[]>;
  batchGetEvents(ids: string[]): Promise<EventRecord[]>;

  // Members
  getMember(eventId: string, userId: string): Promise<MemberRecord | null>;
  putMember(member: MemberRecord): Promise<void>;
  listMembers(eventId: string): Promise<MemberRecord[]>;
  listMembershipsForUser(userId: string): Promise<MemberRecord[]>;

  // Invitations
  createInvitations(invitations: InvitationRecord[]): Promise<void>;
  listInvitations(eventId: string): Promise<InvitationRecord[]>;
  getInvitation(eventId: string, invitationId: string): Promise<InvitationRecord | null>;
  getInvitationByTokenHash(tokenHash: string): Promise<InvitationRecord | null>;
  /** Atomically marks a PENDING, unexpired invitation ACCEPTED and writes the membership. */
  acceptInvitation(invitation: InvitationRecord, member: MemberRecord, now: string): Promise<void>;
  setInvitationStatus(
    eventId: string,
    invitationId: string,
    status: InvitationStatus,
    ifStatus: InvitationStatus,
  ): Promise<void>;

  // Capacity & participant sessions
  admitParticipant(
    eventId: string,
    userId: string,
    role: MemberRole,
    maxParticipants: number,
    now: string,
  ): Promise<AdmitResult>;
  /** Idempotent. Returns true if a slot was released. */
  releaseParticipant(eventId: string, userId: string, now: string): Promise<boolean>;
  markParticipantConnected(eventId: string, userId: string, livekitSid: string, now: string): Promise<void>;
  getParticipantSession(eventId: string, userId: string): Promise<ParticipantSessionRecord | null>;
  listParticipantSessions(eventId: string): Promise<ParticipantSessionRecord[]>;
  getCapacity(eventId: string): Promise<CapacityRecord>;
  /** Overwrites counters (used by reconciliation after recomputing from sessions). */
  resetCapacity(capacity: CapacityRecord): Promise<void>;

  // Speaker requests
  /** Creates a PENDING request unless the user already has an open (PENDING/APPROVED) one, which is returned instead. */
  createSpeakerRequest(request: SpeakerRequestRecord): Promise<{ created: boolean; request: SpeakerRequestRecord }>;
  getSpeakerRequest(eventId: string, requestId: string): Promise<SpeakerRequestRecord | null>;
  getOpenSpeakerRequest(eventId: string, userId: string): Promise<SpeakerRequestRecord | null>;
  listSpeakerRequests(eventId: string): Promise<SpeakerRequestRecord[]>;
  approveSpeakerRequest(
    eventId: string,
    requestId: string,
    maxSpeakers: number,
    approverId: string,
    now: string,
  ): Promise<ApproveResult>;
  /** Closes a PENDING request (REJECTED / CANCELLED). Returns null if it was not pending. */
  closePendingSpeakerRequest(
    eventId: string,
    requestId: string,
    status: 'REJECTED' | 'CANCELLED',
    actorId: string,
    now: string,
  ): Promise<SpeakerRequestRecord | null>;
  /** Revokes an APPROVED request and frees the speaker slot. Returns null if none was approved. */
  revokeSpeaker(eventId: string, userId: string, actorId: string, now: string): Promise<SpeakerRequestRecord | null>;

  // Stream sessions
  putStreamSession(session: StreamSessionRecord): Promise<void>;
  endStreamSession(eventId: string, sessionId: string, endedAt: string, peak: number): Promise<void>;

  // Chat
  putChatMessage(message: ChatMessageRecord): Promise<void>;
  listChatMessages(eventId: string, limit: number): Promise<ChatMessageRecord[]>;
  markChatMessageDeleted(eventId: string, messageId: string, deletedBy: string): Promise<boolean>;

  // Recordings
  /** Atomically sets the event's activeRecordingId (must be null) and writes the recording. */
  createRecording(recording: RecordingRecord): Promise<void>;
  getRecording(eventId: string, recordingId: string): Promise<RecordingRecord | null>;
  getRecordingByEgressId(egressId: string): Promise<RecordingRecord | null>;
  updateRecording(eventId: string, recordingId: string, changes: Partial<RecordingRecord>): Promise<RecordingRecord>;
  listRecordings(eventId: string): Promise<RecordingRecord[]>;

  // Audit & rate limiting
  putAudit(record: AuditRecord): Promise<void>;
  listAudit(scope: string, limit: number): Promise<AuditRecord[]>;
  /** Fixed-window counter. Returns false when the limit is exceeded. */
  hitRateLimit(key: string, limit: number, windowSeconds: number, nowMs: number): Promise<boolean>;

  // Idempotency
  getIdempotentResponse(key: string): Promise<{ status: number; body: unknown } | null>;
  putIdempotentResponse(key: string, response: { status: number; body: unknown }, ttlSeconds: number): Promise<void>;

  // Optional capabilities (standalone deployments)
  /** Deletes expired rows where the database has no native TTL. Returns rows removed. */
  purgeExpired?(): Promise<number>;
  /** Cluster-wide lease so only one replica runs a scheduled job. */
  tryAcquireLease?(name: string, owner: string, ttlSeconds: number): Promise<boolean>;
}
