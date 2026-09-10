ALTER TYPE "public"."conversation_state" ADD VALUE 'awaiting_queue_choice';
CREATE TYPE "public"."doctor_schedule_mode" AS ENUM('queue', 'slot');
ALTER TABLE "doctor_schedules" ADD COLUMN "mode" "public"."doctor_schedule_mode" DEFAULT 'queue' NOT NULL;
ALTER TABLE "doctor_day_states" ADD COLUMN "mode" "public"."doctor_schedule_mode";
CREATE INDEX "appointments_patient_status_idx" ON "appointments" ("patient_id", "status");
