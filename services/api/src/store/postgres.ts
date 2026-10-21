import { ConditionFailedError } from '../lib/errors';
import { sha256 } from '../lib/ids';
import { MIGRATIONS } from './postgres-schema';
import type { Sql, SqlDatabase } from './sql';
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

type Row = Record<string, unknown>;

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());
const isoOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : iso(v));
const num = (v: unknown): number => Number(v);
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const isHost = (role: string) => role === 'ORGANIZER' || role === 'BROADCASTER';

// ------------------------------------------------------------------ row mappers
const toUser = (r: Row): UserRecord => ({
  userId: String(r.user_id),
  email: String(r.email),
  displayName: String(r.display_name),
  platformRole: r.platform_role as UserRecord['platformRole'],
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
});

const toDevice = (r: Row): DeviceRecord => ({
  userId: String(r.user_id),
  pushToken: String(r.push_token),
  platform: r.platform as DeviceRecord['platform'],
  updatedAt: iso(r.updated_at),
});

const toEvent = (r: Row): EventRecord => ({
  id: String(r.id),
  title: String(r.title),
  description: String(r.description),
  startAt: iso(r.start_at),
  durationMinutes: num(r.duration_minutes),
  timeZone: String(r.time_zone),
  status: r.status as EventRecord['status'],
  organizerId: String(r.organizer_id),
  roomName: String(r.room_name),
  maxParticipants: num(r.max_participants),
  maxSpeakers: num(r.max_speakers),
  recordingEnabled: Boolean(r.recording_enabled),
  chatEnabled: Boolean(r.chat_enabled),
  chatPersistence: Boolean(r.chat_persistence),
  thumbnailKey: (r.thumbnail_key as string | null) ?? null,
  activeRecordingId: (r.active_recording_id as string | null) ?? null,
  activeStreamSessionId: (r.active_stream_session_id as string | null) ?? null,
  liveStartedAt: isoOrNull(r.live_started_at),
  endedAt: isoOrNull(r.ended_at),
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
  version: num(r.version),
});

const toMember = (r: Row): MemberRecord => ({
  eventId: String(r.event_id),
  userId: String(r.user_id),
  email: String(r.email),
  displayName: String(r.display_name),
  role: r.role as MemberRecord['role'],
  status: r.status as MemberRecord['status'],
  canModerate: Boolean(r.can_moderate),
  eventStartAt: iso(r.event_start_at),
  joinedAt: iso(r.joined_at),
  updatedAt: iso(r.updated_at),
});

const toInvitation = (r: Row): InvitationRecord => ({
  id: String(r.id),
  eventId: String(r.event_id),
  email: String(r.email),
  role: r.role as InvitationRecord['role'],
  status: r.status as InvitationRecord['status'],
  tokenHash: String(r.token_hash),
  invitedBy: String(r.invited_by),
  createdAt: iso(r.created_at),
  expiresAt: iso(r.expires_at),
  acceptedAt: isoOrNull(r.accepted_at),
  acceptedBy: (r.accepted_by as string | null) ?? null,
});

const toSession = (r: Row): ParticipantSessionRecord => ({
  eventId: String(r.event_id),
  userId: String(r.user_id),
  role: r.role as ParticipantSessionRecord['role'],
  state: r.state as ParticipantSessionRecord['state'],
  admittedAt: iso(r.admitted_at),
  connectedAt: isoOrNull(r.connected_at),
  leftAt: isoOrNull(r.left_at),
  livekitSid: (r.livekit_sid as string | null) ?? null,
});

const toRequest = (r: Row): SpeakerRequestRecord => ({
  id: String(r.id),
  eventId: String(r.event_id),
  userId: String(r.user_id),
  displayName: String(r.display_name),
  status: r.status as SpeakerRequestRecord['status'],
  createdAt: iso(r.created_at),
  resolvedAt: isoOrNull(r.resolved_at),
  resolvedBy: (r.resolved_by as string | null) ?? null,
});

