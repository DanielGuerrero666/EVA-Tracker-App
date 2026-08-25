CREATE TYPE user_role AS ENUM ('employee', 'admin');

CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role user_role NOT NULL DEFAULT 'employee',
  scheduled_clock_in TIME,
  scheduled_clock_out TIME,
  break_allowance_minutes INTEGER NOT NULL DEFAULT 60,
  must_change_password BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE shifts (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  clock_in TIMESTAMPTZ NOT NULL DEFAULT now(),
  clock_out TIMESTAMPTZ,
  break_time_seconds INTEGER NOT NULL DEFAULT 0,
  break_started_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_shifts_user_clockin ON shifts(user_id, clock_in DESC);

-- Enforces at the DB level what the app already requires: at most one open
-- shift per user at any time.
CREATE UNIQUE INDEX uq_shifts_one_open_per_user ON shifts(user_id) WHERE clock_out IS NULL;

CREATE TABLE refresh_tokens (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_refresh_tokens_hash ON refresh_tokens(token_hash);
