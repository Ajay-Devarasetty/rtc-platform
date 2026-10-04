CREATE TABLE IF NOT EXISTS push_credentials (
  app_id VARCHAR(64) PRIMARY KEY REFERENCES apps(app_id) ON DELETE CASCADE,
  encrypted_value TEXT,
  metadata JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- A null encrypted_value explicitly disables push, including a legacy file entry.
