-- What each plan actually entitles a hospital to, beyond volume.
--
-- Until now the six tiers differed only in three numbers: patients per day,
-- included appointments, included messages. Nothing in the application was
-- gated by tier at all, so a Solo hospital at ₹1,999 and a Multi-branch one at
-- ₹12,999 received a byte-identical product. Worse, all three differing numbers
-- are invisible at the moment somebody decides to buy — nobody feels the
-- difference between 900 and 2,100 appointments during a demo — so the price
-- gap read as arbitrary. The tier literally named "Multi-branch" did not
-- restrict branches.
--
-- The limits added here were chosen because they are already modelled in the
-- schema (branches, doctors, staff_memberships), map to a hospital's real size
-- so a buyer self-identifies, and cost nothing to check. NULL means unlimited
-- rather than zero, so the top tier and any future bespoke plan need no
-- sentinel value.
--
-- Deliberately not gated: WhatsApp booking, the queue itself, patient
-- notifications, emergency unavailability, and the Marathi/Hindi/English
-- support. Those are why anyone buys the product, and charging for them by
-- tier would damage the cheapest customers, who are the ones that most need to
-- love it.

ALTER TABLE "plan_tiers" ADD COLUMN "max_branches" integer;--> statement-breakpoint
ALTER TABLE "plan_tiers" ADD COLUMN "max_doctors" integer;--> statement-breakpoint
ALTER TABLE "plan_tiers" ADD COLUMN "max_staff_logins" integer;--> statement-breakpoint
ALTER TABLE "plan_tiers" ADD COLUMN "has_display_board" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "plan_tiers" ADD COLUMN "has_owner_report" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "plan_tiers" ADD COLUMN "has_advanced_reports" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "plan_tiers" ADD COLUMN "has_data_export" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "plan_tiers" ADD COLUMN "has_audit_log" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "plan_tiers" ADD COLUMN "support_tier" text DEFAULT 'email' NOT NULL;--> statement-breakpoint

-- The same values are snapshotted onto the subscription, for exactly the
-- reason included_appointments already is: a subscription row is the agreement
-- that was struck. Repricing a tier, or tightening a limit, must never reach
-- backwards and change what an existing customer was sold. Historical usage
-- and historical entitlement both have to be answerable from the subscription
-- alone.
ALTER TABLE "subscriptions" ADD COLUMN "max_branches" integer;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "max_doctors" integer;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "max_staff_logins" integer;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "has_display_board" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "has_owner_report" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "has_advanced_reports" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "has_data_export" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "has_audit_log" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "support_tier" text DEFAULT 'email' NOT NULL;--> statement-breakpoint

-- The ladder. Branch counts leave headroom above what each tier's nameplate
-- size would actually run, because a limit that bites on day one is an
-- onboarding failure rather than an upgrade prompt.
UPDATE "plan_tiers" SET
  max_branches = 1, max_doctors = 1, max_staff_logins = 2,
  has_display_board = false, has_owner_report = false,
  has_advanced_reports = false, has_data_export = false, has_audit_log = false,
  support_tier = 'email_48h'
WHERE code = 'solo';--> statement-breakpoint

UPDATE "plan_tiers" SET
  max_branches = 1, max_doctors = 3, max_staff_logins = 4,
  has_display_board = true, has_owner_report = false,
  has_advanced_reports = false, has_data_export = false, has_audit_log = false,
  support_tier = 'email_24h'
WHERE code = 'clinic';--> statement-breakpoint

UPDATE "plan_tiers" SET
  max_branches = 1, max_doctors = 6, max_staff_logins = 8,
  has_display_board = true, has_owner_report = true,
  has_advanced_reports = true, has_data_export = true, has_audit_log = false,
  support_tier = 'whatsapp_12h'
WHERE code = 'practice';--> statement-breakpoint

UPDATE "plan_tiers" SET
  max_branches = 3, max_doctors = 12, max_staff_logins = 15,
  has_display_board = true, has_owner_report = true,
  has_advanced_reports = true, has_data_export = true, has_audit_log = true,
  support_tier = 'whatsapp_4h'
WHERE code = 'hospital';--> statement-breakpoint

UPDATE "plan_tiers" SET
  max_branches = 5, max_doctors = 20, max_staff_logins = 25,
  has_display_board = true, has_owner_report = true,
  has_advanced_reports = true, has_data_export = true, has_audit_log = true,
  support_tier = 'priority_4h'
WHERE code = 'large_opd';--> statement-breakpoint

-- NULL rather than a large number: unlimited is a different statement from
-- "more than you will ever need", and the top tier is sold on it.
UPDATE "plan_tiers" SET
  max_branches = NULL, max_doctors = NULL, max_staff_logins = NULL,
  has_display_board = true, has_owner_report = true,
  has_advanced_reports = true, has_data_export = true, has_audit_log = true,
  support_tier = 'dedicated'
WHERE code = 'multi_branch';--> statement-breakpoint

-- Existing subscriptions take the entitlements of the tier they were sold on.
-- Running terms only: a superseded row recorded an agreement that has already
-- closed, and rewriting it would change history rather than describe it.
UPDATE "subscriptions" s SET
  max_branches = t.max_branches,
  max_doctors = t.max_doctors,
  max_staff_logins = t.max_staff_logins,
  has_display_board = t.has_display_board,
  has_owner_report = t.has_owner_report,
  has_advanced_reports = t.has_advanced_reports,
  has_data_export = t.has_data_export,
  has_audit_log = t.has_audit_log,
  support_tier = t.support_tier
FROM "plan_tiers" t
WHERE t.code = s.plan_tier_code
  AND s.ends_at > now();
