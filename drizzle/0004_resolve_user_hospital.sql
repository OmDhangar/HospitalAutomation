-- The second and last bootstrap lookup.
--
-- Establishing a session has the same chicken-and-egg shape as opening a
-- patient link: the row that says which hospital a user belongs to is itself
-- protected by that hospital's row-level security. Something has to break the
-- cycle.
--
-- The rule for these functions: each takes one identifier the caller already
-- possesses, returns only a hospital id, and reads nothing else. Anything
-- richer belongs behind withTenant.

CREATE OR REPLACE FUNCTION public.resolve_user_hospital(p_user_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT hospital_id
  FROM staff_memberships
  WHERE user_id = p_user_id AND active = true
  ORDER BY created_at
  LIMIT 1
$fn$;--> statement-breakpoint

REVOKE ALL ON FUNCTION public.resolve_user_hospital(uuid) FROM PUBLIC;
