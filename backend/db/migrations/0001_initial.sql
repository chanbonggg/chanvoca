CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name text NOT NULL UNIQUE,
  timezone text NOT NULL DEFAULT 'Asia/Seoul',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE days (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  day_number integer NOT NULL CHECK (day_number > 0),
  original_filename text NOT NULL,
  source_format text NOT NULL CHECK (source_format IN ('xlsx', 'xls', 'csv')),
  row_count integer NOT NULL CHECK (row_count > 0),
  imported_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, day_number)
);

CREATE INDEX days_user_imported_at_idx ON days (user_id, imported_at DESC);

CREATE TABLE cards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  day_id uuid NOT NULL REFERENCES days(id),
  source_row integer NOT NULL CHECK (source_row >= 2),
  term text NOT NULL CHECK (length(term) > 0 AND length(term) <= 200),
  meaning text NOT NULL CHECK (length(meaning) > 0 AND length(meaning) <= 1000),
  example_en text,
  example_ko text,
  example_status text NOT NULL DEFAULT 'pending'
    CHECK (example_status IN ('pending', 'processing', 'ready', 'failed')),
  example_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (day_id, source_row)
);

CREATE INDEX cards_day_source_row_idx ON cards (day_id, source_row);

CREATE TABLE jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('generate_example', 'send_push')),
  dedupe_key text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'processing', 'done', 'failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  locked_by text,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (kind, dedupe_key)
);

CREATE INDEX jobs_ready_idx ON jobs (available_at, created_at)
  WHERE status = 'queued';

CREATE TABLE study_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  target_day_id uuid NOT NULL REFERENCES days(id),
  target_day_number integer NOT NULL CHECK (target_day_number > 0),
  plan_day_numbers integer[] NOT NULL,
  status text NOT NULL DEFAULT 'in_progress'
    CHECK (status IN ('in_progress', 'completed', 'abandoned')),
  total_cards integer NOT NULL CHECK (total_cards >= 0),
  known_count integer NOT NULL DEFAULT 0 CHECK (known_count >= 0),
  unknown_count integer NOT NULL DEFAULT 0 CHECK (unknown_count >= 0),
  timeout_count integer NOT NULL DEFAULT 0 CHECK (timeout_count >= 0),
  rounds_completed integer NOT NULL DEFAULT 0 CHECK (rounds_completed >= 0),
  repeat_of_session_id uuid REFERENCES study_sessions(id) ON DELETE SET NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE INDEX study_sessions_user_started_at_idx ON study_sessions (user_id, started_at DESC);

CREATE TABLE study_session_cards (
  session_id uuid NOT NULL REFERENCES study_sessions(id),
  card_id uuid NOT NULL REFERENCES cards(id),
  initial_order integer NOT NULL CHECK (initial_order > 0),
  passed_at_round integer CHECK (passed_at_round > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, card_id)
);

CREATE TABLE study_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES study_sessions(id),
  card_id uuid NOT NULL REFERENCES cards(id),
  round_number integer NOT NULL CHECK (round_number > 0),
  position integer NOT NULL CHECK (position > 0),
  result text NOT NULL CHECK (result IN ('known', 'unknown', 'timeout')),
  response_ms integer NOT NULL CHECK (response_ms >= 0),
  revealed_at_ms integer CHECK (revealed_at_ms >= 0),
  idempotency_key uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, idempotency_key)
);

CREATE INDEX study_attempts_session_card_idx ON study_attempts (session_id, card_id, created_at);

CREATE TABLE push_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  endpoint text NOT NULL UNIQUE,
  p256dh text NOT NULL,
  auth text NOT NULL,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_success_at timestamptz,
  disabled_at timestamptz
);

CREATE TABLE notification_settings (
  user_id uuid PRIMARY KEY REFERENCES users(id),
  enabled boolean NOT NULL DEFAULT false,
  local_time time NOT NULL,
  timezone text NOT NULL DEFAULT 'Asia/Seoul',
  last_enqueued_local_date date,
  updated_at timestamptz NOT NULL DEFAULT now()
);