const toChat = (r: Row): ChatMessageRecord => ({
  id: String(r.id),
  eventId: String(r.event_id),
  userId: String(r.user_id),
  displayName: String(r.display_name),
  role: r.role as ChatMessageRecord['role'],
  text: String(r.text),
  createdAt: iso(r.created_at),
  deleted: Boolean(r.deleted),
  deletedBy: (r.deleted_by as string | null) ?? null,
  ttl: Math.floor(new Date(iso(r.expires_at)).getTime() / 1000),
});

const toRecording = (r: Row): RecordingRecord => ({
  id: String(r.id),
  eventId: String(r.event_id),
  egressId: (r.egress_id as string | null) ?? null,
  status: r.status as RecordingRecord['status'],
  s3Key: String(r.s3_key),
  startedBy: String(r.started_by),
  startedAt: iso(r.started_at),
  endedAt: isoOrNull(r.ended_at),
  durationSeconds: numOrNull(r.duration_seconds),
  sizeBytes: numOrNull(r.size_bytes),
  error: (r.error as string | null) ?? null,
});

const toAudit = (r: Row): AuditRecord => ({
  id: String(r.id),
  scope: String(r.scope),
  action: String(r.action),
  actorId: (r.actor_id as string | null) ?? null,
  targetId: (r.target_id as string | null) ?? null,
  details: (typeof r.details === 'string' ? JSON.parse(r.details) : r.details) as Record<string, unknown>,
  at: iso(r.at),
  ttl: Math.floor(new Date(iso(r.expires_at)).getTime() / 1000),
});

/** camelCase record field -> snake_case column, for the fields services are allowed to change. */
const EVENT_COLUMNS: Record<string, string> = {
  title: 'title',
  description: 'description',
  startAt: 'start_at',
  durationMinutes: 'duration_minutes',
  timeZone: 'time_zone',
  status: 'status',
  maxParticipants: 'max_participants',
  maxSpeakers: 'max_speakers',
  recordingEnabled: 'recording_enabled',
  chatEnabled: 'chat_enabled',
  chatPersistence: 'chat_persistence',
  thumbnailKey: 'thumbnail_key',
  activeRecordingId: 'active_recording_id',
  activeStreamSessionId: 'active_stream_session_id',
  liveStartedAt: 'live_started_at',
  endedAt: 'ended_at',
  updatedAt: 'updated_at',
};

const RECORDING_COLUMNS: Record<string, string> = {
  egressId: 'egress_id',
  status: 'status',
  endedAt: 'ended_at',
  durationSeconds: 'duration_seconds',
  sizeBytes: 'size_bytes',
  error: 'error',
};

export async function migrate(db: SqlDatabase) {
  await db.query(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, name text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())',
  );
  const { rows } = await db.query<{ version: number }>('SELECT version FROM schema_migrations');
  const applied = new Set(rows.map((r) => Number(r.version)));
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    await db.transaction(async (tx) => {
      await tx.exec(m.sql);
      await tx.query('INSERT INTO schema_migrations (version, name) VALUES ($1, $2)', [m.version, m.name]);
    });
  }
}

/**
 * PostgreSQL implementation of the Store port. Invariants use row locks on the per-event
 * `capacity` row (SELECT … FOR UPDATE), conditional UPDATEs, and a partial unique index.
 */
export class PostgresStore implements Store {
  constructor(private readonly db: SqlDatabase) {}

  // ---------------------------------------------------------------- Users
  async getUser(userId: string) {
    const { rows } = await this.db.query('SELECT * FROM users WHERE user_id = $1', [userId]);
    return rows[0] ? toUser(rows[0]) : null;
  }

  async upsertUser(u: UserRecord) {
    await this.db.query(
      `INSERT INTO users (user_id, email, display_name, platform_role, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id) DO UPDATE SET email = EXCLUDED.email, display_name = EXCLUDED.display_name,
         platform_role = EXCLUDED.platform_role, updated_at = EXCLUDED.updated_at`,
      [u.userId, u.email, u.displayName, u.platformRole, u.createdAt, u.updatedAt],
    );
  }

