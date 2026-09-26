-- Customer self-service accounts (email + password) linked to one RTC app each.
CREATE TABLE IF NOT EXISTS customer_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(320) UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name VARCHAR(255),
  company VARCHAR(255),
  app_id VARCHAR(64) UNIQUE NOT NULL REFERENCES apps(app_id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_customer_accounts_email_lower ON customer_accounts (LOWER(email));
CREATE INDEX IF NOT EXISTS idx_customer_accounts_app_id ON customer_accounts(app_id);
