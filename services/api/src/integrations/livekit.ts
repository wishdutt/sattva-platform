import {
  AccessToken,
  DataPacket_Kind,
  EgressClient,
  EncodedFileOutput,
  EncodedFileType,
  RoomServiceClient,
  S3Upload,
  TrackSource,
  WebhookReceiver,
  type VideoGrant,
} from 'livekit-server-sdk';

export type PublishSource = 'camera' | 'microphone' | 'screen_share' | 'screen_share_audio';

export interface ParticipantGrant {
  canPublish: boolean;
  canPublishSources: PublishSource[];
  canSubscribe: boolean;
  /** Always false: clients never publish data; chat/reactions are relayed by the backend. */
  canPublishData: false;
}

export interface TokenRequest {
  roomName: string;
  identity: string;
  name: string;
  metadata: string;
  grant: ParticipantGrant;
  ttlSeconds: number;
}

export interface LiveParticipant {
  identity: string;
  sid: string;
  joinedAt: number;
}

export interface NormalizedWebhookEvent {
  event: string;
  id: string;
  createdAt: number;
  roomName?: string;
  participantIdentity?: string;
  participantSid?: string;
  egress?: {
    egressId: string;
    status: 'starting' | 'active' | 'ending' | 'complete' | 'failed' | 'aborted' | 'other';
    error?: string;
    durationSeconds?: number;
    sizeBytes?: number;
  };
}

export interface RecordingTarget {
  filepath: string;
  s3: { bucket: string; region: string; accessKey: string; secret: string };
}

/** Port over LiveKit Cloud. The real adapter uses livekit-server-sdk; tests use MockLiveKit. */
export interface LiveKitGateway {
  readonly serverUrl: string;
  createToken(req: TokenRequest): Promise<string>;
  ensureRoom(roomName: string, maxParticipants: number, metadata: string): Promise<void>;
  deleteRoom(roomName: string): Promise<void>;
  listParticipants(roomName: string): Promise<LiveParticipant[]>;
  updateParticipant(roomName: string, identity: string, grant: ParticipantGrant, metadata: string): Promise<void>;
  removeParticipant(roomName: string, identity: string): Promise<void>;
  sendData(roomName: string, payload: unknown, topic: string, destinationIdentities?: string[]): Promise<void>;
  startRecording(roomName: string, target: RecordingTarget): Promise<{ egressId: string }>;
  stopRecording(egressId: string): Promise<void>;
  verifyWebhook(body: string, authorization: string | undefined): Promise<NormalizedWebhookEvent>;
}

const SOURCE_MAP: Record<PublishSource, TrackSource> = {
  camera: TrackSource.CAMERA,
  microphone: TrackSource.MICROPHONE,
  screen_share: TrackSource.SCREEN_SHARE,
  screen_share_audio: TrackSource.SCREEN_SHARE_AUDIO,
};

const encoder = new TextEncoder();

const isNotFound = (err: unknown) => {
  const e = err as { status?: number; code?: string; message?: string };
  return e?.status === 404 || e?.code === 'not_found' || /not.?found|does not exist/i.test(e?.message ?? '');
};

export class LiveKitCloudGateway implements LiveKitGateway {
  private readonly rooms: RoomServiceClient;
  private readonly egress: EgressClient;
  private readonly webhooks: WebhookReceiver;

  constructor(
    readonly serverUrl: string,
    private readonly apiKey: string,
    private readonly apiSecret: string,
  ) {
    const host = serverUrl.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
    this.rooms = new RoomServiceClient(host, apiKey, apiSecret);
    this.egress = new EgressClient(host, apiKey, apiSecret);
    this.webhooks = new WebhookReceiver(apiKey, apiSecret);
  }

  async createToken(req: TokenRequest) {
    const at = new AccessToken(this.apiKey, this.apiSecret, {
      identity: req.identity,
      name: req.name,
      metadata: req.metadata,
      ttl: req.ttlSeconds,
    });
    const grant: VideoGrant = {
      room: req.roomName,
      roomJoin: true,
      roomCreate: false,
      roomAdmin: false,
      roomList: false,
      canSubscribe: req.grant.canSubscribe,
      canPublish: req.grant.canPublish,
      canPublishData: req.grant.canPublishData,
      // The SDK serializes TrackSource enums to "camera" | "microphone" | ... in the JWT.
      canPublishSources: req.grant.canPublishSources.map((s) => SOURCE_MAP[s]),
      canUpdateOwnMetadata: false,
    };
    at.addGrant(grant);
    return at.toJwt();
  }

  async ensureRoom(roomName: string, maxParticipants: number, metadata: string) {
    // createRoom is idempotent for an existing room name.
    await this.rooms.createRoom({
      name: roomName,
      maxParticipants,
      emptyTimeout: 10 * 60,
      departureTimeout: 60,
      metadata,
    });
  }