  async putDevice(d: DeviceRecord) {
    await this.db.query(
      `INSERT INTO devices (user_id, token_hash, push_token, platform, updated_at) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, token_hash) DO UPDATE SET platform = EXCLUDED.platform, updated_at = EXCLUDED.updated_at`,
      [d.userId, sha256(d.pushToken), d.pushToken, d.platform, d.updatedAt],
    );
  }

  async listDevices(userId: string) {
    const { rows } = await this.db.query('SELECT * FROM devices WHERE user_id = $1', [userId]);
    return rows.map(toDevice);
  }

  // ---------------------------------------------------------------- Events
  private insertMember(tx: Sql, m: MemberRecord) {
    return tx.query(
      `INSERT INTO event_members (event_id, user_id, email, display_name, role, status, can_moderate, event_start_at, joined_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (event_id, user_id) DO UPDATE SET email = EXCLUDED.email, display_name = EXCLUDED.display_name,
         role = EXCLUDED.role, status = EXCLUDED.status, can_moderate = EXCLUDED.can_moderate,
         event_start_at = EXCLUDED.event_start_at, updated_at = EXCLUDED.updated_at`,
      [m.eventId, m.userId, m.email, m.displayName, m.role, m.status, m.canModerate, m.eventStartAt, m.joinedAt, m.updatedAt],
    );
  }

  async createEvent(e: EventRecord, organizer: MemberRecord) {
    await this.db.transaction(async (tx) => {
      const res = await tx.query(
        `INSERT INTO events (id, title, description, start_at, duration_minutes, time_zone, status, organizer_id, room_name,
           max_participants, max_speakers, recording_enabled, chat_enabled, chat_persistence, thumbnail_key,
           active_recording_id, active_stream_session_id, live_started_at, ended_at, created_at, updated_at, version)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
         ON CONFLICT (id) DO NOTHING`,
        [
          e.id, e.title, e.description, e.startAt, e.durationMinutes, e.timeZone, e.status, e.organizerId, e.roomName,
          e.maxParticipants, e.maxSpeakers, e.recordingEnabled, e.chatEnabled, e.chatPersistence, e.thumbnailKey,
          e.activeRecordingId, e.activeStreamSessionId, e.liveStartedAt, e.endedAt, e.createdAt, e.updatedAt, e.version,
        ],
      );
      if (res.rowCount === 0) throw new ConditionFailedError('event exists');
      await this.insertMember(tx, organizer);
      await tx.query('INSERT INTO capacity (event_id) VALUES ($1)', [e.id]);
    });
  }

  async getEvent(eventId: string) {
    const { rows } = await this.db.query('SELECT * FROM events WHERE id = $1', [eventId]);
    return rows[0] ? toEvent(rows[0]) : null;
  }

  async updateEvent(
    eventId: string,
    changes: Partial<Omit<EventRecord, 'id' | 'version'>>,
    opts: { ifStatusIn?: EventRecord['status'][]; ifActiveRecordingId?: string | null } = {},
  ) {
    return this.db.transaction(async (tx) => {
      const params: unknown[] = [eventId];
      const sets: string[] = ['version = version + 1'];
      for (const [key, value] of Object.entries(changes)) {
        if (value === undefined) continue;
        const column = EVENT_COLUMNS[key];
        if (!column) throw new Error(`Field ${key} is not updatable`);
        params.push(value);
        sets.push(`${column} = $${params.length}`);
      }
      const where = ['id = $1'];
      if (opts.ifStatusIn) {
        params.push(opts.ifStatusIn);
        where.push(`status = ANY($${params.length}::text[])`);
      }
      if (opts.ifActiveRecordingId !== undefined) {
        params.push(opts.ifActiveRecordingId);
        where.push(`active_recording_id IS NOT DISTINCT FROM $${params.length}::text`);
      }
      const { rows } = await tx.query(`UPDATE events SET ${sets.join(', ')} WHERE ${where.join(' AND ')} RETURNING *`, params);
      if (!rows[0]) throw new ConditionFailedError('event condition');
      if (changes.startAt) {
        await tx.query('UPDATE event_members SET event_start_at = $2 WHERE event_id = $1', [eventId, changes.startAt]);
      }
      return toEvent(rows[0]);
    });
  }

