import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  BatchGetCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
  type QueryCommandInput,
} from '@aws-sdk/lib-dynamodb';
import { ConditionFailedError } from '../lib/errors';
import { sha256 } from '../lib/ids';
import { keys, stripKeys } from './keys';
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

const isHost = (role: string) => role === 'ORGANIZER' || role === 'BROADCASTER';
const epoch = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);
const DAY = 86_400;

function errorName(err: unknown) {
  return (err as { name?: string })?.name;
}

/** Index of the first transaction item whose condition failed, or -1. */
function cancelledIndex(err: unknown): number {
  const reasons = (err as { CancellationReasons?: { Code?: string }[] }).CancellationReasons ?? [];
  return reasons.findIndex((r) => r.Code === 'ConditionalCheckFailed');
}

export class DynamoStore implements Store {
  private readonly doc: DynamoDBDocumentClient;

  constructor(
    private readonly tableName: string,
    client?: DynamoDBClient,
  ) {
    this.doc = DynamoDBDocumentClient.from(client ?? new DynamoDBClient({}), {
      marshallOptions: { removeUndefinedValues: true },
    });
  }

  private async get<T>(key: Record<string, string>, consistent = false): Promise<T | null> {
    const res = await this.doc.send(new GetCommand({ TableName: this.tableName, Key: key, ConsistentRead: consistent }));
    return stripKeys<T>(res.Item);
  }

