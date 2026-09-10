ALTER TYPE "public"."conversation_state" ADD VALUE IF NOT EXISTS 'awaiting_patient_choice';--> statement-breakpoint
ALTER TYPE "public"."conversation_state" ADD VALUE IF NOT EXISTS 'awaiting_patient_name_age';--> statement-breakpoint
ALTER TABLE "patients" ADD COLUMN IF NOT EXISTS "age" smallint;--> statement-breakpoint
ALTER TABLE "patients" ADD COLUMN IF NOT EXISTS "gender" text;--> statement-breakpoint
DROP INDEX IF EXISTS "patients_hospital_phone_key";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "patients_hospital_phone_name_key" ON "patients" USING btree ("hospital_id","phone_e164","name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "patients_hospital_phone_idx" ON "patients" USING btree ("hospital_id","phone_e164");
