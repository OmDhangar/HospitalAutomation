CREATE TYPE "public"."doctor_schedule_mode" AS ENUM('queue', 'slot');--> statement-breakpoint
ALTER TYPE "public"."conversation_state" ADD VALUE 'awaiting_active_choice' BEFORE 'awaiting_doctor';--> statement-breakpoint
ALTER TYPE "public"."conversation_state" ADD VALUE 'awaiting_queue_choice' BEFORE 'awaiting_slot';--> statement-breakpoint
CREATE TABLE "doctor_interval_blocks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"hospital_id" uuid NOT NULL,
	"doctor_id" uuid NOT NULL,
	"service_date" date NOT NULL,
	"start_time" time NOT NULL,
	"end_time" time NOT NULL,
	"reason" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "doctor_slot_overrides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"hospital_id" uuid NOT NULL,
	"doctor_id" uuid NOT NULL,
	"service_date" date NOT NULL,
	"slot_time" time NOT NULL,
	"is_available" boolean DEFAULT true NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "doctor_day_states" ADD COLUMN "mode" "doctor_schedule_mode";--> statement-breakpoint
ALTER TABLE "doctor_schedules" ADD COLUMN "mode" "doctor_schedule_mode" DEFAULT 'queue' NOT NULL;--> statement-breakpoint
ALTER TABLE "doctor_schedules" ADD COLUMN "break_start_time" time;--> statement-breakpoint
ALTER TABLE "doctor_schedules" ADD COLUMN "break_end_time" time;--> statement-breakpoint
ALTER TABLE "doctor_interval_blocks" ADD CONSTRAINT "doctor_interval_blocks_hospital_id_hospitals_id_fk" FOREIGN KEY ("hospital_id") REFERENCES "public"."hospitals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doctor_interval_blocks" ADD CONSTRAINT "doctor_interval_blocks_doctor_id_doctors_id_fk" FOREIGN KEY ("doctor_id") REFERENCES "public"."doctors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doctor_slot_overrides" ADD CONSTRAINT "doctor_slot_overrides_hospital_id_hospitals_id_fk" FOREIGN KEY ("hospital_id") REFERENCES "public"."hospitals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doctor_slot_overrides" ADD CONSTRAINT "doctor_slot_overrides_doctor_id_doctors_id_fk" FOREIGN KEY ("doctor_id") REFERENCES "public"."doctors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "doctor_interval_blocks_idx" ON "doctor_interval_blocks" USING btree ("doctor_id","service_date");--> statement-breakpoint
CREATE UNIQUE INDEX "doctor_slot_overrides_key" ON "doctor_slot_overrides" USING btree ("doctor_id","service_date","slot_time");--> statement-breakpoint
CREATE INDEX "appointments_patient_status_idx" ON "appointments" USING btree ("patient_id","status");