CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$
BEGIN
  CREATE TYPE thread_state AS ENUM (
    'active',
    'cooling',
    'archived',
    'superseded'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

DO $$
BEGIN
  CREATE TYPE assignment_status AS ENUM (
    'pending',
    'in_progress',
    'assigned',
    'failed'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

CREATE TABLE IF NOT EXISTS threads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  state thread_state NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_message_at TIMESTAMPTZ,
  archived_at TIMESTAMPTZ,
  superseded_at TIMESTAMPTZ,
  revives_thread_id UUID REFERENCES threads(id),
  continued_in_thread_id UUID REFERENCES threads(id),
  merged_into_thread_id UUID REFERENCES threads(id)
);

CREATE TABLE IF NOT EXISTS messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  author TEXT NOT NULL,
  content TEXT NOT NULL,
  thread_id UUID REFERENCES threads(id),
  assignment_status assignment_status NOT NULL DEFAULT 'pending',
  assignment_note TEXT
);

CREATE INDEX IF NOT EXISTS idx_messages_created_at
  ON messages(created_at);

CREATE INDEX IF NOT EXISTS idx_messages_assignment_status
  ON messages(assignment_status, created_at);

CREATE INDEX IF NOT EXISTS idx_messages_thread_id
  ON messages(thread_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_threads_state_updated
  ON threads(state, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_threads_last_message_at
  ON threads(last_message_at DESC);

