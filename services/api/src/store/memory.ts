import { ConditionFailedError } from '../lib/errors';
import type {
  AdmitResult,
  ApproveResult,
  AuditRecord,
  CapacityRecord,
  ChatMessageRecord,
  DeviceRecord,
  EventRecord,
  InvitationRecord,
  MemberRecord,
  ParticipantSessionRecord,
  RecordingRecord,
  SpeakerRequestRecord,
  Store,
  StreamSessionRecord,
  UserRecord,
} from './types';

const clone = <T>(v: T): T => structuredClone(v);
const isHost = (role: string) => role === 'ORGANIZER' || role === 'BROADCASTER';

/**
 * In-memory Store for unit tests and local development (MOCK MODE).
 * Each method runs synchronously between awaits, so the conditional checks are atomic
 * with respect to other calls — mirroring DynamoDB conditional/transactional writes.
 */
export class MemoryStore implements Store {
  users = new Map<string, UserRecord>();
  devices = new Map<string, DeviceRecord>();
  events = new Map<string, EventRecord>();
  members = new Map<string, MemberRecord>();
  invitations = new Map<string, InvitationRecord>();
  sessions = new Map<string, ParticipantSessionRecord>();
  capacity = new Map<string, CapacityRecord>();
  speakerRequests = new Map<string, SpeakerRequestRecord>();
  /** eventId#userId -> open requestId */
  handLocks = new Map<string, string>();
  streams = new Map<string, StreamSessionRecord>();
  chat = new Map<string, ChatMessageRecord>();
  recordings = new Map<string, RecordingRecord>();
  audit: AuditRecord[] = [];
  rate = new Map<string, number>();
  idem = new Map<string, { status: number; body: unknown }>();

  private k = (...parts: string[]) => parts.join('#');

  async getUser(userId: string) {
    return clone(this.users.get(userId) ?? null);
  }
  async upsertUser(user: UserRecord) {
    const existing = this.users.get(user.userId);
    this.users.set(user.userId, { ...user, createdAt: existing?.createdAt ?? user.createdAt });
  }
  async putDevice(device: DeviceRecord) {
    this.devices.set(this.k(device.userId, device.pushToken), clone(device));
  }
  async listDevices(userId: string) {
    return [...this.devices.values()].filter((d) => d.userId === userId).map(clone);
  }

  async createEvent(event: EventRecord, organizer: MemberRecord) {
    if (this.events.has(event.id)) throw new ConditionFailedError('event exists');
    this.events.set(event.id, clone(event));
    this.members.set(this.k(event.id, organizer.userId), clone(organizer));
    this.capacity.set(event.id, { eventId: event.id, total: 0, hosts: 0, speakers: 0 });
  }
  async getEvent(eventId: string) {
    return clone(this.events.get(eventId) ?? null);
  }
  async updateEvent(
    eventId: string,
    changes: Partial<Omit<EventRecord, 'id' | 'version'>>,
    opts: { ifStatusIn?: EventRecord['status'][]; ifActiveRecordingId?: string | null } = {},
  ) {
    const current = this.events.get(eventId);
    if (!current) throw new ConditionFailedError('event missing');
    if (opts.ifStatusIn && !opts.ifStatusIn.includes(current.status)) throw new ConditionFailedError('status');
    if (opts.ifActiveRecordingId !== undefined && current.activeRecordingId !== opts.ifActiveRecordingId) {
      throw new ConditionFailedError('activeRecordingId');
    }
    const next = { ...current, ...changes, version: current.version + 1 };
    this.events.set(eventId, next);
    if (changes.startAt) {
      for (const m of this.members.values()) if (m.eventId === eventId) m.eventStartAt = changes.startAt;
    }
    return clone(next);
  }
  async listEventsByOrganizer(organizerId: string) {
    return [...this.events.values()]
      .filter((e) => e.organizerId === organizerId)
      .sort((a, b) => a.startAt.localeCompare(b.startAt))
      .map(clone);
  }
  async listEventsByStatus(status: EventRecord['status']) {
    return [...this.events.values()]
      .filter((e) => e.status === status)
      .sort((a, b) => a.startAt.localeCompare(b.startAt))
      .map(clone);
  }
  async batchGetEvents(ids: string[]) {
    return ids.map((id) => this.events.get(id)).filter((e): e is EventRecord => !!e).map(clone);
  }

  async getMember(eventId: string, userId: string) {
    return clone(this.members.get(this.k(eventId, userId)) ?? null);
  }
  async putMember(member: MemberRecord) {
    this.members.set(this.k(member.eventId, member.userId), clone(member));
  }
  async listMembers(eventId: string) {
    return [...this.members.values()].filter((m) => m.eventId === eventId).map(clone);
  }
  async listMembershipsForUser(userId: string) {
    return [...this.members.values()]
      .filter((m) => m.userId === userId)
      .sort((a, b) => a.eventStartAt.localeCompare(b.eventStartAt))
      .map(clone);
  }

