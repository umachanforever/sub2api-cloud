-- Renew only active leases: never resurrect a finished or expired request.
CREATE OR REPLACE FUNCTION public.s2a_personal_lease_renew(p_lease_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 UPDATE s2a_private.personal_gateway_leases
 SET expires_at=clock_timestamp()+interval '150 seconds'
 WHERE id=p_lease_id AND finished_at IS NULL AND expires_at>clock_timestamp();
 RETURN FOUND;
END;
$$;
REVOKE ALL ON FUNCTION public.s2a_personal_lease_renew(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.s2a_personal_lease_renew(uuid) TO service_role;
