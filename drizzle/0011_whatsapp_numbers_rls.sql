-- Same isolation as every other tenant table. A number with a NULL hospital_id
-- is unassigned inventory, and stays invisible to every tenant — which is
-- exactly right, since it belongs to us and not to any of them yet.
ALTER TABLE "whatsapp_numbers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "whatsapp_numbers" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "whatsapp_numbers"
  USING (hospital_id = nullif(current_setting('app.hospital_id', true), '')::uuid)
  WITH CHECK (hospital_id = nullif(current_setting('app.hospital_id', true), '')::uuid);--> statement-breakpoint

-- provider_invoices is deliberately left without RLS: it holds what Meta
-- charged us across every hospital, is never shown to a tenant, and is only
-- ever read by the platform dashboard on the admin connection.

-- The bootstrap lookup now resolves through the numbers table. Contract is
-- unchanged: one identifier in, one hospital id out. A number that is not
-- registered resolves to nothing, so a suspended or released number stops
-- accepting inbound messages without any application code noticing.
CREATE OR REPLACE FUNCTION public.resolve_whatsapp_number(p_phone_number_id text)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT n.hospital_id
  FROM whatsapp_numbers n
  JOIN hospitals h ON h.id = n.hospital_id
  WHERE n.phone_number_id = p_phone_number_id
    AND n.status = 'registered'
    AND h.active = true
$fn$;
