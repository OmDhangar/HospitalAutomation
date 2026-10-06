-- Emergency Admissions & Red Alert highlight.
--
-- Adds is_emergency boolean column to appointments table to explicitly
-- identify patients admitted through emergency for highest queue priority
-- and doctor red-alert highlighting.

ALTER TABLE appointments ADD COLUMN IF NOT EXISTS is_emergency boolean NOT NULL DEFAULT false;
