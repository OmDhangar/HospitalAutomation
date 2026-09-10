DO $$ BEGIN
  ALTER TYPE "public"."doctor_schedule_mode" ADD VALUE IF NOT EXISTS 'both';
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
