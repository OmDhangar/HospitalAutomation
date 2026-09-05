ALTER TABLE "whatsapp_conversations" ADD COLUMN "last_prompt_step" text;--> statement-breakpoint
ALTER TABLE "whatsapp_conversations" ADD COLUMN "last_prompt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "whatsapp_conversations" ADD COLUMN "prompts_today" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "whatsapp_conversations" ADD COLUMN "prompts_date" date;