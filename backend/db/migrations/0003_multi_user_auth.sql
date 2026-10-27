CREATE TABLE auth_credentials (
  user_id uuid PRIMARY KEY REFERENCES users(id),
  login_id text NOT NULL UNIQUE CHECK (login_id ~ '^[a-z0-9_]{3,32}$'),
  password_hash text NOT NULL
);
CREATE TABLE auth_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL UNIQUE,
  user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX auth_sessions_user_idx ON auth_sessions(user_id);
CREATE INDEX auth_sessions_expiry_idx ON auth_sessions(expires_at);
CREATE TABLE auth_invites (
  token_hash text PRIMARY KEY,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  revoked_at timestamptz
);
CREATE INDEX auth_invites_expiry_idx ON auth_invites(expires_at);
CREATE TABLE auth_rate_limits (
  key text PRIMARY KEY,
  attempts integer NOT NULL CHECK (attempts > 0),
  expires_at timestamptz NOT NULL
);
CREATE INDEX auth_rate_limits_expiry_idx ON auth_rate_limits(expires_at);
ALTER TABLE push_subscriptions ADD COLUMN auth_session_id uuid REFERENCES auth_sessions(id) ON DELETE SET NULL;
CREATE INDEX push_subscriptions_session_idx ON push_subscriptions(auth_session_id);
CREATE INDEX push_subscriptions_user_idx ON push_subscriptions(user_id);
