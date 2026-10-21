/**
 * Ordered, append-only migrations. Never edit a released migration; add a new one.
 * Applied by `migrate()` at server start (idempotent) or via `npm run migrate -w @lsp/api`.
 */
export const MIGRATIONS: { version: number; name: string; sql: string }[] = [
  {
    version: 1,
    name: 'init',
    sql: `
CREATE TABLE users (
  user_id        text PRIMARY KEY,
  email          text NOT NULL,
  display_name   text NOT NULL,
  platform_role  text NOT NULL,
  created_at     timestamptz NOT NULL,
  updated_at     timestamptz NOT NULL
);
CREATE INDEX users_email_idx ON users (email);

CREATE TABLE devices (
  user_id     text NOT NULL,
  token_hash  text NOT NULL,
  push_token  text NOT NULL,
  platform    text NOT NULL,
  updated_at  timestamptz NOT NULL,
  PRIMARY KEY (user_id, token_hash)
);

CREATE TABLE events (
  id                        text PRIMARY KEY,
  title                     text NOT NULL,
  description               text NOT NULL,
  start_at                  timestamptz NOT NULL,
  duration_minutes          integer NOT NULL,
  time_zone                 text NOT NULL,
  status                    text NOT NULL CHECK (status IN ('DRAFT','SCHEDULED','READY','LIVE','ENDED','CANCELLED')),
  organizer_id              text NOT NULL,
  room_name                 text NOT NULL UNIQUE,
  max_participants          integer NOT NULL CHECK (max_participants BETWEEN 2 AND 50),
  max_speakers              integer NOT NULL CHECK (max_speakers BETWEEN 0 AND 5),
  recording_enabled         boolean NOT NULL,
  chat_enabled              boolean NOT NULL,
  chat_persistence          boolean NOT NULL,
  thumbnail_key             text,
  active_recording_id       text,
  active_stream_session_id  text,
  live_started_at           timestamptz,
  ended_at                  timestamptz,
  created_at                timestamptz NOT NULL,
  updated_at                timestamptz NOT NULL,
  version                   integer NOT NULL
);
CREATE INDEX events_organizer_idx ON events (organizer_id, start_at);
CREATE INDEX events_status_idx ON events (status, start_at);

CREATE TABLE event_members (
  event_id        text NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id         text NOT NULL,
  email           text NOT NULL,
  display_name    text NOT NULL,
  role            text NOT NULL CHECK (role IN ('ORGANIZER','BROADCASTER','VIEWER')),
  status          text NOT NULL CHECK (status IN ('ACTIVE','REMOVED')),
  can_moderate    boolean NOT NULL,
  event_start_at  timestamptz NOT NULL,
  joined_at       timestamptz NOT NULL,
  updated_at      timestamptz NOT NULL,
  PRIMARY KEY (event_id, user_id)
);
CREATE INDEX event_members_user_idx ON event_members (user_id, event_start_at);

CREATE TABLE invitations (
  id           text PRIMARY KEY,
  event_id     text NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  email        text NOT NULL,
  role         text NOT NULL,
  status       text NOT NULL CHECK (status IN ('PENDING','ACCEPTED','REVOKED','EXPIRED')),
  token_hash   text NOT NULL UNIQUE,
  invited_by   text NOT NULL,
  created_at   timestamptz NOT NULL,
  expires_at   timestamptz NOT NULL,
  accepted_at  timestamptz,
  accepted_by  text
);
CREATE INDEX invitations_event_idx ON invitations (event_id, created_at);

CREATE TABLE capacity (
  event_id  text PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
  total     integer NOT NULL DEFAULT 0 CHECK (total >= 0),
  hosts     integer NOT NULL DEFAULT 0 CHECK (hosts >= 0),
  speakers  integer NOT NULL DEFAULT 0 CHECK (speakers >= 0)
);

CREATE TABLE participant_sessions (
  event_id      text NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id       text NOT NULL,
  role          text NOT NULL,
  state         text NOT NULL CHECK (state IN ('ADMITTED','CONNECTED','LEFT')),
  admitted_at   timestamptz NOT NULL,
  connected_at  timestamptz,
  left_at       timestamptz,
  livekit_sid   text,
  PRIMARY KEY (event_id, user_id)
);

CREATE TABLE speaker_requests (
  id            text PRIMARY KEY,
  event_id      text NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id       text NOT NULL,
  display_name  text NOT NULL,
  status        text NOT NULL CHECK (status IN ('PENDING','APPROVED','REJECTED','CANCELLED','REVOKED')),
  created_at    timestamptz NOT NULL,
  resolved_at   timestamptz,
  resolved_by   text
);
CREATE INDEX speaker_requests_event_idx ON speaker_requests (event_id, created_at);
-- At most one open (PENDING/APPROVED) request per user per event.
CREATE UNIQUE INDEX speaker_requests_open_uniq ON speaker_requests (event_id, user_id)
  WHERE status IN ('PENDING','APPROVED');

CREATE TABLE stream_sessions (
  id                 text PRIMARY KEY,
  event_id           text NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  started_at         timestamptz NOT NULL,
  started_by         text NOT NULL,
  ended_at           timestamptz,
  peak_participants  integer NOT NULL DEFAULT 0
);

CREATE TABLE chat_messages (
  id            text PRIMARY KEY,
  event_id      text NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id       text NOT NULL,
  display_name  text NOT NULL,
  role          text NOT NULL,
  text          text NOT NULL,
  created_at    timestamptz NOT NULL,
  deleted       boolean NOT NULL DEFAULT false,
  deleted_by    text,
  expires_at    timestamptz NOT NULL
);
CREATE INDEX chat_messages_event_idx ON chat_messages (event_id, created_at, id);
CREATE INDEX chat_messages_expiry_idx ON chat_messages (expires_at);

CREATE TABLE recordings (
  id                text PRIMARY KEY,
  event_id          text NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  egress_id         text UNIQUE,
  status            text NOT NULL,
  s3_key            text NOT NULL,
  started_by        text NOT NULL,
  started_at        timestamptz NOT NULL,
  ended_at          timestamptz,
  duration_seconds  integer,
  size_bytes        bigint,
  error             text
);
CREATE INDEX recordings_event_idx ON recordings (event_id, started_at);

CREATE TABLE audit_events (
  id          text PRIMARY KEY,
  scope       text NOT NULL,
  action      text NOT NULL,
  actor_id    text,
  target_id   text,
  details     jsonb NOT NULL,
  at          timestamptz NOT NULL,
  expires_at  timestamptz NOT NULL
);
CREATE INDEX audit_events_scope_idx ON audit_events (scope, at);
CREATE INDEX audit_events_expiry_idx ON audit_events (expires_at);

CREATE TABLE rate_limits (
  key         text NOT NULL,
  win         bigint NOT NULL,
  count       integer NOT NULL,
  expires_at  timestamptz NOT NULL,
  PRIMARY KEY (key, win)
);
CREATE INDEX rate_limits_expiry_idx ON rate_limits (expires_at);

CREATE TABLE idempotency_keys (
  key         text PRIMARY KEY,
  status      integer NOT NULL,
  body        jsonb,
  expires_at  timestamptz NOT NULL
);
`,
  },
  {
    version: 2,
    name: 'job_leases',
    sql: `
CREATE TABLE job_leases (
  name          text PRIMARY KEY,
  owner         text NOT NULL,
  locked_until  timestamptz NOT NULL
);
`,
  },
];
