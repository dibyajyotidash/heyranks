-- HeyRanks D1 schema
-- Run once: wrangler d1 execute heyranks-prod --file=schema.sql

CREATE TABLE IF NOT EXISTS customers (
  id          TEXT PRIMARY KEY,          -- UUID
  email       TEXT NOT NULL UNIQUE,
  website     TEXT NOT NULL,             -- normalized hostname, e.g. "sunrise-dental.com"
  keywords    TEXT NOT NULL DEFAULT '[]',-- JSON array of up to 5 strings
  plan        TEXT NOT NULL DEFAULT '180day', -- '180day' | 'lifetime'
  status      TEXT NOT NULL DEFAULT 'active', -- 'active' | 'expired' | 'refunded'
  created_at  TEXT NOT NULL,             -- ISO-8601
  expires_at  TEXT,                      -- ISO-8601 or NULL for lifetime
  whatsapp    TEXT,                      -- E.164 or null
  last_report_at TEXT                    -- ISO-8601 of most recent sent report
);

CREATE TABLE IF NOT EXISTS reports (
  id           TEXT PRIMARY KEY,
  customer_id  TEXT NOT NULL REFERENCES customers(id),
  week         TEXT NOT NULL,            -- Monday date, YYYY-MM-DD
  score        INTEGER NOT NULL,
  prev_score   INTEGER,
  passed       TEXT NOT NULL DEFAULT '[]', -- JSON array of label strings
  issues       TEXT NOT NULL DEFAULT '[]', -- JSON array of {id,label,w,fix}
  speed        INTEGER,                  -- PageSpeed score or null
  created_at   TEXT NOT NULL,
  UNIQUE(customer_id, week)
);

CREATE INDEX IF NOT EXISTS idx_customers_status ON customers(status);
CREATE INDEX IF NOT EXISTS idx_reports_customer  ON reports(customer_id);
