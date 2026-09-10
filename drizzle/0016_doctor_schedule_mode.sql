ALTER TYPE "public"."conversation_state" ADD VALUE IF NOT EXISTS 'awaiting_queue_choice';--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."doctor_schedule_mode" AS ENUM('queue', 'slot');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "doctor_schedules" ADD COLUMN "mode" "public"."doctor_schedule_mode" DEFAULT 'queue' NOT NULL;
EXCEPTION
  WHEN duplicate_column THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "doctor_day_states" ADD COLUMN "mode" "public"."doctor_schedule_mode";
EXCEPTION
  WHEN duplicate_column THEN null;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "appointments_patient_status_idx" ON "appointments" ("patient_id", "status");