  async createInvitations(invitations: InvitationRecord[]) {
    for (const inv of invitations) this.invitations.set(this.k(inv.eventId, inv.id), clone(inv));
  }
  async listInvitations(eventId: string) {
    return [...this.invitations.values()].filter((i) => i.eventId === eventId).map(clone);
  }
  async getInvitation(eventId: string, invitationId: string) {
    return clone(this.invitations.get(this.k(eventId, invitationId)) ?? null);
  }
  async getInvitationByTokenHash(tokenHash: string) {
    return clone([...this.invitations.values()].find((i) => i.tokenHash === tokenHash) ?? null);
  }
  async acceptInvitation(invitation: InvitationRecord, member: MemberRecord, now: string) {
    const current = this.invitations.get(this.k(invitation.eventId, invitation.id));
    if (!current || current.status !== 'PENDING' || current.expiresAt <= now) {
      throw new ConditionFailedError('invitation not pending');
    }
    current.status = 'ACCEPTED';
    current.acceptedAt = now;
    current.acceptedBy = member.userId;
    this.members.set(this.k(member.eventId, member.userId), clone(member));
  }
  async setInvitationStatus(
    eventId: string,
    invitationId: string,
    status: InvitationRecord['status'],
    ifStatus: InvitationRecord['status'],
  ) {
    const current = this.invitations.get(this.k(eventId, invitationId));
    if (!current || current.status !== ifStatus) throw new ConditionFailedError('invitation status');
    current.status = status;
  }

  private cap(eventId: string) {
    let c = this.capacity.get(eventId);
    if (!c) {
      c = { eventId, total: 0, hosts: 0, speakers: 0 };
      this.capacity.set(eventId, c);
    }
    return c;
  }

  async admitParticipant(
    eventId: string,
    userId: string,
    role: MemberRecord['role'],
    maxParticipants: number,
    now: string,
  ): Promise<AdmitResult> {
    const key = this.k(eventId, userId);
    const existing = this.sessions.get(key);
    if (existing && existing.state !== 'LEFT') return { status: 'already_admitted' };
    const c = this.cap(eventId);
    // Same rule as the DynamoDB condition expression: one slot is reserved for the first host.
    const fits = isHost(role)
      ? c.total < maxParticipants || c.hosts === 0
      : c.hosts === 0
        ? c.total < maxParticipants - 1
        : c.total < maxParticipants;
    if (!fits) return { status: 'full' };
    c.total += 1;
    if (isHost(role)) c.hosts += 1;
    this.sessions.set(key, {
      eventId,
      userId,
      role,
      state: 'ADMITTED',
      admittedAt: now,
      connectedAt: null,
      leftAt: null,
      livekitSid: null,
    });
    return { status: 'admitted' };
  }
  async releaseParticipant(eventId: string, userId: string, now: string) {
    const s = this.sessions.get(this.k(eventId, userId));
    if (!s || s.state === 'LEFT') return false;
    s.state = 'LEFT';
    s.leftAt = now;
    const c = this.cap(eventId);
    c.total = Math.max(0, c.total - 1);
    if (isHost(s.role)) c.hosts = Math.max(0, c.hosts - 1);
    return true;
  }
  async markParticipantConnected(eventId: string, userId: string, livekitSid: string, now: string) {
    const s = this.sessions.get(this.k(eventId, userId));
    if (!s || s.state === 'LEFT') return;
    s.state = 'CONNECTED';
    s.connectedAt = now;
    s.livekitSid = livekitSid;
  }
  async getParticipantSession(eventId: string, userId: string) {
    return clone(this.sessions.get(this.k(eventId, userId)) ?? null);
  }
  async listParticipantSessions(eventId: string) {
    return [...this.sessions.values()].filter((s) => s.eventId === eventId).map(clone);
  }
  async getCapacity(eventId: string) {
    return clone(this.cap(eventId));
  }
  async resetCapacity(capacity: CapacityRecord) {
    this.capacity.set(capacity.eventId, clone(capacity));
  }

