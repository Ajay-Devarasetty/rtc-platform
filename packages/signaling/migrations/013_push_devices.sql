CREATE TABLE IF NOT EXISTS push_devices (
  app_id VARCHAR(64) NOT NULL REFERENCES apps(app_id) ON DELETE CASCADE,
  installation_id VARCHAR(128) NOT NULL,
  user_id VARCHAR(255) NOT NULL,
  token TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (app_id, installation_id),
  UNIQUE (app_id, token)
);
CREATE INDEX IF NOT EXISTS push_devices_user ON push_devices(app_id, user_id);

CREATE TABLE IF NOT EXISTS push_deliveries (
  id BIGSERIAL PRIMARY KEY,
  app_id VARCHAR(64) NOT NULL REFERENCES apps(app_id) ON DELETE CASCADE,
  call_id TEXT NOT NULL,
  installation_id VARCHAR(128) NOT NULL,
  success BOOLEAN NOT NULL,
  status_code INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS push_deliveries_app ON push_deliveries(app_id, created_at DESC);
