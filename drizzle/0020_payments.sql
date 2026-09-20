-- What a hospital has actually been asked to pay, and whether they paid it.
--
-- Separate from `subscriptions` on purpose. A subscription row is the
-- agreement — which tier, at what price, for which term. A payment row is one
-- attempt to collect against it. They are not one-to-one in either direction:
-- a renewal can be attempted three times before a card works, and a link can
-- be created and never paid at all. Folding payment state into the
-- subscription would make "active" mean two different things and lose every
-- failed attempt, which is exactly the history you need when a hospital says
-- they paid and the plan still lapsed.
--
-- Money is copied onto the row rather than read through to the subscription,
-- for the same reason the subscriptions table already does it: an invoice for
-- September has to stay reproducible after October's repricing.
CREATE TYPE "public"."payment_status" AS ENUM(
  'created', 'paid', 'failed', 'cancelled', 'expired', 'refunded'
);--> statement-breakpoint

CREATE TYPE "public"."payment_purpose" AS ENUM(
  'renewal', 'upgrade', 'setup_fee', 'other'
);--> statement-breakpoint

CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"hospital_id" uuid NOT NULL,
	-- Which term this was collected for. Null once that subscription row has
	-- been superseded, since the payment still happened and still belongs in
	-- the hospital's history.
	"subscription_id" uuid,
	"provider" text DEFAULT 'razorpay' NOT NULL,
	"purpose" "payment_purpose" DEFAULT 'renewal' NOT NULL,
	"status" "payment_status" DEFAULT 'created' NOT NULL,

	-- Base and tax held apart so an invoice can show them as separate lines.
	-- tax_paise is 0 until the business is GST registered; keeping the column
	-- means turning it on is a config change rather than a migration.
	"amount_paise" integer NOT NULL,
	"tax_paise" integer DEFAULT 0 NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,

	-- Razorpay's identifiers. The link is created first; the payment id only
	-- exists once someone actually pays.
	"provider_link_id" text,
	"provider_payment_id" text,
	"short_url" text,

	"expires_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	-- A category or provider error code, never a raw gateway message.
	"failure_reason" text,
	"notes" jsonb,

	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,

	-- A payment that is paid must say when, and must carry the provider's id
	-- for it. Reconciling against a Razorpay settlement report is impossible
	-- without both, and discovering that at reconciliation time is too late.
	CONSTRAINT "payments_paid_has_provenance" CHECK (
		"status" <> 'paid'
		OR ("paid_at" IS NOT NULL AND "provider_payment_id" IS NOT NULL)
	),
	CONSTRAINT "payments_amount_positive" CHECK ("amount_paise" > 0 AND "tax_paise" >= 0)
);
--> statement-breakpoint

ALTER TABLE "payments" ADD CONSTRAINT "payments_hospital_id_hospitals_id_fk"
	FOREIGN KEY ("hospital_id") REFERENCES "public"."hospitals"("id")
	ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "payments" ADD CONSTRAINT "payments_subscription_id_subscriptions_id_fk"
	FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id")
	ON DELETE set null ON UPDATE no action;--> statement-breakpoint

-- The idempotency guarantee. Razorpay retries webhooks until it gets a 2xx,
-- and a retry that renewed the subscription a second time would hand the
-- hospital a free month. Uniqueness at the database makes the second write
-- fail rather than relying on the handler checking first.
CREATE UNIQUE INDEX "payments_provider_payment_id"
	ON "payments" USING btree ("provider_payment_id")
	WHERE "provider_payment_id" IS NOT NULL;--> statement-breakpoint

CREATE UNIQUE INDEX "payments_provider_link_id"
	ON "payments" USING btree ("provider_link_id")
	WHERE "provider_link_id" IS NOT NULL;--> statement-breakpoint

CREATE INDEX "payments_hospital_idx" ON "payments" USING btree ("hospital_id","created_at");--> statement-breakpoint

-- Finds a hospital's reusable open link without scanning its whole history.
CREATE INDEX "payments_open_idx" ON "payments" USING btree ("hospital_id","status")
	WHERE "status" = 'created';--> statement-breakpoint

-- Same tenant isolation as every other hospital-scoped table, including FORCE
-- so the application role cannot read past it either. The webhook runs on the
-- admin connection, which is the established route for system-level work that
-- has no tenant context yet.
ALTER TABLE "payments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "payments" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "payments"
  USING (hospital_id = nullif(current_setting('app.hospital_id', true), '')::uuid)
  WITH CHECK (hospital_id = nullif(current_setting('app.hospital_id', true), '')::uuid);