  async deleteRoom(roomName: string) {
    try {
      await this.rooms.deleteRoom(roomName);
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }

  async listParticipants(roomName: string) {
    try {
      const list = await this.rooms.listParticipants(roomName);
      return list.map((p) => ({ identity: p.identity, sid: p.sid, joinedAt: Number(p.joinedAt) }));
    } catch (err) {
      if (isNotFound(err)) return [];
      throw err;
    }
  }

  async updateParticipant(roomName: string, identity: string, grant: ParticipantGrant, metadata: string) {
    try {
      await this.rooms.updateParticipant(roomName, identity, {
        metadata,
        permission: {
          canPublish: grant.canPublish,
          canSubscribe: grant.canSubscribe,
          canPublishData: grant.canPublishData,
          canPublishSources: grant.canPublishSources.map((s) => SOURCE_MAP[s]),
          canUpdateMetadata: false,
        },
      });
    } catch (err) {
      // Participant may not be connected right now; the next join token carries the new grant.
      if (!isNotFound(err)) throw err;
    }
  }

  async removeParticipant(roomName: string, identity: string) {
    try {
      await this.rooms.removeParticipant(roomName, identity);
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }

  async sendData(roomName: string, payload: unknown, topic: string, destinationIdentities?: string[]) {
    try {
      await this.rooms.sendData(roomName, encoder.encode(JSON.stringify(payload)), DataPacket_Kind.RELIABLE, {
        topic,
        destinationIdentities,
      });
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }

  async startRecording(roomName: string, target: RecordingTarget) {
    const output = new EncodedFileOutput({
      fileType: EncodedFileType.MP4,
      filepath: target.filepath,
      output: {
        case: 's3',
        value: new S3Upload({
          bucket: target.s3.bucket,
          region: target.s3.region,
          accessKey: target.s3.accessKey,
          secret: target.s3.secret,
        }),
      },
    });
    const info = await this.egress.startRoomCompositeEgress(roomName, { file: output }, { layout: 'speaker' });
    return { egressId: info.egressId };
  }

  async stopRecording(egressId: string) {
    await this.egress.stopEgress(egressId);
  }

  async verifyWebhook(body: string, authorization: string | undefined) {
    // Throws if the JWT signature, api key, or body hash (sha256 claim) do not match.
    const evt = await this.webhooks.receive(body, authorization);
    const egressInfo = evt.egressInfo;
    let egress: NormalizedWebhookEvent['egress'];
    if (egressInfo) {
      // EgressStatus enum: 0 STARTING, 1 ACTIVE, 2 ENDING, 3 COMPLETE, 4 FAILED, 5 ABORTED, 6 LIMIT_REACHED
      const statusMap = ['starting', 'active', 'ending', 'complete', 'failed', 'aborted', 'failed'] as const;
      const file = egressInfo.fileResults?.[0];
      egress = {
        egressId: egressInfo.egressId,
        status: statusMap[Number(egressInfo.status)] ?? 'other',
        error: egressInfo.error || undefined,
        durationSeconds: file?.duration ? Math.round(Number(file.duration) / 1e9) : undefined,
        sizeBytes: file?.size ? Number(file.size) : undefined,
      };
    }
    return {
      event: evt.event,
      id: evt.id,
      createdAt: Number(evt.createdAt),
      roomName: evt.room?.name ?? egressInfo?.roomName,
      participantIdentity: evt.participant?.identity,
      participantSid: evt.participant?.sid,
      egress,
    };
  }
}

/**
 * MOCK — used by unit tests and local development without LiveKit credentials.
 * Tokens it issues are NOT valid for any LiveKit server.
 */
export class MockLiveKit implements LiveKitGateway {
  readonly serverUrl: string = 'ws://mock-livekit.invalid';
  calls: { method: string; args: unknown[] }[] = [];
  participants = new Map<string, LiveParticipant[]>();
  private egressSeq = 0;

  private record(method: string, ...args: unknown[]) {
    this.calls.push({ method, args });
  }

  callsTo(method: string) {
    return this.calls.filter((c) => c.method === method);
  }

  async createToken(req: TokenRequest) {
    this.record('createToken', req);
    return `mock.${Buffer.from(JSON.stringify(req)).toString('base64url')}`;
  }
  async ensureRoom(roomName: string, maxParticipants: number, metadata: string) {
    this.record('ensureRoom', roomName, maxParticipants, metadata);
  }
  async deleteRoom(roomName: string) {
    this.record('deleteRoom', roomName);
    this.participants.delete(roomName);
  }
  async listParticipants(roomName: string) {
    return this.participants.get(roomName) ?? [];
  }
  async updateParticipant(roomName: string, identity: string, grant: ParticipantGrant, metadata: string) {
    this.record('updateParticipant', roomName, identity, grant, metadata);
  }
  async removeParticipant(roomName: string, identity: string) {
    this.record('removeParticipant', roomName, identity);
  }
  async sendData(roomName: string, payload: unknown, topic: string, destinationIdentities?: string[]) {
    this.record('sendData', roomName, payload, topic, destinationIdentities);
  }
  async startRecording(roomName: string, target: RecordingTarget) {
    this.record('startRecording', roomName, target.filepath);
    return { egressId: `EG_mock_${++this.egressSeq}` };
  }
  async stopRecording(egressId: string) {
    this.record('stopRecording', egressId);
  }
  async verifyWebhook(body: string, authorization: string | undefined): Promise<NormalizedWebhookEvent> {
    if (authorization !== 'mock-signature') throw new Error('invalid webhook signature');
    return JSON.parse(body) as NormalizedWebhookEvent;
  }
}
