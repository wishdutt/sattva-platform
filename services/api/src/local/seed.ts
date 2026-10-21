/**
 * Seeds a real DynamoDB table (dev environment) with a sample event.
 *   TABLE_NAME=lsp-dev-main ORGANIZER_SUB=<cognito sub> ORGANIZER_EMAIL=<email> npm run seed -w @lsp/api
 * The organizer must already exist in Cognito (and be in the "organizers" group).
 */
import { roomNameForEvent } from '@lsp/shared';
import { newId } from '../lib/ids';
import { DynamoStore } from '../store/dynamo';

const table = process.env.TABLE_NAME;
const sub = process.env.ORGANIZER_SUB;
const email = process.env.ORGANIZER_EMAIL?.toLowerCase();
if (!table || !sub || !email) {
  console.error('TABLE_NAME, ORGANIZER_SUB and ORGANIZER_EMAIL are required');
  process.exit(1);
}

const store = new DynamoStore(table);
const now = new Date().toISOString();
const startAt = new Date(Date.now() + 24 * 3_600_000).toISOString();
const id = newId();

await store.createEvent(
  {
    id,
    title: 'Sample: Quarterly All-Hands',
    description: 'Seeded sample event. Invite a colleague and try the speaker workflow.',
    startAt,
    durationMinutes: 60,
    timeZone: 'UTC',
    status: 'SCHEDULED',
    organizerId: sub,
    roomName: roomNameForEvent(id),
    maxParticipants: 50,
    maxSpeakers: 5,
    recordingEnabled: true,
    chatEnabled: true,
    chatPersistence: true,
    thumbnailKey: null,
    activeRecordingId: null,
    activeStreamSessionId: null,
    liveStartedAt: null,
    endedAt: null,
    createdAt: now,
    updatedAt: now,
    version: 1,
  },
  {
    eventId: id,
    userId: sub,
    email,
    displayName: email.split('@')[0]!,
    role: 'ORGANIZER',
    status: 'ACTIVE',
    canModerate: true,
    eventStartAt: startAt,
    joinedAt: now,
    updatedAt: now,
  },
);
console.info(`Seeded event ${id} in ${table}`);
