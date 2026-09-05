CREATE TYPE "public"."whatsapp_number_status" AS ENUM('pending', 'registered', 'flagged', 'suspended', 'released');--> statement-breakpoint
CREATE TABLE "provider_invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text DEFAULT 'meta' NOT NULL,
	"period_month" date NOT NULL,
	"messages_billed" integer NOT NULL,
	"amount_paise" integer NOT NULL,
	"notes" text,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "whatsapp_numbers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"hospital_id" uuid,
	"waba_id" text,
	"phone_number_id" text NOT NULL,
	"display_phone_number" text,
	"verified_name" text,
	"status" "whatsapp_number_status" DEFAULT 'pending' NOT NULL,
	"quality_rating" text,
	"messaging_tier" text,
	"registered_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "whatsapp_numbers_phone_number_id_unique" UNIQUE("phone_number_id")
);
--> statement-breakpoint
ALTER TABLE "hospitals" DROP CONSTRAINT "hospitals_whatsapp_phone_number_id_unique";--> statement-breakpoint
ALTER TABLE "whatsapp_numbers" ADD CONSTRAINT "whatsapp_numbers_hospital_id_hospitals_id_fk" FOREIGN KEY ("hospital_id") REFERENCES "public"."hospitals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "provider_invoices_key" ON "provider_invoices" USING btree ("provider","period_month");--> statement-breakpoint
CREATE INDEX "whatsapp_numbers_hospital_idx" ON "whatsapp_numbers" USING btree ("hospital_id");--> statement-breakpoint
-- Move any already-configured numbers into the new table before the column
-- goes away. Existing rows were registered and working, so they are marked as
-- such rather than dropped back to 'pending'.
INSERT INTO "whatsapp_numbers" (hospital_id, phone_number_id, status, registered_at)
SELECT id, whatsapp_phone_number_id, 'registered', now()
FROM "hospitals"
WHERE whatsapp_phone_number_id IS NOT NULL;--> statement-breakpoint

ALTER TABLE "hospitals" DROP COLUMN "whatsapp_phone_number_id";