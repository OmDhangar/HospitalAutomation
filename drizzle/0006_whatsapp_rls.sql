-- The new tenant table needs the same isolation as every other one. Adding a
-- table without this is the one mistake that would quietly undo tenancy, so it
-- belongs in the same migration series rather than in a checklist somewhere.
ALTER TABLE "whatsapp_conversations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "whatsapp_conversations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "whatsapp_conversations"
  USING (hospital_id = nullif(current_setting('app.hospital_id', true), '')::uuid)
  WITH CHECK (hospital_id = nullif(current_setting('app.hospital_id', true), '')::uuid);--> statement-breakpoint

-- The third and final bootstrap lookup: an inbound WhatsApp webhook knows only
-- Meta's phone number id, and needs a hospital before anything else can happen.
-- Same contract as the others — one identifier in, one hospital id out.
CREATE OR REPLACE FUNCTION public.resolve_whatsapp_number(p_phone_number_id text)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT id FROM hospitals
  WHERE whatsapp_phone_number_id = p_phone_number_id AND active = true
$fn$;--> statement-breakpoint

REVOKE ALL ON FUNCTION public.resolve_whatsapp_number(text) FROM PUBLIC;
