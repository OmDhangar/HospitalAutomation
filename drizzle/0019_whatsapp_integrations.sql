-- How QueueCare authenticates with a hospital's WhatsApp provider.
--
-- This is deliberately separate from `whatsapp_numbers`, which answers a
-- different question. The integration says "how do we talk to this provider at
-- all"; the number says "which sender can this hospital use, and is it live".
-- Conflating them is what forces a rewrite the first time one hospital needs
-- two numbers, or the first time a credential has to be rotated without
-- touching sender state.
--
-- `ownership` is the load-bearing column. Today every row is 'platform': we
-- hold one Meta Business Manager, one verification and one WABA, and hospitals
-- never touch Meta at all. That is a deliberate commercial choice documented in
-- docs/runbooks/whatsapp-setup.md — it collapses 27 template approvals per
-- hospital into 27 once, and removes a one-to-three week business verification
-- from every single onboarding.
--
-- 'hospital' exists so that choice is reversible per customer rather than
-- per platform. A hospital that already owns a verified WABA, or one whose
-- procurement insists on holding its own Meta assets, gets a row with
-- ownership='hospital' and its own encrypted credential. Nothing downstream —
-- the webhook resolver, the outbox, the worker — can tell the difference.
CREATE TYPE "public"."whatsapp_integration_status" AS ENUM(
  'not_configured', 'pending', 'validating', 'connected', 'error', 'disconnected'
);--> statement-breakpoint

CREATE TYPE "public"."whatsapp_ownership" AS ENUM('platform', 'hospital');--> statement-breakpoint

-- How the credential was obtained. Only 'manual' is implemented; the other two
-- are here so adopting them later is a code change and not a migration.
CREATE TYPE "public"."whatsapp_onboarding_method" AS ENUM(
  'manual', 'embedded_signup', 'bsp'
);--> statement-breakpoint

CREATE TABLE "whatsapp_integrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"hospital_id" uuid NOT NULL,
	"provider" text DEFAULT 'meta' NOT NULL,
	"ownership" "whatsapp_ownership" DEFAULT 'platform' NOT NULL,
	"onboarding_method" "whatsapp_onboarding_method" DEFAULT 'manual' NOT NULL,
	"status" "whatsapp_integration_status" DEFAULT 'not_configured' NOT NULL,

	-- Meta business id and WhatsApp Business Account id. Under platform
	-- ownership these mirror our own WABA and are informational; under hospital
	-- ownership they are the identity the credential is checked against.
	"business_id" text,
	"waba_id" text,

	-- AES-256-GCM sealed access token, split into its parts so a key rotation
	-- is a re-seal rather than a schema change. NULL under platform ownership:
	-- there is no per-hospital secret to hold, and a column that is always NULL
	-- is a far better outcome than one holding a secret nobody needed.
	"credential_ciphertext" text,
	"credential_iv" text,
	"credential_auth_tag" text,
	"credential_key_version" smallint,

	"connected_at" timestamp with time zone,
	"last_validated_at" timestamp with time zone,
	-- A category from lib/domain/whatsapp-integration.ts, never a provider
	-- message: raw Meta errors quote the token back at you.
	"last_error_code" text,
	"last_error_at" timestamp with time zone,

	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,

	-- All four parts of a sealed credential travel together or not at all.
	-- Half a credential is not a credential, and finding that out at decrypt
	-- time means finding out during a patient's booking.
	CONSTRAINT "whatsapp_integrations_credential_complete" CHECK (
		(
			"credential_ciphertext" IS NULL AND "credential_iv" IS NULL
			AND "credential_auth_tag" IS NULL AND "credential_key_version" IS NULL
		) OR (
			"credential_ciphertext" IS NOT NULL AND "credential_iv" IS NOT NULL
			AND "credential_auth_tag" IS NOT NULL AND "credential_key_version" IS NOT NULL
		)
	),

	-- Enforced by the database rather than by remembering: a platform-owned
	-- integration must never accumulate a per-hospital secret.
	CONSTRAINT "whatsapp_integrations_platform_holds_no_credential" CHECK (
		"ownership" <> 'platform' OR "credential_ciphertext" IS NULL
	)
);
--> statement-breakpoint

ALTER TABLE "whatsapp_integrations" ADD CONSTRAINT "whatsapp_integrations_hospital_id_hospitals_id_fk"
	FOREIGN KEY ("hospital_id") REFERENCES "public"."hospitals"("id")
	ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- One integration per hospital, enforced here rather than by a read-then-write
-- in the service. A double-clicked "Connect" is the normal case, not the
-- exotic one, and two rows would leave the provider picking a credential by
-- luck. When a hospital eventually needs two WABAs, this index is what gets
-- dropped, and `whatsapp_numbers` gains an integration_id — not before.
CREATE UNIQUE INDEX "whatsapp_integrations_one_per_hospital"
	ON "whatsapp_integrations" USING btree ("hospital_id");--> statement-breakpoint

-- Existing hospitals keep working, and keep their number status untouched.
--
-- Runs before row-level security is enabled, exactly as the backfill in 0010
-- did. FORCE RLS subjects even the table owner to the policies, and the policy
-- below requires an `app.hospital_id` that a migration has no business setting;
-- doing this first means the backfill does not depend on the migration role
-- happening to hold BYPASSRLS.
--
-- A hospital already sending messages is by definition connected, so it gets a
-- 'connected' platform integration rather than being dropped back to 'pending'
-- and asked to reconnect something that was never broken. A hospital holding a
-- number that never reached 'registered' gets 'pending', which is exactly where
-- its onboarding actually stands.
--
-- DISTINCT ON collapses the multi-number case: the most advanced number decides
-- the integration's status, since one live sender means the integration works.
INSERT INTO "whatsapp_integrations"
  (hospital_id, provider, ownership, onboarding_method, status, waba_id, connected_at, last_validated_at)
SELECT DISTINCT ON (n.hospital_id)
  n.hospital_id,
  'meta',
  'platform',
  'manual',
  CASE WHEN n.status = 'registered' THEN 'connected'::whatsapp_integration_status
       ELSE 'pending'::whatsapp_integration_status END,
  n.waba_id,
  CASE WHEN n.status = 'registered' THEN coalesce(n.registered_at, n.created_at) END,
  CASE WHEN n.status = 'registered' THEN coalesce(n.registered_at, n.created_at) END
FROM "whatsapp_numbers" n
WHERE n.hospital_id IS NOT NULL
ORDER BY
  n.hospital_id,
  (n.status = 'registered') DESC,
  n.registered_at DESC NULLS LAST,
  n.created_at DESC;--> statement-breakpoint

-- Same isolation as every other tenant table, including FORCE so the
-- application role cannot read past it either.
ALTER TABLE "whatsapp_integrations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "whatsapp_integrations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "whatsapp_integrations"
  USING (hospital_id = nullif(current_setting('app.hospital_id', true), '')::uuid)
  WITH CHECK (hospital_id = nullif(current_setting('app.hospital_id', true), '')::uuid);
