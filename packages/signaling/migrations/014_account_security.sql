ALTER TABLE apps ADD COLUMN IF NOT EXISTS portal_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE customer_accounts ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;
CREATE TABLE IF NOT EXISTS account_tokens (
  token_hash CHAR(64) PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES customer_accounts(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('verify', 'reset')),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS account_tokens_account ON account_tokens(account_id);
