-- Resolving a patient's queue link is the one read that legitimately has no
-- tenant context yet: the token is all the browser sends, and RLS needs a
-- hospital id before it will return anything.
--
-- Rather than putting the RLS-bypassing admin connection into the web request
-- path, this SECURITY DEFINER function does exactly one thing and returns
-- exactly one column. Possessing a 128-bit unguessable token already implies
-- access to that appointment, so learning its hospital id reveals nothing new.
--
-- EXECUTE is granted to the application role by scripts/migrate.ts, which knows
-- the role name from APP_DB_ROLE.

CREATE OR REPLACE FUNCTION public.resolve_public_token(p_token text)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT hospital_id FROM appointments WHERE public_token = p_token
$fn$;--> statement-breakpoint

REVOKE ALL ON FUNCTION public.resolve_public_token(text) FROM PUBLIC;