  async listEventsByOrganizer(organizerId: string) {
    const { rows } = await this.db.query('SELECT * FROM events WHERE organizer_id = $1 ORDER BY start_at, id', [organizerId]);
    return rows.map(toEvent);
  }

  async listEventsByStatus(status: EventRecord['status']) {
    const { rows } = await this.db.query('SELECT * FROM events WHERE status = $1 ORDER BY start_at, id', [status]);
    return rows.map(toEvent);
  }

  async batchGetEvents(ids: string[]) {
    if (ids.length === 0) return [];
    const { rows } = await this.db.query('SELECT * FROM events WHERE id = ANY($1::text[])', [ids]);
    return rows.map(toEvent);
  }

  // ---------------------------------------------------------------- Members
  async getMember(eventId: string, userId: string) {
    const { rows } = await this.db.query('SELECT * FROM event_members WHERE event_id = $1 AND user_id = $2', [eventId, userId]);
    return rows[0] ? toMember(rows[0]) : null;
  }

  async putMember(m: MemberRecord) {
    await this.insertMember(this.db, m);
  }

  async listMembers(eventId: string) {
    const { rows } = await this.db.query('SELECT * FROM event_members WHERE event_id = $1 ORDER BY joined_at', [eventId]);
    return rows.map(toMember);
  }

  async listMembershipsForUser(userId: string) {
    const { rows } = await this.db.query(
      'SELECT * FROM event_members WHERE user_id = $1 ORDER BY event_start_at, event_id',
      [userId],
    );
    return rows.map(toMember);
  }

