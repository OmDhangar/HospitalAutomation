CREATE TYPE "public"."demo_request_status" AS ENUM('new', 'contacted', 'demoed', 'won', 'lost');--> statement-breakpoint
CREATE TABLE "demo_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"organisation" text NOT NULL,
	"phone_e164" text NOT NULL,
	"city" text NOT NULL,
	"patients_per_day" text NOT NULL,
	"status" "demo_request_status" DEFAULT 'new' NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "plan_tiers" ALTER COLUMN "overage_paise_per_appointment" SET DEFAULT 100;--> statement-breakpoint
ALTER TABLE "plan_tiers" ADD COLUMN "patients_per_day" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "plan_tiers" ADD COLUMN "included_messages" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "plan_tiers" ADD COLUMN "annual_price_paise" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "plan_tiers" ADD COLUMN "setup_fee_paise" integer DEFAULT 500000 NOT NULL;--> statement-breakpoint
ALTER TABLE "plan_tiers" ADD COLUMN "overage_paise_per_message" integer DEFAULT 25 NOT NULL;--> statement-breakpoint
CREATE INDEX "demo_requests_phone_created_idx" ON "demo_requests" USING btree ("phone_e164","created_at");--> statement-breakpoint
CREATE INDEX "demo_requests_created_idx" ON "demo_requests" USING btree ("created_at");--> statement-breakpoint

-- Repricing v2. Three tier codes disappear and two change meaning, so existing
-- hospitals have to be moved before the rows they point at are rewritten.
-- Order matters throughout: hospitals.plan_tier_code is a foreign key.

-- 1. The genuinely new codes, so there is somewhere to move hospitals to.
INSERT INTO plan_tiers
  (code, name, patients_per_day, included_appointments, included_messages,
   monthly_price_paise, annual_price_paise, setup_fee_paise,
   overage_paise_per_appointment, overage_paise_per_message, sort_order)
VALUES
  ('solo',      'Solo',       25,   900,  3600,  199900,  1999000, 500000, 100, 25, 0),
  ('practice',  'Practice',  100,  3500, 14000,  499900,  4999000, 500000, 100, 25, 2),
  ('hospital',  'Hospital',  150,  5300, 21200,  699900,  6999000, 500000, 100, 25, 3),
  ('large_opd', 'Large OPD', 200,  7000, 28000,  899900,  8999000, 500000, 100, 25, 4)
ON CONFLICT (code) DO NOTHING;--> statement-breakpoint

-- 2. Move existing hospitals onto the closest equivalent, holding price where
--    possible. 'large' becomes 'hospital' rather than 'large_opd' precisely
--    because both are ₹6,999 — an existing customer should not get a price rise
--    out of a repricing they did not ask for.
--    'clinic' must be vacated first: the code survives but its meaning changes
--    from 800 appointments to 2,100.
UPDATE hospitals SET plan_tier_code = 'solo'     WHERE plan_tier_code = 'clinic';--> statement-breakpoint
UPDATE hospitals SET plan_tier_code = 'clinic'   WHERE plan_tier_code = 'small';--> statement-breakpoint
UPDATE hospitals SET plan_tier_code = 'practice' WHERE plan_tier_code = 'standard';--> statement-breakpoint
UPDATE hospitals SET plan_tier_code = 'hospital' WHERE plan_tier_code = 'large';--> statement-breakpoint

-- 3. Now the two surviving codes can take their new values safely.
UPDATE plan_tiers SET
  name = 'Clinic', patients_per_day = 60, included_appointments = 2100,
  included_messages = 8400, monthly_price_paise = 349900,
  annual_price_paise = 3499000, setup_fee_paise = 500000,
  overage_paise_per_appointment = 100, overage_paise_per_message = 25,
  sort_order = 1, active = true
WHERE code = 'clinic';--> statement-breakpoint

UPDATE plan_tiers SET
  name = 'Multi-branch', patients_per_day = 300, included_appointments = 10500,
  included_messages = 42000, monthly_price_paise = 1299900,
  annual_price_paise = 12999000, setup_fee_paise = 500000,
  overage_paise_per_appointment = 100, overage_paise_per_message = 25,
  sort_order = 5, active = true
WHERE code = 'multi_branch';--> statement-breakpoint

-- 4. Retire the codes nothing references any more.
DELETE FROM plan_tiers WHERE code IN ('small', 'standard', 'large');