  async createSpeakerRequest(request: SpeakerRequestRecord) {
    const lockKey = this.k(request.eventId, request.userId);
    const openId = this.handLocks.get(lockKey);
    if (openId) {
      const open = this.speakerRequests.get(this.k(request.eventId, openId));
      if (open) return { created: false, request: clone(open) };
    }
    this.handLocks.set(lockKey, request.id);
    this.speakerRequests.set(this.k(request.eventId, request.id), clone(request));
    return { created: true, request: clone(request) };
  }
  async getSpeakerRequest(eventId: string, requestId: string) {
    return clone(this.speakerRequests.get(this.k(eventId, requestId)) ?? null);
  }
  async getOpenSpeakerRequest(eventId: string, userId: string) {
    const id = this.handLocks.get(this.k(eventId, userId));
    return id ? clone(this.speakerRequests.get(this.k(eventId, id)) ?? null) : null;
  }
  async listSpeakerRequests(eventId: string) {
    return [...this.speakerRequests.values()]
      .filter((r) => r.eventId === eventId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map(clone);
  }
  async approveSpeakerRequest(
    eventId: string,
    requestId: string,
    maxSpeakers: number,
    approverId: string,
    now: string,
  ): Promise<ApproveResult> {
    const req = this.speakerRequests.get(this.k(eventId, requestId));
    if (!req || req.status !== 'PENDING') return { status: 'not_pending', request: clone(req ?? null) };
    const c = this.cap(eventId);
    if (c.speakers >= maxSpeakers) return { status: 'speaker_limit' };
    c.speakers += 1;
    req.status = 'APPROVED';
    req.resolvedAt = now;
    req.resolvedBy = approverId;
    return { status: 'approved', request: clone(req) };
  }
  async closePendingSpeakerRequest(
    eventId: string,
    requestId: string,
    status: 'REJECTED' | 'CANCELLED',
    actorId: string,
    now: string,
  ) {
    const req = this.speakerRequests.get(this.k(eventId, requestId));
    if (!req || req.status !== 'PENDING') return null;
    req.status = status;
    req.resolvedAt = now;
    req.resolvedBy = actorId;
    this.handLocks.delete(this.k(eventId, req.userId));
    return clone(req);
  }
  async revokeSpeaker(eventId: string, userId: string, actorId: string, now: string) {
    const lockKey = this.k(eventId, userId);
    const id = this.handLocks.get(lockKey);
    const req = id ? this.speakerRequests.get(this.k(eventId, id)) : undefined;
    if (!req || req.status !== 'APPROVED') return null;
    req.status = 'REVOKED';
    req.resolvedAt = now;
    req.resolvedBy = actorId;
    this.handLocks.delete(lockKey);
    const c = this.cap(eventId);
    c.speakers = Math.max(0, c.speakers - 1);
    return clone(req);
  }

  async putStreamSession(session: StreamSessionRecord) {
    this.streams.set(this.k(session.eventId, session.id), clone(session));
  }
  async endStreamSession(eventId: string, sessionId: string, endedAt: string, peak: number) {
    const s = this.streams.get(this.k(eventId, sessionId));
    if (s) {
      s.endedAt = endedAt;
      s.peakParticipants = Math.max(s.peakParticipants, peak);
    }
  }

  async putChatMessage(message: ChatMessageRecord) {
    this.chat.set(this.k(message.eventId, message.id), clone(message));
  }
  async listChatMessages(eventId: string, limit: number) {
    return [...this.chat.values()]
      .filter((m) => m.eventId === eventId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .slice(-limit)
      .map(clone);
  }
  async markChatMessageDeleted(eventId: string, messageId: string, deletedBy: string) {
    const m = this.chat.get(this.k(eventId, messageId));
    if (!m) return false;
    m.deleted = true;
    m.deletedBy = deletedBy;
    m.text = '';
    return true;
  }

  async createRecording(recording: RecordingRecord) {
    const event = this.events.get(recording.eventId);
    if (!event || event.activeRecordingId) throw new ConditionFailedError('recording already active');
    event.activeRecordingId = recording.id;
    event.version += 1;
    this.recordings.set(this.k(recording.eventId, recording.id), clone(recording));
  }
  async getRecording(eventId: string, recordingId: string) {
    return clone(this.recordings.get(this.k(eventId, recordingId)) ?? null);
  }
  async getRecordingByEgressId(egressId: string) {
    return clone([...this.recordings.values()].find((r) => r.egressId === egressId) ?? null);
  }
  async updateRecording(eventId: string, recordingId: string, changes: Partial<RecordingRecord>) {
    const r = this.recordings.get(this.k(eventId, recordingId));
    if (!r) throw new ConditionFailedError('recording missing');
    Object.assign(r, changes);
    return clone(r);
  }
  async listRecordings(eventId: string) {
    return [...this.recordings.values()]
      .filter((r) => r.eventId === eventId)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .map(clone);
  }

  async putAudit(record: AuditRecord) {
    this.audit.push(clone(record));
  }
  async listAudit(scope: string, limit: number) {
    return this.audit
      .filter((a) => a.scope === scope)
      .slice(-limit)
      .reverse()
      .map(clone);
  }
  async hitRateLimit(key: string, limit: number, windowSeconds: number, nowMs: number) {
    const window = Math.floor(nowMs / 1000 / windowSeconds);
    const k = this.k(key, String(window));
    const count = (this.rate.get(k) ?? 0) + 1;
    this.rate.set(k, count);
    return count <= limit;
  }

  async getIdempotentResponse(key: string) {
    return clone(this.idem.get(key) ?? null);
  }
  async putIdempotentResponse(key: string, response: { status: number; body: unknown }) {
    this.idem.set(key, clone(response));
  }
}
