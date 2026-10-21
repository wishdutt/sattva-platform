import { API_PREFIX, type Reaction } from './constants';
import type {
  ApiErrorBody,
  CapacityDto,
  ChatMessageDto,
  EventDto,
  InvitationDto,
  InvitationPreviewDto,
  JoinTokenDto,
  MeDto,
  MemberDto,
  RecordingDto,
  SpeakerRequestDto,
} from './dto';
import type { CreateEventInput, InviteInput, UpdateEventInput } from './schemas';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface ApiClientOptions {
  baseUrl: string;
  /** Returns a fresh Cognito ID token (or null when signed out). */
  getToken: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
}

export type ApiClient = ReturnType<typeof createApiClient>;

export function createApiClient({ baseUrl, getToken, fetchImpl }: ApiClientOptions) {
  const doFetch = fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const root = baseUrl.replace(/\/$/, '') + API_PREFIX;

  async function request<T>(method: string, path: string, body?: unknown, idempotencyKey?: string): Promise<T> {
    const token = await getToken();
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

    const res = await doFetch(root + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    const json = text ? (JSON.parse(text) as unknown) : undefined;
    if (!res.ok) {
      const err = (json as ApiErrorBody | undefined)?.error;
      throw new ApiError(res.status, err?.code ?? 'HTTP_ERROR', err?.message ?? res.statusText, err?.details);
    }
    return json as T;
  }

  const e = encodeURIComponent;

  return {
    me: () => request<MeDto>('GET', '/me'),
    registerDevice: (pushToken: string, platform: 'ios' | 'android' | 'web') =>
      request<void>('POST', '/me/devices', { pushToken, platform }),

    listEvents: (scope: 'mine' | 'all' = 'mine') =>
      request<{ items: EventDto[] }>('GET', `/events${scope === 'all' ? '?scope=all' : ''}`),
    getEvent: (id: string) => request<EventDto>('GET', `/events/${e(id)}`),
    createEvent: (input: CreateEventInput, idempotencyKey?: string) =>
      request<EventDto>('POST', '/events', input, idempotencyKey),
    updateEvent: (id: string, input: UpdateEventInput) => request<EventDto>('PATCH', `/events/${e(id)}`, input),
    startEvent: (id: string, goLive = true) => request<EventDto>('POST', `/events/${e(id)}/start`, { goLive }),
    endEvent: (id: string) => request<EventDto>('POST', `/events/${e(id)}/end`, {}),
    thumbnailUploadUrl: (id: string, contentType: string, contentLength: number) =>
      request<{ uploadUrl: string; key: string }>('POST', `/events/${e(id)}/thumbnail-upload-url`, {
        contentType,
        contentLength,
      }),
    capacity: (id: string) => request<CapacityDto>('GET', `/events/${e(id)}/capacity`),

    invite: (id: string, input: InviteInput) =>
      request<{ items: InvitationDto[] }>('POST', `/events/${e(id)}/invitations`, input),
    listInvitations: (id: string) => request<{ items: InvitationDto[] }>('GET', `/events/${e(id)}/invitations`),
    revokeInvitation: (id: string, inviteId: string) =>
      request<void>('DELETE', `/events/${e(id)}/invitations/${e(inviteId)}`),
    previewInvitation: (token: string) =>
      request<InvitationPreviewDto>('POST', '/invitations/preview', { token }),
    acceptInvitation: (token: string) =>
      request<{ eventId: string; role: string }>('POST', '/invitations/accept', { token }),
    listMembers: (id: string) => request<{ items: MemberDto[] }>('GET', `/events/${e(id)}/members`),
    updateMember: (id: string, userId: string, input: { role?: 'VIEWER' | 'BROADCASTER'; canModerate?: boolean }) =>
      request<MemberDto>('PATCH', `/events/${e(id)}/members/${e(userId)}`, input),
    removeMember: (id: string, userId: string) => request<void>('DELETE', `/events/${e(id)}/members/${e(userId)}`),

    joinToken: (id: string) => request<JoinTokenDto>('POST', `/events/${e(id)}/join-token`, {}),
    leave: (id: string) => request<void>('POST', `/events/${e(id)}/leave`, {}),
    raiseHand: (id: string) => request<SpeakerRequestDto>('POST', `/events/${e(id)}/raise-hand`, {}),
    lowerHand: (id: string) => request<void>('DELETE', `/events/${e(id)}/raise-hand`),
    listSpeakerRequests: (id: string) =>
      request<{ items: SpeakerRequestDto[] }>('GET', `/events/${e(id)}/speaker-requests`),
    approveSpeaker: (id: string, requestId: string) =>
      request<SpeakerRequestDto>('POST', `/events/${e(id)}/speaker-requests/${e(requestId)}/approve`, {}),
    rejectSpeaker: (id: string, requestId: string) =>
      request<SpeakerRequestDto>('POST', `/events/${e(id)}/speaker-requests/${e(requestId)}/reject`, {}),
    demoteSpeaker: (id: string, userId: string) =>
      request<void>('POST', `/events/${e(id)}/speakers/${e(userId)}/demote`, {}),
    /** Disconnects a participant from the live room (they remain an event member). */
    removeFromRoom: (id: string, userId: string) =>
      request<void>('POST', `/events/${e(id)}/participants/${e(userId)}/remove`, {}),

    sendChat: (id: string, text: string) => request<ChatMessageDto>('POST', `/events/${e(id)}/chat`, { text }),
    listChat: (id: string) => request<{ items: ChatMessageDto[] }>('GET', `/events/${e(id)}/chat`),
    deleteChat: (id: string, messageId: string) =>
      request<void>('DELETE', `/events/${e(id)}/chat/${e(messageId)}`),
    react: (id: string, emoji: Reaction) => request<void>('POST', `/events/${e(id)}/reactions`, { emoji }),

    startRecording: (id: string) => request<RecordingDto>('POST', `/events/${e(id)}/recordings/start`, {}),
    stopRecording: (id: string) => request<RecordingDto>('POST', `/events/${e(id)}/recordings/stop`, {}),
    listRecordings: (id: string) => request<{ items: RecordingDto[] }>('GET', `/events/${e(id)}/recordings`),
    deleteRecording: (id: string, recordingId: string) =>
      request<void>('DELETE', `/events/${e(id)}/recordings/${e(recordingId)}`),
  };
}
