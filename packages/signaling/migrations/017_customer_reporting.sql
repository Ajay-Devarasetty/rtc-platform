CREATE TABLE IF NOT EXISTS customer_business_profiles (
  account_id UUID PRIMARY KEY REFERENCES customer_accounts(id) ON DELETE CASCADE,
  business_type TEXT NOT NULL DEFAULT 'individual' CHECK (business_type IN ('individual','business')),
  business_name VARCHAR(255) NOT NULL DEFAULT '',
  phone VARCHAR(40) NOT NULL DEFAULT '',
  website VARCHAR(500) NOT NULL DEFAULT '',
  address VARCHAR(1000) NOT NULL DEFAULT '',
  city VARCHAR(100) NOT NULL DEFAULT '',
  state VARCHAR(100) NOT NULL DEFAULT '',
  postal_code VARCHAR(30) NOT NULL DEFAULT '',
  country VARCHAR(100) NOT NULL DEFAULT '',
  tax_id VARCHAR(40) NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Only a trusted, provider-verifying backend integration may write this ledger.
-- No customer or admin HTTP endpoint can declare a payment verified.
CREATE TABLE IF NOT EXISTS customer_payments (
  id BIGSERIAL PRIMARY KEY,
  account_id UUID NOT NULL REFERENCES customer_accounts(id),
  provider TEXT NOT NULL CHECK (provider='instamojo'),
  provider_payment_id VARCHAR(255) NOT NULL,
  order_reference VARCHAR(255),
  amount_minor BIGINT NOT NULL CHECK (amount_minor>0 AND amount_minor<=1000000000000),
  refunded_minor BIGINT NOT NULL DEFAULT 0 CHECK (refunded_minor>=0 AND refunded_minor<=amount_minor),
  currency TEXT NOT NULL DEFAULT 'INR' CHECK (currency='INR'),
  status TEXT NOT NULL CHECK (status IN ('pending','paid','failed','partially_refunded','refunded')),
  plan_code VARCHAR(64) NOT NULL,
  billing_term TEXT NOT NULL CHECK (billing_term IN ('monthly','yearly')),
  paid_at TIMESTAMPTZ,
  verified_at TIMESTAMPTZ,
  period_start TIMESTAMPTZ,
  period_end TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (provider,provider_payment_id),
  CHECK (period_end IS NULL OR period_start IS NULL OR period_end>period_start)
);
CREATE INDEX IF NOT EXISTS customer_payments_account ON customer_payments(account_id,paid_at DESC);
