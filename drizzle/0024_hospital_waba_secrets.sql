-- Inbound credentials for a hospital that brings its own Meta App.
--
-- Outbound was already multi-tenant: `resolveCredential` opens the hospital's
-- sealed access token and talks to Meta as them. Inbound was not. Both halves
-- of webhook authentication — the verify token Meta echoes during the
-- subscription handshake, and the app secret every payload is signed with —
-- were read from the process environment, which is correct only while every
-- WABA is subscribed to one Meta App: ours.
--
-- Under hospital ownership each WABA sits behind its own Meta App with its own
-- app secret, so one global secret rejects every signature but one. These two
-- columns are what make the webhook able to answer "whose secret verifies
-- this" — and the per-hospital callback route is what makes the question
-- answerable at all, since Meta's handshake carries no tenant identity.
--
-- Deliberately additive. Platform ownership keeps reading the environment and
-- keeps using the shared callback URL, so moving the portfolio onto one Tech
-- Provider app later is a flag flip on `ownership`, not a migration.

ALTER TABLE "whatsapp_integrations" ADD COLUMN "verify_token_ciphertext" text;--> statement-breakpoint
ALTER TABLE "whatsapp_integrations" ADD COLUMN "verify_token_iv" text;--> statement-breakpoint
ALTER TABLE "whatsapp_integrations" ADD COLUMN "verify_token_auth_tag" text;--> statement-breakpoint
ALTER TABLE "whatsapp_integrations" ADD COLUMN "verify_token_key_version" smallint;--> statement-breakpoint

ALTER TABLE "whatsapp_integrations" ADD COLUMN "app_secret_ciphertext" text;--> statement-breakpoint
ALTER TABLE "whatsapp_integrations" ADD COLUMN "app_secret_iv" text;--> statement-breakpoint
ALTER TABLE "whatsapp_integrations" ADD COLUMN "app_secret_auth_tag" text;--> statement-breakpoint
ALTER TABLE "whatsapp_integrations" ADD COLUMN "app_secret_key_version" smallint;--> statement-breakpoint

-- Each secret carries its own key version rather than sharing the access
-- token's. They are sealed together today, but a rotation that re-seals one and
-- fails partway through must not leave the others pointing at a version they
-- were not sealed with — the failure would surface as an authentication tag
-- mismatch at webhook time, which is the worst possible place to discover it.
ALTER TABLE "whatsapp_integrations" ADD CONSTRAINT "whatsapp_integrations_verify_token_complete" CHECK (
  (
    "verify_token_ciphertext" IS NULL AND "verify_token_iv" IS NULL
    AND "verify_token_auth_tag" IS NULL AND "verify_token_key_version" IS NULL
  ) OR (
    "verify_token_ciphertext" IS NOT NULL AND "verify_token_iv" IS NOT NULL
    AND "verify_token_auth_tag" IS NOT NULL AND "verify_token_key_version" IS NOT NULL
  )
);--> statement-breakpoint

ALTER TABLE "whatsapp_integrations" ADD CONSTRAINT "whatsapp_integrations_app_secret_complete" CHECK (
  (
    "app_secret_ciphertext" IS NULL AND "app_secret_iv" IS NULL
    AND "app_secret_auth_tag" IS NULL AND "app_secret_key_version" IS NULL
  ) OR (
    "app_secret_ciphertext" IS NOT NULL AND "app_secret_iv" IS NOT NULL
    AND "app_secret_auth_tag" IS NOT NULL AND "app_secret_key_version" IS NOT NULL
  )
);--> statement-breakpoint

-- A platform-owned row holds no secrets of any kind, for the same reason it
-- already holds no access token: under platform ownership the environment is
-- the single source, and a stale copy in a row is a credential nobody knows
-- is there.
ALTER TABLE "whatsapp_integrations" ADD CONSTRAINT "whatsapp_integrations_platform_holds_no_secrets" CHECK (
  "ownership" <> 'platform'
  OR ("verify_token_ciphertext" IS NULL AND "app_secret_ciphertext" IS NULL)
);
