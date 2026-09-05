CREATE TYPE "public"."conversation_state" AS ENUM('idle', 'awaiting_language', 'awaiting_doctor', 'awaiting_slot');--> statement-breakpoint
CREATE TABLE "whatsapp_conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"hospital_id" uuid NOT NULL,
	"phone_e164" text NOT NULL,
	"state" "conversation_state" DEFAULT 'idle' NOT NULL,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_inbound_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "hospitals" ADD COLUMN "whatsapp_phone_number_id" text;--> statement-breakpoint
ALTER TABLE "whatsapp_conversations" ADD CONSTRAINT "whatsapp_conversations_hospital_id_hospitals_id_fk" FOREIGN KEY ("hospital_id") REFERENCES "public"."hospitals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "whatsapp_conversations_key" ON "whatsapp_conversations" USING btree ("hospital_id","phone_e164");--> statement-breakpoint
ALTER TABLE "hospitals" ADD CONSTRAINT "hospitals_whatsapp_phone_number_id_unique" UNIQUE("whatsapp_phone_number_id");