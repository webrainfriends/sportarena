-- Per-user AI token usage: each AI capability writes one row per call.
-- Rows grow over time; a date index keeps 30-day aggregation fast.
CREATE TABLE ai_token_usage (
  id          bigserial PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  capability  text NOT NULL,                          -- e.g. 'coaching_assist'
  model       text,
  tokens_in   int NOT NULL DEFAULT 0,
  tokens_out  int NOT NULL DEFAULT 0,
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_token_usage_user_at ON ai_token_usage (user_id, at);
CREATE INDEX ai_token_usage_at      ON ai_token_usage (at);  -- platform-wide totals

-- Per-user daily API call counter: one upsert per authenticated request.
-- Lightweight: single row per (user, day), incremented in-place.
CREATE TABLE user_daily_api_calls (
  user_id    uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  date       date NOT NULL DEFAULT CURRENT_DATE,
  call_count bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, date)
);
CREATE INDEX user_daily_api_calls_date ON user_daily_api_calls (date);