  // ---------------------------------------------------------------- Invitations
  async createInvitations(invitations: InvitationRecord[]) {
    await this.db.transaction(async (tx) => {
      for (const i of invitations) {
        await tx.query(
          `INSERT INTO invitations (id, event_id, email, role, status, token_hash, invited_by, created_at, expires_at, accepted_at, accepted_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [i.id, i.eventId, i.email, i.role, i.status, i.tokenHash, i.invitedBy, i.createdAt, i.expiresAt, i.acceptedAt, i.acceptedBy],
        );
      }
    });
  }

  async listInvitations(eventId: string) {
    const { rows } = await this.db.query('SELECT * FROM invitations WHERE event_id = $1 ORDER BY created_at', [eventId]);
    return rows.map(toInvitation);
  }

  async getInvitation(eventId: string, invitationId: string) {
    const { rows } = await this.db.query('SELECT * FROM invitations WHERE event_id = $1 AND id = $2', [eventId, invitationId]);
    return rows[0] ? toInvitation(rows[0]) : null;
  }

  async getInvitationByTokenHash(tokenHash: string) {
    const { rows } = await this.db.query('SELECT * FROM invitations WHERE token_hash = $1', [tokenHash]);
    return rows[0] ? toInvitation(rows[0]) : null;
  }

  async acceptInvitation(invitation: InvitationRecord, member: MemberRecord, now: string) {
    await this.db.transaction(async (tx) => {
      const res = await tx.query(
        `UPDATE invitations SET status = 'ACCEPTED', accepted_at = $3, accepted_by = $4
         WHERE event_id = $1 AND id = $2 AND status = 'PENDING' AND expires_at > $3`,
        [invitation.eventId, invitation.id, now, member.userId],
      );
      if (res.rowCount === 0) throw new ConditionFailedError('invitation not pending');
      await this.insertMember(tx, member);
    });
  }

  async setInvitationStatus(
    eventId: string,
    invitationId: string,
    status: InvitationRecord['status'],
    ifStatus: InvitationRecord['status'],
  ) {
    const res = await this.db.query('UPDATE invitations SET status = $3 WHERE event_id = $1 AND id = $2 AND status = $4', [
      eventId,
      invitationId,
      status,
      ifStatus,
    ]);
    if (res.rowCount === 0) throw new ConditionFailedError('invitation status');
  }

  // ---------------------------------------------------------------- Capacity
  /** Locks (creating if needed) the per-event capacity row; serializes admissions and speaker changes. */
  private async lockCapacity(tx: Sql, eventId: string): Promise<CapacityRecord> {
    await tx.query('INSERT INTO capacity (event_id) VALUES ($1) ON CONFLICT (event_id) DO NOTHING', [eventId]);
    const { rows } = await tx.query('SELECT * FROM capacity WHERE event_id = $1 FOR UPDATE', [eventId]);
    const r = rows[0]!;
    return { eventId, total: num(r.total), hosts: num(r.hosts), speakers: num(r.speakers) };
  }

  async admitParticipant(
    eventId: string,
    userId: string,
    role: MemberRecord['role'],
    maxParticipants: number,
    now: string,
  ): Promise<AdmitResult> {
    return this.db.transaction(async (tx) => {
      const c = await this.lockCapacity(tx, eventId);
      const { rows } = await tx.query('SELECT state FROM participant_sessions WHERE event_id = $1 AND user_id = $2', [
        eventId,
        userId,
      ]);
      if (rows[0] && rows[0].state !== 'LEFT') return { status: 'already_admitted' as const };
      const host = isHost(role);
      // One slot stays reserved for the first host (same rule as the DynamoDB condition).
      const fits = host
        ? c.total < maxParticipants || c.hosts === 0
        : c.hosts === 0
          ? c.total < maxParticipants - 1
          : c.total < maxParticipants;
      if (!fits) return { status: 'full' as const };
      await tx.query(
        `INSERT INTO participant_sessions (event_id, user_id, role, state, admitted_at, connected_at, left_at, livekit_sid)
         VALUES ($1, $2, $3, 'ADMITTED', $4, NULL, NULL, NULL)
         ON CONFLICT (event_id, user_id) DO UPDATE SET role = EXCLUDED.role, state = 'ADMITTED',
           admitted_at = EXCLUDED.admitted_at, connected_at = NULL, left_at = NULL, livekit_sid = NULL`,
        [eventId, userId, role, now],
      );
      await tx.query('UPDATE capacity SET total = total + 1, hosts = hosts + $2 WHERE event_id = $1', [eventId, host ? 1 : 0]);
      return { status: 'admitted' as const };
    });
  }

  async releaseParticipant(eventId: string, userId: string, now: string) {
    return this.db.transaction(async (tx) => {
      await this.lockCapacity(tx, eventId);
      const { rows } = await tx.query(
        `UPDATE participant_sessions SET state = 'LEFT', left_at = $3
         WHERE event_id = $1 AND user_id = $2 AND state <> 'LEFT' RETURNING role`,
        [eventId, userId, now],
      );
      if (!rows[0]) return false;
      await tx.query(
        'UPDATE capacity SET total = GREATEST(total - 1, 0), hosts = GREATEST(hosts - $2, 0) WHERE event_id = $1',
        [eventId, isHost(String(rows[0].role)) ? 1 : 0],
      );
      return true;
    });
  }

  async markParticipantConnected(eventId: string, userId: string, livekitSid: string, now: string) {
    await this.db.query(
      `UPDATE participant_sessions SET state = 'CONNECTED', connected_at = $3, livekit_sid = $4
       WHERE event_id = $1 AND user_id = $2 AND state <> 'LEFT'`,
      [eventId, userId, now, livekitSid],
    );
  }

  async getParticipantSession(eventId: string, userId: string) {
    const { rows } = await this.db.query('SELECT * FROM participant_sessions WHERE event_id = $1 AND user_id = $2', [
      eventId,
      userId,
    ]);
    return rows[0] ? toSession(rows[0]) : null;
  }

  async listParticipantSessions(eventId: string) {
    const { rows } = await this.db.query('SELECT * FROM participant_sessions WHERE event_id = $1', [eventId]);
    return rows.map(toSession);
  }

  async getCapacity(eventId: string): Promise<CapacityRecord> {
    const { rows } = await this.db.query('SELECT * FROM capacity WHERE event_id = $1', [eventId]);
    const r = rows[0];
    return { eventId, total: num(r?.total ?? 0), hosts: num(r?.hosts ?? 0), speakers: num(r?.speakers ?? 0) };
  }

  async resetCapacity(c: CapacityRecord) {
    await this.db.query(
      `INSERT INTO capacity (event_id, total, hosts, speakers) VALUES ($1, $2, $3, $4)
       ON CONFLICT (event_id) DO UPDATE SET total = EXCLUDED.total, hosts = EXCLUDED.hosts, speakers = EXCLUDED.speakers`,
      [c.eventId, c.total, c.hosts, c.speakers],
    );
  }

  // ---------------------------------------------------------------- Speaker requests
  async createSpeakerRequest(r: SpeakerRequestRecord) {
    const { rows } = await this.db.query(
      `INSERT INTO speaker_requests (id, event_id, user_id, display_name, status, created_at, resolved_at, resolved_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (event_id, user_id) WHERE status IN ('PENDING','APPROVED') DO NOTHING
       RETURNING *`,
      [r.id, r.eventId, r.userId, r.displayName, r.status, r.createdAt, r.resolvedAt, r.resolvedBy],
    );
    if (rows[0]) return { created: true, request: toRequest(rows[0]) };
    const open = await this.getOpenSpeakerRequest(r.eventId, r.userId);
    if (!open) throw new ConditionFailedError('open request vanished');
    return { created: false, request: open };
  }

  async getSpeakerRequest(eventId: string, requestId: string) {
    const { rows } = await this.db.query('SELECT * FROM speaker_requests WHERE event_id = $1 AND id = $2', [eventId, requestId]);
    return rows[0] ? toRequest(rows[0]) : null;
  }

  async getOpenSpeakerRequest(eventId: string, userId: string) {
    const { rows } = await this.db.query(
      `SELECT * FROM speaker_requests WHERE event_id = $1 AND user_id = $2 AND status IN ('PENDING','APPROVED')`,
      [eventId, userId],
    );
    return rows[0] ? toRequest(rows[0]) : null;
  }

  async listSpeakerRequests(eventId: string) {
    const { rows } = await this.db.query('SELECT * FROM speaker_requests WHERE event_id = $1 ORDER BY created_at, id', [
      eventId,
    ]);
    return rows.map(toRequest);
  }

  async approveSpeakerRequest(
    eventId: string,
    requestId: string,
    maxSpeakers: number,
    approverId: string,
    now: string,
  ): Promise<ApproveResult> {
    return this.db.transaction(async (tx) => {
      const c = await this.lockCapacity(tx, eventId);
      const { rows } = await tx.query('SELECT * FROM speaker_requests WHERE event_id = $1 AND id = $2 FOR UPDATE', [
        eventId,
        requestId,
      ]);
      const req = rows[0] ? toRequest(rows[0]) : null;
      if (!req || req.status !== 'PENDING') return { status: 'not_pending' as const, request: req };
      if (c.speakers >= maxSpeakers) return { status: 'speaker_limit' as const };
      const updated = await tx.query(
        `UPDATE speaker_requests SET status = 'APPROVED', resolved_at = $3, resolved_by = $4
         WHERE event_id = $1 AND id = $2 RETURNING *`,
        [eventId, requestId, now, approverId],
      );
      await tx.query('UPDATE capacity SET speakers = speakers + 1 WHERE event_id = $1', [eventId]);
      return { status: 'approved' as const, request: toRequest(updated.rows[0]!) };
    });
  }

  async closePendingSpeakerRequest(
    eventId: string,
    requestId: string,
    status: 'REJECTED' | 'CANCELLED',
    actorId: string,
    now: string,
  ) {
    const { rows } = await this.db.query(
      `UPDATE speaker_requests SET status = $3, resolved_at = $4, resolved_by = $5
       WHERE event_id = $1 AND id = $2 AND status = 'PENDING' RETURNING *`,
      [eventId, requestId, status, now, actorId],
    );
    return rows[0] ? toRequest(rows[0]) : null;
  }

  async revokeSpeaker(eventId: string, userId: string, actorId: string, now: string) {
    return this.db.transaction(async (tx) => {
      await this.lockCapacity(tx, eventId);
      const { rows } = await tx.query(
        `UPDATE speaker_requests SET status = 'REVOKED', resolved_at = $3, resolved_by = $4
         WHERE event_id = $1 AND user_id = $2 AND status = 'APPROVED' RETURNING *`,
        [eventId, userId, now, actorId],
      );
      if (!rows[0]) return null;
      await tx.query('UPDATE capacity SET speakers = GREATEST(speakers - 1, 0) WHERE event_id = $1', [eventId]);
      return toRequest(rows[0]);
    });
  }

  // ---------------------------------------------------------------- Stream sessions
  async putStreamSession(s: StreamSessionRecord) {
    await this.db.query(
      `INSERT INTO stream_sessions (id, event_id, started_at, started_by, ended_at, peak_participants)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (id) DO NOTHING`,
      [s.id, s.eventId, s.startedAt, s.startedBy, s.endedAt, s.peakParticipants],
    );
  }

  async endStreamSession(eventId: string, sessionId: string, endedAt: string, peak: number) {
    await this.db.query(
      `UPDATE stream_sessions SET ended_at = $3, peak_participants = GREATEST(peak_participants, $4)
       WHERE event_id = $1 AND id = $2`,
      [eventId, sessionId, endedAt, peak],
    );
  }

  // ---------------------------------------------------------------- Chat
  async putChatMessage(m: ChatMessageRecord) {
    await this.db.query(
      `INSERT INTO chat_messages (id, event_id, user_id, display_name, role, text, created_at, deleted, deleted_by, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, to_timestamp($10))`,
      [m.id, m.eventId, m.userId, m.displayName, m.role, m.text, m.createdAt, m.deleted, m.deletedBy, m.ttl],
    );
  }

  async listChatMessages(eventId: string, limit: number) {
    const { rows } = await this.db.query(
      'SELECT * FROM chat_messages WHERE event_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2',
      [eventId, limit],
    );
    return rows.map(toChat).reverse();
  }

  async markChatMessageDeleted(eventId: string, messageId: string, deletedBy: string) {
    const res = await this.db.query(
      `UPDATE chat_messages SET deleted = true, deleted_by = $3, text = '' WHERE event_id = $1 AND id = $2`,
      [eventId, messageId, deletedBy],
    );
    return res.rowCount > 0;
  }

  // ---------------------------------------------------------------- Recordings
  async createRecording(r: RecordingRecord) {
    await this.db.transaction(async (tx) => {
      const res = await tx.query(
        `UPDATE events SET active_recording_id = $2, version = version + 1
         WHERE id = $1 AND active_recording_id IS NULL`,
        [r.eventId, r.id],
      );
      if (res.rowCount === 0) throw new ConditionFailedError('recording already active');
      await tx.query(
        `INSERT INTO recordings (id, event_id, egress_id, status, s3_key, started_by, started_at, ended_at, duration_seconds, size_bytes, error)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [r.id, r.eventId, r.egressId, r.status, r.s3Key, r.startedBy, r.startedAt, r.endedAt, r.durationSeconds, r.sizeBytes, r.error],
      );
    });
  }

  async getRecording(eventId: string, recordingId: string) {
    const { rows } = await this.db.query('SELECT * FROM recordings WHERE event_id = $1 AND id = $2', [eventId, recordingId]);
    return rows[0] ? toRecording(rows[0]) : null;
  }

  async getRecordingByEgressId(egressId: string) {
    const { rows } = await this.db.query('SELECT * FROM recordings WHERE egress_id = $1', [egressId]);
    return rows[0] ? toRecording(rows[0]) : null;
  }

  async updateRecording(eventId: string, recordingId: string, changes: Partial<RecordingRecord>) {
    const params: unknown[] = [eventId, recordingId];
    const sets: string[] = [];
    for (const [key, value] of Object.entries(changes)) {
      if (value === undefined) continue;
      const column = RECORDING_COLUMNS[key];
      if (!column) throw new Error(`Field ${key} is not updatable`);
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    }
    if (sets.length === 0) {
      const current = await this.getRecording(eventId, recordingId);
      if (!current) throw new ConditionFailedError('recording missing');
      return current;
    }
    const { rows } = await this.db.query(
      `UPDATE recordings SET ${sets.join(', ')} WHERE event_id = $1 AND id = $2 RETURNING *`,
      params,
    );
    if (!rows[0]) throw new ConditionFailedError('recording missing');
    return toRecording(rows[0]);
  }

  async listRecordings(eventId: string) {
    const { rows } = await this.db.query('SELECT * FROM recordings WHERE event_id = $1 ORDER BY started_at DESC', [eventId]);
    return rows.map(toRecording);
  }

  // ---------------------------------------------------------------- Audit / rate limit / idempotency
  async putAudit(a: AuditRecord) {
    await this.db.query(
      `INSERT INTO audit_events (id, scope, action, actor_id, target_id, details, at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, to_timestamp($8))`,
      [a.id, a.scope, a.action, a.actorId, a.targetId, JSON.stringify(a.details), a.at, a.ttl],
    );
  }

  async listAudit(scope: string, limit: number) {
    const { rows } = await this.db.query('SELECT * FROM audit_events WHERE scope = $1 ORDER BY at DESC, id DESC LIMIT $2', [
      scope,
      limit,
    ]);
    return rows.map(toAudit);
  }

  async hitRateLimit(key: string, limit: number, windowSeconds: number, nowMs: number) {
    const win = Math.floor(nowMs / 1000 / windowSeconds);
    const { rows } = await this.db.query<{ count: number }>(
      `INSERT INTO rate_limits (key, win, count, expires_at) VALUES ($1, $2, 1, to_timestamp($3))
       ON CONFLICT (key, win) DO UPDATE SET count = rate_limits.count + 1
       RETURNING count`,
      [key, win, (win + 2) * windowSeconds],
    );
    return Number(rows[0]!.count) <= limit;
  }

  async getIdempotentResponse(key: string) {
    const { rows } = await this.db.query('SELECT status, body FROM idempotency_keys WHERE key = $1 AND expires_at > now()', [
      key,
    ]);
    if (!rows[0]) return null;
    const body = typeof rows[0].body === 'string' ? JSON.parse(rows[0].body) : rows[0].body;
    return { status: Number(rows[0].status), body };
  }

  async putIdempotentResponse(key: string, response: { status: number; body: unknown }, ttlSeconds: number) {
    await this.db.query(
      `INSERT INTO idempotency_keys (key, status, body, expires_at)
       VALUES ($1, $2, $3::jsonb, now() + make_interval(secs => $4)) ON CONFLICT (key) DO NOTHING`,
      [key, response.status, JSON.stringify(response.body), ttlSeconds],
    );
  }

  /** Replaces DynamoDB TTL: deletes expired chat, audit, rate-limit and idempotency rows. */
  async purgeExpired() {
    const results = await Promise.all([
      this.db.query('DELETE FROM chat_messages WHERE expires_at < now()'),
      this.db.query('DELETE FROM audit_events WHERE expires_at < now()'),
      this.db.query('DELETE FROM rate_limits WHERE expires_at < now()'),
      this.db.query('DELETE FROM idempotency_keys WHERE expires_at < now()'),
    ]);
    return results.reduce((sum, r) => sum + r.rowCount, 0);
  }

  async tryAcquireLease(name: string, owner: string, ttlSeconds: number) {
    const { rows } = await this.db.query(
      `INSERT INTO job_leases (name, owner, locked_until) VALUES ($1, $2, now() + make_interval(secs => $3))
       ON CONFLICT (name) DO UPDATE SET owner = EXCLUDED.owner, locked_until = EXCLUDED.locked_until
         WHERE job_leases.locked_until < now() OR job_leases.owner = EXCLUDED.owner
       RETURNING owner`,
      [name, owner, ttlSeconds],
    );
    return rows.length > 0;
  }
}
