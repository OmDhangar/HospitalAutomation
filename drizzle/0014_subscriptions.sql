CREATE TYPE "public"."billing_cycle" AS ENUM('monthly', 'annual');--> statement-breakpoint
CREATE TYPE "public"."subscription_status" AS ENUM('trial', 'active', 'expired', 'cancelled', 'suspended');--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"hospital_id" uuid NOT NULL,
	"plan_tier_code" text NOT NULL,
	"billing_cycle" "billing_cycle" DEFAULT 'monthly' NOT NULL,
	"status" "subscription_status" DEFAULT 'active' NOT NULL,
	"price_paise" integer NOT NULL,
	"setup_fee_paise" integer DEFAULT 0 NOT NULL,
	"daily_appointment_capacity" integer NOT NULL,
	"included_appointments" integer NOT NULL,
	"included_messages" integer NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"cancelled_at" timestamp with time zone,
	"change_reason" text,
	"changed_by_user_id" uuid,
	"superseded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_hospital_id_hospitals_id_fk" FOREIGN KEY ("hospital_id") REFERENCES "public"."hospitals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_plan_tier_code_plan_tiers_code_fk" FOREIGN KEY ("plan_tier_code") REFERENCES "public"."plan_tiers"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_changed_by_user_id_users_id_fk" FOREIGN KEY ("changed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "subscriptions_one_current_per_hospital" ON "subscriptions" USING btree ("hospital_id") WHERE superseded_at is null;--> statement-breakpoint
CREATE INDEX "subscriptions_hospital_idx" ON "subscriptions" USING btree ("hospital_id","starts_at");--> statement-breakpoint
CREATE INDEX "subscriptions_expiry_idx" ON "subscriptions" USING btree ("status","ends_at");--> statement-breakpoint

-- Subscriptions are tenant data and get the same isolation as everything else.
ALTER TABLE "subscriptions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "subscriptions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "subscriptions"
  USING (hospital_id = nullif(current_setting('app.hospital_id', true), '')::uuid)
  WITH CHECK (hospital_id = nullif(current_setting('app.hospital_id', true), '')::uuid);--> statement-breakpoint

-- Backfill. Every hospital already carrying a tier gets a current subscription,
-- so nothing has to cope with a null one on day one.
--
-- Allowances and price are copied from the rate card as it stands right now,
-- which is the whole point of holding them on the row: a later repricing must
-- not retroactively change what an existing hospital agreed to.
--
-- The term is anchored to the start of the current calendar month, matching how
-- usage was already being counted before subscriptions existed. That keeps this
-- month's figures continuous across the migration rather than resetting them.
INSERT INTO subscriptions
  (hospital_id, plan_tier_code, billing_cycle, status, price_paise, setup_fee_paise,
   daily_appointment_capacity, included_appointments, included_messages,
   starts_at, ends_at, change_reason)
SELECT
  h.id,
  h.plan_tier_code,
  'monthly',
  'active',
  t.monthly_price_paise,
  0, -- already onboarded; charging a setup fee retrospectively would be wrong
  t.patients_per_day,
  t.included_appointments,
  t.included_messages,
  date_trunc('month', now()),
  date_trunc('month', now()) + interval '1 month',
  'backfill'
FROM hospitals h
JOIN plan_tiers t ON t.code = h.plan_tier_code
WHERE h.plan_tier_code IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM subscriptions s
    WHERE s.hospital_id = h.id AND s.superseded_at IS NULL
  );
