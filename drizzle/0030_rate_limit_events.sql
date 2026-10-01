-- Throttling for the two endpoints anyone on the internet can hammer: sign-in
-- and the public slot-booking form.
--
-- In the database rather than in process memory because the count has to be
-- the same on every server instance. An in-memory limiter on N instances lets
-- an attacker through at N times the rate, which for password guessing is the
-- difference between a limit and a suggestion.
--
-- One row per counted event. `key_hash` is a SHA-256 of a namespaced key such
-- as "login:email:someone@example.com" or "book:ip:203.0.113.7", so the table
-- holds no email address, phone number or IP in readable form.
--
-- No hospital_id and no row-level security, like `sessions`: these checks run
-- before any hospital is known (a failed sign-in has no tenant at all). The
-- table records nothing about any hospital's patients or staff beyond hashes.
-- Rows older than a day are deleted by the sweep in lib/services/sweeps.ts.

CREATE TABLE rate_limit_events (
  id BIGSERIAL PRIMARY KEY,
  key_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE INDEX rate_limit_events_key_idx ON rate_limit_events (key_hash, created_at);