  private async queryAll<T>(input: Omit<QueryCommandInput, 'TableName'>, max = 1000): Promise<T[]> {
    const items: T[] = [];
    let ExclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const res = await this.doc.send(new QueryCommand({ ...input, TableName: this.tableName, ExclusiveStartKey }));
      for (const item of res.Items ?? []) items.push(stripKeys<T>(item)!);
      ExclusiveStartKey = res.LastEvaluatedKey;
    } while (ExclusiveStartKey && items.length < max);
    return items;
  }

  private queryPrefix<T>(pk: string, skPrefix: string, opts: { forward?: boolean; limit?: number } = {}) {
    return this.queryAll<T>({
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: { ':pk': pk, ':sk': skPrefix },
      ScanIndexForward: opts.forward ?? true,
      Limit: opts.limit,
    });
  }

  // ---------------------------------------------------------------- Users
  async getUser(userId: string) {
    return this.get<UserRecord>(keys.user(userId));
  }

  async upsertUser(user: UserRecord) {
    await this.doc.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: keys.user(user.userId),
        UpdateExpression:
          'SET entity = :e, userId = :u, email = :email, displayName = :n, platformRole = :r, updatedAt = :now, createdAt = if_not_exists(createdAt, :now), GSI1PK = :g1pk, GSI1SK = :g1sk',
        ExpressionAttributeValues: {
          ':e': 'User',
          ':u': user.userId,
          ':email': user.email,
          ':n': user.displayName,
          ':r': user.platformRole,
          ':now': user.updatedAt,
          ':g1pk': keys.userEmailIndex(user.email).GSI1PK,
          ':g1sk': 'USER',
        },
      }),
    );
  }

  async putDevice(device: DeviceRecord) {
    await this.doc.send(
      new PutCommand({
        TableName: this.tableName,
        Item: { ...keys.device(device.userId, sha256(device.pushToken)), entity: 'Device', ...device },
      }),
    );
  }

  async listDevices(userId: string) {
    return this.queryPrefix<DeviceRecord>(`USER#${userId}`, 'DEVICE#');
  }

  // ---------------------------------------------------------------- Events
  private eventItem(event: EventRecord) {
    return {
      ...keys.event(event.id),
      ...keys.eventByOrganizer(event.organizerId, event.startAt, event.id),
      ...keys.eventByStatus(event.status, event.startAt, event.id),
      entity: 'Event',
      ...event,
    };
  }

  private memberItem(m: MemberRecord) {
    return {
      ...keys.member(m.eventId, m.userId),
      ...keys.memberByUser(m.userId, m.eventStartAt, m.eventId),
      entity: 'Member',
      ...m,
    };
  }

  async createEvent(event: EventRecord, organizer: MemberRecord) {
    await this.doc.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: this.tableName,
              Item: this.eventItem(event),
              ConditionExpression: 'attribute_not_exists(PK)',
            },
          },
          { Put: { TableName: this.tableName, Item: this.memberItem(organizer) } },
          {
            Put: {
              TableName: this.tableName,
              Item: { ...keys.capacity(event.id), entity: 'Capacity', eventId: event.id, total: 0, hosts: 0, speakers: 0 },
            },
          },
        ],
      }),
    );
  }

  async getEvent(eventId: string) {
    return this.get<EventRecord>(keys.event(eventId), true);
  }

  async updateEvent(
    eventId: string,
    changes: Partial<Omit<EventRecord, 'id' | 'version'>>,
    opts: { ifStatusIn?: EventRecord['status'][]; ifActiveRecordingId?: string | null } = {},
  ) {
    const names: Record<string, string> = { '#version': 'version' };
    const values: Record<string, unknown> = { ':one': 1 };
    const sets: string[] = [];
    const entries = Object.entries(changes).filter(([, v]) => v !== undefined);
    entries.forEach(([k, v], i) => {
      names[`#f${i}`] = k;
      values[`:v${i}`] = v;
      sets.push(`#f${i} = :v${i}`);
    });
    if (changes.status) {
      names['#g2pk'] = 'GSI2PK';
      values[':g2pk'] = `STATUS#${changes.status}`;
      sets.push('#g2pk = :g2pk');
    }
    if (changes.startAt) {
      names['#g1sk'] = 'GSI1SK';
      names['#g2sk'] = 'GSI2SK';
      values[':gsk'] = `${changes.startAt}#${eventId}`;
      sets.push('#g1sk = :gsk', '#g2sk = :gsk');
    }
    const conditions = ['attribute_exists(PK)'];
    if (opts.ifStatusIn) {
      names['#status'] = 'status';
      const placeholders = opts.ifStatusIn.map((s, i) => {
        values[`:s${i}`] = s;
        return `:s${i}`;
      });
      conditions.push(`#status IN (${placeholders.join(', ')})`);
    }
    if (opts.ifActiveRecordingId !== undefined) {
      names['#arid'] = 'activeRecordingId';
      if (opts.ifActiveRecordingId === null) {
        conditions.push('(attribute_not_exists(#arid) OR #arid = :null)');
        values[':null'] = null;
      } else {
        conditions.push('#arid = :arid');
        values[':arid'] = opts.ifActiveRecordingId;
      }
    }
    try {
      const res = await this.doc.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: keys.event(eventId),
          UpdateExpression: `SET ${[...sets].join(', ')}${sets.length ? ',' : ''} #version = #version + :one`,
          ConditionExpression: conditions.join(' AND '),
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
          ReturnValues: 'ALL_NEW',
        }),
      );
      const updated = stripKeys<EventRecord>(res.Attributes)!;
      if (changes.startAt) await this.reindexMembers(eventId, changes.startAt);
      return updated;
    } catch (err) {
      if (errorName(err) === 'ConditionalCheckFailedException') throw new ConditionFailedError('event condition');
      throw err;
    }
  }

  private async reindexMembers(eventId: string, startAt: string) {
    const members = await this.listMembers(eventId);
    await Promise.all(
      members.map((m) =>
        this.doc.send(
          new UpdateCommand({
            TableName: this.tableName,
            Key: keys.member(eventId, m.userId),
            UpdateExpression: 'SET eventStartAt = :s, GSI1SK = :g',
            ExpressionAttributeValues: { ':s': startAt, ':g': `${startAt}#${eventId}` },
          }),
        ),
      ),
    );
  }

  async listEventsByOrganizer(organizerId: string) {
    return this.queryAll<EventRecord>({
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :pk',
      ExpressionAttributeValues: { ':pk': `ORG#${organizerId}` },
    });
  }

  async listEventsByStatus(status: EventRecord['status']) {
    return this.queryAll<EventRecord>({
      IndexName: 'GSI2',
      KeyConditionExpression: 'GSI2PK = :pk',
      ExpressionAttributeValues: { ':pk': `STATUS#${status}` },
    });
  }

  async batchGetEvents(ids: string[]) {
    const unique = [...new Set(ids)];
    const out: EventRecord[] = [];
    for (let i = 0; i < unique.length; i += 100) {
      let request: Record<string, { Keys: Record<string, string>[] }> | undefined = {
        [this.tableName]: { Keys: unique.slice(i, i + 100).map((id) => keys.event(id)) },
      };
      for (let attempt = 0; request && attempt < 5; attempt++) {
        const res = await this.doc.send(new BatchGetCommand({ RequestItems: request }));
        for (const item of res.Responses?.[this.tableName] ?? []) out.push(stripKeys<EventRecord>(item)!);
        const unprocessed = res.UnprocessedKeys?.[this.tableName]?.Keys as Record<string, string>[] | undefined;
        request = unprocessed?.length ? { [this.tableName]: { Keys: unprocessed } } : undefined;
        if (request) await new Promise((r) => setTimeout(r, 50 * 2 ** attempt));
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- Members
  async getMember(eventId: string, userId: string) {
    return this.get<MemberRecord>(keys.member(eventId, userId), true);
  }

  async putMember(member: MemberRecord) {
    await this.doc.send(new PutCommand({ TableName: this.tableName, Item: this.memberItem(member) }));
  }

  async listMembers(eventId: string) {
    return this.queryPrefix<MemberRecord>(`EVENT#${eventId}`, 'MEMBER#');
  }

  async listMembershipsForUser(userId: string) {
    return this.queryAll<MemberRecord>({
      IndexName: 'GSI1',
      KeyConditionExpression: 'GSI1PK = :pk',
      ExpressionAttributeValues: { ':pk': `MEMBER#${userId}` },
    });
  }

  // ---------------------------------------------------------------- Invitations
  async createInvitations(invitations: InvitationRecord[]) {
    // TransactWrite accepts up to 100 items; invitesPerRequest is capped at 50.
    await this.doc.send(
      new TransactWriteCommand({
        TransactItems: invitations.map((inv) => ({
          Put: {
            TableName: this.tableName,
            Item: {
              ...keys.invitation(inv.eventId, inv.id),
              ...keys.invitationByToken(inv.tokenHash),
              entity: 'Invitation',
              ...inv,
              // Keep expired/used invitations for 30 days for audit, then let TTL remove them.
              ttl: epoch(inv.expiresAt) + 30 * DAY,
            },
            ConditionExpression: 'attribute_not_exists(PK)',
          },
        })),
      }),
    );
  }

  async listInvitations(eventId: string) {
    return this.queryPrefix<InvitationRecord>(`EVENT#${eventId}`, 'INVITE#');
  }

  async getInvitation(eventId: string, invitationId: string) {
    return this.get<InvitationRecord>(keys.invitation(eventId, invitationId), true);
  }

  async getInvitationByTokenHash(tokenHash: string) {
    const items = await this.queryAll<InvitationRecord>({
      IndexName: 'GSI2',
      KeyConditionExpression: 'GSI2PK = :pk',
      ExpressionAttributeValues: { ':pk': `INVTOKEN#${tokenHash}` },
      Limit: 1,
    });
    if (!items[0]) return null;
    // GSIs are eventually consistent; re-read the base item for the authoritative status.
    return this.getInvitation(items[0].eventId, items[0].id);
  }

  async acceptInvitation(invitation: InvitationRecord, member: MemberRecord, now: string) {
    try {
      await this.doc.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: this.tableName,
                Key: keys.invitation(invitation.eventId, invitation.id),
                UpdateExpression: 'SET #status = :accepted, acceptedAt = :now, acceptedBy = :uid',
                ConditionExpression: '#status = :pending AND expiresAt > :now',
                ExpressionAttributeNames: { '#status': 'status' },
                ExpressionAttributeValues: {
                  ':accepted': 'ACCEPTED',
                  ':pending': 'PENDING',
                  ':now': now,
                  ':uid': member.userId,
                },
              },
            },
            { Put: { TableName: this.tableName, Item: this.memberItem(member) } },
          ],
        }),
      );
    } catch (err) {
      if (errorName(err) === 'TransactionCanceledException') throw new ConditionFailedError('invitation not pending');
      throw err;
    }
  }

  async setInvitationStatus(
    eventId: string,
    invitationId: string,
    status: InvitationRecord['status'],
    ifStatus: InvitationRecord['status'],
  ) {
    try {
      await this.doc.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: keys.invitation(eventId, invitationId),
          UpdateExpression: 'SET #status = :s',
          ConditionExpression: '#status = :if',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: { ':s': status, ':if': ifStatus },
        }),
      );
    } catch (err) {
      if (errorName(err) === 'ConditionalCheckFailedException') throw new ConditionFailedError('invitation status');
      throw err;
    }
  }

  // ---------------------------------------------------------------- Capacity
  async admitParticipant(
    eventId: string,
    userId: string,
    role: MemberRecord['role'],
    maxParticipants: number,
    now: string,
  ): Promise<AdmitResult> {
    const host = isHost(role);
    // One slot stays reserved for the first host so a full audience can never lock out the broadcaster.
    const capacityCondition = host
      ? '(attribute_not_exists(#total) OR #total < :max OR attribute_not_exists(#hosts) OR #hosts = :zero)'
      : '((attribute_not_exists(#hosts) OR #hosts = :zero) AND (attribute_not_exists(#total) OR #total < :maxMinusOne)) OR (#hosts > :zero AND #total < :max)';
    const values: Record<string, unknown> = { ':one': 1, ':zero': 0, ':max': maxParticipants };
    if (!host) values[':maxMinusOne'] = maxParticipants - 1;
    try {
      await this.doc.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.tableName,
                Item: {
                  ...keys.participant(eventId, userId),
                  entity: 'ParticipantSession',
                  eventId,
                  userId,
                  role,
                  state: 'ADMITTED',
                  admittedAt: now,
                  connectedAt: null,
                  leftAt: null,
                  livekitSid: null,
                  ttl: epoch(now) + 90 * DAY,
                } satisfies ParticipantSessionRecord & Record<string, unknown>,
                ConditionExpression: 'attribute_not_exists(PK) OR #state = :left',
                ExpressionAttributeNames: { '#state': 'state' },
                ExpressionAttributeValues: { ':left': 'LEFT' },
              },
            },
            {
              Update: {
                TableName: this.tableName,
                Key: keys.capacity(eventId),
                UpdateExpression: host
                  ? 'SET eventId = :eid ADD #total :one, #hosts :one'
                  : 'SET eventId = :eid ADD #total :one',
                ConditionExpression: capacityCondition,
                ExpressionAttributeNames: host ? { '#total': 'total', '#hosts': 'hosts' } : { '#total': 'total', '#hosts': 'hosts' },
                ExpressionAttributeValues: { ...values, ':eid': eventId },
              },
            },
          ],
        }),
      );
      return { status: 'admitted' };
    } catch (err) {
      if (errorName(err) !== 'TransactionCanceledException') throw err;
      const idx = cancelledIndex(err);
      if (idx === 0) return { status: 'already_admitted' };
      if (idx === 1) return { status: 'full' };
      throw err;
    }
  }

  async releaseParticipant(eventId: string, userId: string, now: string) {
    const session = await this.getParticipantSession(eventId, userId);
    if (!session || session.state === 'LEFT') return false;
    const host = isHost(session.role);
    try {
      await this.doc.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: this.tableName,
                Key: keys.participant(eventId, userId),
                UpdateExpression: 'SET #state = :left, leftAt = :now',
                ConditionExpression: '#state <> :left',
                ExpressionAttributeNames: { '#state': 'state' },
                ExpressionAttributeValues: { ':left': 'LEFT', ':now': now },
              },
            },
            {
              Update: {
                TableName: this.tableName,
                Key: keys.capacity(eventId),
                UpdateExpression: host ? 'ADD #total :neg, #hosts :neg' : 'ADD #total :neg',
                ConditionExpression: host ? '#total > :zero AND #hosts > :zero' : '#total > :zero',
                ExpressionAttributeNames: host ? { '#total': 'total', '#hosts': 'hosts' } : { '#total': 'total' },
                ExpressionAttributeValues: { ':neg': -1, ':zero': 0 },
              },
            },
          ],
        }),
      );
      return true;
    } catch (err) {
      if (errorName(err) === 'TransactionCanceledException') {
        // Session already LEFT (concurrent release) or counter drifted; reconciliation repairs counters.
        if (cancelledIndex(err) === 1) {
          await this.doc.send(
            new UpdateCommand({
              TableName: this.tableName,
              Key: keys.participant(eventId, userId),
              UpdateExpression: 'SET #state = :left, leftAt = :now',
              ExpressionAttributeNames: { '#state': 'state' },
              ExpressionAttributeValues: { ':left': 'LEFT', ':now': now },
            }),
          );
        }
        return false;
      }
      throw err;
    }
  }

  async markParticipantConnected(eventId: string, userId: string, livekitSid: string, now: string) {
    try {
      await this.doc.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: keys.participant(eventId, userId),
          UpdateExpression: 'SET #state = :c, connectedAt = :now, livekitSid = :sid',
          ConditionExpression: 'attribute_exists(PK) AND #state <> :left',
          ExpressionAttributeNames: { '#state': 'state' },
          ExpressionAttributeValues: { ':c': 'CONNECTED', ':now': now, ':sid': livekitSid, ':left': 'LEFT' },
        }),
      );
    } catch (err) {
      if (errorName(err) !== 'ConditionalCheckFailedException') throw err;
    }
  }

  async getParticipantSession(eventId: string, userId: string) {
    return this.get<ParticipantSessionRecord>(keys.participant(eventId, userId), true);
  }

  async listParticipantSessions(eventId: string) {
    return this.queryPrefix<ParticipantSessionRecord>(`EVENT#${eventId}`, 'PSESSION#');
  }

  async getCapacity(eventId: string): Promise<CapacityRecord> {
    const c = await this.get<CapacityRecord>(keys.capacity(eventId), true);
    return { eventId, total: c?.total ?? 0, hosts: c?.hosts ?? 0, speakers: c?.speakers ?? 0 };
  }

  async resetCapacity(capacity: CapacityRecord) {
    await this.doc.send(
      new PutCommand({ TableName: this.tableName, Item: { ...keys.capacity(capacity.eventId), entity: 'Capacity', ...capacity } }),
    );
  }

  // ---------------------------------------------------------------- Speaker requests
  async createSpeakerRequest(request: SpeakerRequestRecord) {
    try {
      await this.doc.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.tableName,
                Item: { ...keys.handLock(request.eventId, request.userId), entity: 'HandLock', requestId: request.id },
                ConditionExpression: 'attribute_not_exists(PK)',
              },
            },
            {
              Put: {
                TableName: this.tableName,
                Item: { ...keys.speakerRequest(request.eventId, request.id), entity: 'SpeakerRequest', ...request },
              },
            },
          ],
        }),
      );
      return { created: true, request };
    } catch (err) {
      if (errorName(err) !== 'TransactionCanceledException') throw err;
      const open = await this.getOpenSpeakerRequest(request.eventId, request.userId);
      if (!open) throw new ConditionFailedError('hand lock without request');
      return { created: false, request: open };
    }
  }

  async getSpeakerRequest(eventId: string, requestId: string) {
    return this.get<SpeakerRequestRecord>(keys.speakerRequest(eventId, requestId), true);
  }

  async getOpenSpeakerRequest(eventId: string, userId: string) {
    const lock = await this.get<{ requestId: string }>(keys.handLock(eventId, userId), true);
    return lock ? this.getSpeakerRequest(eventId, lock.requestId) : null;
  }

  async listSpeakerRequests(eventId: string) {
    return this.queryPrefix<SpeakerRequestRecord>(`EVENT#${eventId}`, 'SPKREQ#');
  }

  async approveSpeakerRequest(
    eventId: string,
    requestId: string,
    maxSpeakers: number,
    approverId: string,
    now: string,
  ): Promise<ApproveResult> {
    try {
      await this.doc.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: this.tableName,
                Key: keys.speakerRequest(eventId, requestId),
                UpdateExpression: 'SET #status = :approved, resolvedAt = :now, resolvedBy = :by',
                ConditionExpression: '#status = :pending',
                ExpressionAttributeNames: { '#status': 'status' },
                ExpressionAttributeValues: { ':approved': 'APPROVED', ':pending': 'PENDING', ':now': now, ':by': approverId },
              },
            },
            {
              Update: {
                TableName: this.tableName,
                Key: keys.capacity(eventId),
                UpdateExpression: 'ADD speakers :one',
                ConditionExpression: 'attribute_not_exists(speakers) OR speakers < :max',
                ExpressionAttributeValues: { ':one': 1, ':max': maxSpeakers },
              },
            },
          ],
        }),
      );
      return { status: 'approved', request: (await this.getSpeakerRequest(eventId, requestId))! };
    } catch (err) {
      if (errorName(err) !== 'TransactionCanceledException') throw err;
      if (cancelledIndex(err) === 1) return { status: 'speaker_limit' };
      return { status: 'not_pending', request: await this.getSpeakerRequest(eventId, requestId) };
    }
  }

  async closePendingSpeakerRequest(
    eventId: string,
    requestId: string,
    status: 'REJECTED' | 'CANCELLED',
    actorId: string,
    now: string,
  ) {
    const req = await this.getSpeakerRequest(eventId, requestId);
    if (!req || req.status !== 'PENDING') return null;
    try {
      await this.doc.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: this.tableName,
                Key: keys.speakerRequest(eventId, requestId),
                UpdateExpression: 'SET #status = :s, resolvedAt = :now, resolvedBy = :by',
                ConditionExpression: '#status = :pending',
                ExpressionAttributeNames: { '#status': 'status' },
                ExpressionAttributeValues: { ':s': status, ':pending': 'PENDING', ':now': now, ':by': actorId },
              },
            },
            {
              Delete: {
                TableName: this.tableName,
                Key: keys.handLock(eventId, req.userId),
                ConditionExpression: 'requestId = :rid',
                ExpressionAttributeValues: { ':rid': requestId },
              },
            },
          ],
        }),
      );
      return { ...req, status, resolvedAt: now, resolvedBy: actorId };
    } catch (err) {
      if (errorName(err) === 'TransactionCanceledException') return null;
      throw err;
    }
  }

  async revokeSpeaker(eventId: string, userId: string, actorId: string, now: string) {
    const req = await this.getOpenSpeakerRequest(eventId, userId);
    if (!req || req.status !== 'APPROVED') return null;
    try {
      await this.doc.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: this.tableName,
                Key: keys.speakerRequest(eventId, req.id),
                UpdateExpression: 'SET #status = :revoked, resolvedAt = :now, resolvedBy = :by',
                ConditionExpression: '#status = :approved',
                ExpressionAttributeNames: { '#status': 'status' },
                ExpressionAttributeValues: { ':revoked': 'REVOKED', ':approved': 'APPROVED', ':now': now, ':by': actorId },
              },
            },
            { Delete: { TableName: this.tableName, Key: keys.handLock(eventId, userId) } },
            {
              Update: {
                TableName: this.tableName,
                Key: keys.capacity(eventId),
                UpdateExpression: 'ADD speakers :neg',
                ConditionExpression: 'speakers > :zero',
                ExpressionAttributeValues: { ':neg': -1, ':zero': 0 },
              },
            },
          ],
        }),
      );
      return { ...req, status: 'REVOKED' as const, resolvedAt: now, resolvedBy: actorId };
    } catch (err) {
      if (errorName(err) === 'TransactionCanceledException') return null;
      throw err;
    }
  }

  // ---------------------------------------------------------------- Stream sessions
  async putStreamSession(session: StreamSessionRecord) {
    await this.doc.send(
      new PutCommand({
        TableName: this.tableName,
        Item: { ...keys.stream(session.eventId, session.id), entity: 'StreamSession', ...session },
      }),
    );
  }

  async endStreamSession(eventId: string, sessionId: string, endedAt: string, peak: number) {
    await this.doc.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: keys.stream(eventId, sessionId),
        UpdateExpression: 'SET endedAt = :e, peakParticipants = :p',
        ConditionExpression: 'attribute_exists(PK)',
        ExpressionAttributeValues: { ':e': endedAt, ':p': peak },
      }),
    ).catch((err: unknown) => {
      if (errorName(err) !== 'ConditionalCheckFailedException') throw err;
    });
  }

  // ---------------------------------------------------------------- Chat
  async putChatMessage(message: ChatMessageRecord) {
    await this.doc.send(
      new PutCommand({
        TableName: this.tableName,
        Item: { ...keys.chat(message.eventId, message.id), entity: 'ChatMessage', ...message },
      }),
    );
  }

  async listChatMessages(eventId: string, limit: number) {
    const items = await this.queryAll<ChatMessageRecord>(
      {
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: { ':pk': `EVENT#${eventId}#CHAT` },
        ScanIndexForward: false,
        Limit: limit,
      },
      limit,
    );
    return items.slice(0, limit).reverse();
  }

  async markChatMessageDeleted(eventId: string, messageId: string, deletedBy: string) {
    try {
      await this.doc.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: keys.chat(eventId, messageId),
          UpdateExpression: 'SET deleted = :t, deletedBy = :by, #text = :empty',
          ConditionExpression: 'attribute_exists(PK)',
          ExpressionAttributeNames: { '#text': 'text' },
          ExpressionAttributeValues: { ':t': true, ':by': deletedBy, ':empty': '' },
        }),
      );
      return true;
    } catch (err) {
      if (errorName(err) === 'ConditionalCheckFailedException') return false;
      throw err;
    }
  }

  // ---------------------------------------------------------------- Recordings
  private recordingItem(r: RecordingRecord) {
    return {
      ...keys.recording(r.eventId, r.id),
      ...(r.egressId ? keys.recordingByEgress(r.egressId) : {}),
      entity: 'Recording',
      ...r,
    };
  }

  async createRecording(recording: RecordingRecord) {
    try {
      await this.doc.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: this.tableName,
                Key: keys.event(recording.eventId),
                UpdateExpression: 'SET activeRecordingId = :rid ADD #version :one',
                ConditionExpression: 'attribute_exists(PK) AND (attribute_not_exists(activeRecordingId) OR activeRecordingId = :null)',
                ExpressionAttributeNames: { '#version': 'version' },
                ExpressionAttributeValues: { ':rid': recording.id, ':null': null, ':one': 1 },
              },
            },
            { Put: { TableName: this.tableName, Item: this.recordingItem(recording) } },
          ],
        }),
      );
    } catch (err) {
      if (errorName(err) === 'TransactionCanceledException') throw new ConditionFailedError('recording already active');
      throw err;
    }
  }

  async getRecording(eventId: string, recordingId: string) {
    return this.get<RecordingRecord>(keys.recording(eventId, recordingId), true);
  }

  async getRecordingByEgressId(egressId: string) {
    const items = await this.queryAll<RecordingRecord>({
      IndexName: 'GSI2',
      KeyConditionExpression: 'GSI2PK = :pk',
      ExpressionAttributeValues: { ':pk': `EGRESS#${egressId}` },
      Limit: 1,
    });
    return items[0] ? this.getRecording(items[0].eventId, items[0].id) : null;
  }

  async updateRecording(eventId: string, recordingId: string, changes: Partial<RecordingRecord>) {
    const names: Record<string, string> = {};
    const values: Record<string, unknown> = {};
    const sets: string[] = [];
    Object.entries(changes)
      .filter(([, v]) => v !== undefined)
      .forEach(([k, v], i) => {
        names[`#f${i}`] = k;
        values[`:v${i}`] = v;
        sets.push(`#f${i} = :v${i}`);
      });
    if (changes.egressId) {
      names['#g2pk'] = 'GSI2PK';
      names['#g2sk'] = 'GSI2SK';
      values[':g2pk'] = `EGRESS#${changes.egressId}`;
      values[':g2sk'] = 'REC';
      sets.push('#g2pk = :g2pk', '#g2sk = :g2sk');
    }
    const res = await this.doc.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: keys.recording(eventId, recordingId),
        UpdateExpression: `SET ${sets.join(', ')}`,
        ConditionExpression: 'attribute_exists(PK)',
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ReturnValues: 'ALL_NEW',
      }),
    );
    return stripKeys<RecordingRecord>(res.Attributes)!;
  }

  async listRecordings(eventId: string) {
    return this.queryPrefix<RecordingRecord>(`EVENT#${eventId}`, 'REC#', { forward: false });
  }

  // ---------------------------------------------------------------- Audit / rate limit / idempotency
  async putAudit(record: AuditRecord) {
    await this.doc.send(
      new PutCommand({
        TableName: this.tableName,
        Item: { ...keys.audit(record.scope, record.at, record.id), entity: 'Audit', ...record },
      }),
    );
  }

  async listAudit(scope: string, limit: number) {
    return this.queryAll<AuditRecord>(
      {
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: { ':pk': `AUDIT#${scope}` },
        ScanIndexForward: false,
        Limit: limit,
      },
      limit,
    );
  }

  async hitRateLimit(key: string, limit: number, windowSeconds: number, nowMs: number) {
    const window = Math.floor(nowMs / 1000 / windowSeconds);
    try {
      await this.doc.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: keys.rate(key, window),
          UpdateExpression: 'ADD #count :one SET #ttl = if_not_exists(#ttl, :ttl)',
          ConditionExpression: 'attribute_not_exists(#count) OR #count < :limit',
          ExpressionAttributeNames: { '#count': 'count', '#ttl': 'ttl' },
          ExpressionAttributeValues: {
            ':one': 1,
            ':limit': limit,
            ':ttl': (window + 2) * windowSeconds,
          },
        }),
      );
      return true;
    } catch (err) {
      if (errorName(err) === 'ConditionalCheckFailedException') return false;
      throw err;
    }
  }

  async getIdempotentResponse(key: string) {
    const item = await this.get<{ response: { status: number; body: unknown } }>(keys.idempotency(key), true);
    return item?.response ?? null;
  }

  async putIdempotentResponse(key: string, response: { status: number; body: unknown }, ttlSeconds: number) {
    await this.doc.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          ...keys.idempotency(key),
          entity: 'Idempotency',
          response,
          ttl: Math.floor(Date.now() / 1000) + ttlSeconds,
        },
        ConditionExpression: 'attribute_not_exists(PK)',
      }),
    ).catch((err: unknown) => {
      if (errorName(err) !== 'ConditionalCheckFailedException') throw err;
    });
  }
}
