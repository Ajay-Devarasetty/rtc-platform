CREATE TABLE IF NOT EXISTS apns_credentials (
  app_id VARCHAR(64) NOT NULL REFERENCES apps(app_id) ON DELETE CASCADE,
  bundle_id TEXT NOT NULL,
  environment TEXT NOT NULL CHECK (environment IN ('sandbox','production')),
  encrypted_value TEXT NOT NULL,
  key_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (app_id, bundle_id, environment)
);
ALTER TABLE push_devices ADD COLUMN IF NOT EXISTS platform TEXT NOT NULL DEFAULT 'android';
ALTER TABLE push_devices ADD COLUMN IF NOT EXISTS push_type TEXT NOT NULL DEFAULT 'alert';
ALTER TABLE push_devices ADD COLUMN IF NOT EXISTS bundle_id TEXT;
ALTER TABLE push_devices ADD COLUMN IF NOT EXISTS environment TEXT;
ALTER TABLE push_devices ADD COLUMN IF NOT EXISTS app_state TEXT NOT NULL DEFAULT 'foreground';
-- Keep an alert token and a separate PushKit token for the same iOS installation.
ALTER TABLE push_devices DROP CONSTRAINT IF EXISTS push_devices_pkey;
ALTER TABLE push_devices ADD PRIMARY KEY (app_id, installation_id, push_type);
CREATE TABLE IF NOT EXISTS chat_push_subscriptions (
  app_id VARCHAR(64) NOT NULL REFERENCES apps(app_id) ON DELETE CASCADE,
  room_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (app_id, room_id, user_id)
);
CREATE TABLE IF NOT EXISTS message_push_jobs (
  id BIGSERIAL PRIMARY KEY,
  app_id VARCHAR(64) NOT NULL REFERENCES apps(app_id) ON DELETE CASCADE,
  message_id BIGINT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  installation_id VARCHAR(128) NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lease TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (app_id, message_id, installation_id)
);
CREATE INDEX IF NOT EXISTS message_push_pending ON message_push_jobs(available_at) WHERE state='pending';
ALTER TABLE push_deliveries ALTER COLUMN call_id DROP NOT NULL;
ALTER TABLE push_deliveries ADD COLUMN IF NOT EXISTS message_id BIGINT;
ALTER TABLE push_deliveries ADD COLUMN IF NOT EXISTS platform TEXT NOT NULL DEFAULT 'android';
ALTER TABLE push_deliveries ADD COLUMN IF NOT EXISTS push_type TEXT NOT NULL DEFAULT 'alert';
