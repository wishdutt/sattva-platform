import * as chat from '../services/chat';
import * as events from '../services/events';
import * as invitations from '../services/invitations';
import * as live from '../services/live';
import * as me from '../services/me';
import * as recordings from '../services/recordings';
import { Router } from './router';

/** All authenticated REST routes under /api/v1. The webhook route is served by its own Lambda. */
export function buildRouter() {
  const r = new Router();

  r.add('GET', '/me', ({ deps, user }) => me.getMe(deps, user));
  r.add('POST', '/me/devices', ({ deps, user, body }) => me.registerDevice(deps, user, body));

  // Events
  r.add('POST', '/events', ({ deps, user, body }) => events.createEvent(deps, user, body), {
    status: 201,
    idempotent: true,
  });
  r.add('GET', '/events', ({ deps, user, query }) => events.listEvents(deps, user, query.scope));
  r.add('GET', '/events/{id}', ({ deps, user, params }) => events.getEvent(deps, user, params.id!));
  r.add('PATCH', '/events/{id}', ({ deps, user, params, body }) => events.updateEvent(deps, user, params.id!, body));
  r.add('POST', '/events/{id}/start', ({ deps, user, params, body }) => events.startEvent(deps, user, params.id!, body));
  r.add('POST', '/events/{id}/end', ({ deps, user, params }) => events.endEvent(deps, user, params.id!));
  r.add('GET', '/events/{id}/capacity', ({ deps, user, params }) => events.getCapacity(deps, user, params.id!));
  r.add('POST', '/events/{id}/thumbnail-upload-url', ({ deps, user, params, body }) =>
    events.createThumbnailUpload(deps, user, params.id!, body),
  );

  // Invitations & membership
  r.add('POST', '/events/{id}/invitations', ({ deps, user, params, body }) =>
    invitations.inviteParticipants(deps, user, params.id!, body), { status: 201 },
  );
  r.add('GET', '/events/{id}/invitations', ({ deps, user, params }) =>
    invitations.listInvitations(deps, user, params.id!),
  );
  r.add('DELETE', '/events/{id}/invitations/{inviteId}', ({ deps, user, params }) =>
    invitations.revokeInvitation(deps, user, params.id!, params.inviteId!),
  );
  r.add('POST', '/invitations/preview', ({ deps, user, body }) => invitations.previewInvitation(deps, user, body));
  r.add('POST', '/invitations/accept', ({ deps, user, body }) => invitations.acceptInvitation(deps, user, body));
  r.add('GET', '/events/{id}/members', ({ deps, user, params }) => invitations.listMembers(deps, user, params.id!));
  r.add('PATCH', '/events/{id}/members/{userId}', ({ deps, user, params, body }) =>
    invitations.updateMember(deps, user, params.id!, params.userId!, body),
  );
  r.add('DELETE', '/events/{id}/members/{userId}', ({ deps, user, params }) =>
    invitations.removeMember(deps, user, params.id!, params.userId!),
  );

  // LiveKit session & moderation
  r.add('POST', '/events/{id}/join-token', ({ deps, user, params }) => live.issueJoinToken(deps, user, params.id!));
  r.add('POST', '/events/{id}/leave', ({ deps, user, params }) => live.leaveEvent(deps, user, params.id!));
  r.add('POST', '/events/{id}/raise-hand', ({ deps, user, params }) => live.raiseHand(deps, user, params.id!));
  r.add('DELETE', '/events/{id}/raise-hand', ({ deps, user, params }) => live.lowerHand(deps, user, params.id!));
  r.add('GET', '/events/{id}/speaker-requests', ({ deps, user, params }) =>
    live.listSpeakerRequests(deps, user, params.id!),
  );
  r.add('POST', '/events/{id}/speaker-requests/{requestId}/approve', ({ deps, user, params }) =>
    live.approveSpeaker(deps, user, params.id!, params.requestId!),
  );
  r.add('POST', '/events/{id}/speaker-requests/{requestId}/reject', ({ deps, user, params }) =>
    live.rejectSpeaker(deps, user, params.id!, params.requestId!),
  );
  r.add('POST', '/events/{id}/speakers/{userId}/demote', ({ deps, user, params }) =>
    live.demoteSpeaker(deps, user, params.id!, params.userId!),
  );
  r.add('POST', '/events/{id}/participants/{userId}/remove', ({ deps, user, params }) =>
    live.kickParticipant(deps, user, params.id!, params.userId!),
  );

  // Chat & reactions
  r.add('POST', '/events/{id}/chat', ({ deps, user, params, body }) => chat.sendChat(deps, user, params.id!, body), {
    status: 201,
  });
  r.add('GET', '/events/{id}/chat', ({ deps, user, params }) => chat.listChat(deps, user, params.id!));
  r.add('DELETE', '/events/{id}/chat/{messageId}', ({ deps, user, params }) =>
    chat.deleteChat(deps, user, params.id!, params.messageId!),
  );
  r.add('POST', '/events/{id}/reactions', ({ deps, user, params, body }) =>
    chat.sendReaction(deps, user, params.id!, body),
  );

  // Recordings
  r.add('POST', '/events/{id}/recordings/start', ({ deps, user, params }) =>
    recordings.startRecording(deps, user, params.id!), { status: 201 },
  );
  r.add('POST', '/events/{id}/recordings/stop', ({ deps, user, params }) =>
    recordings.stopRecording(deps, user, params.id!),
  );
  r.add('GET', '/events/{id}/recordings', ({ deps, user, params }) => recordings.listRecordings(deps, user, params.id!));
  r.add('DELETE', '/events/{id}/recordings/{recordingId}', ({ deps, user, params }) =>
    recordings.deleteRecording(deps, user, params.id!, params.recordingId!),
  );

  return r;
}
