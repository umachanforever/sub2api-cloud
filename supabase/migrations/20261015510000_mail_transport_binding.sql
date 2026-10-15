alter table public.s2a_ops_mail_delivery add column transport text check(transport in('http','smtp'));
alter function public.s2a_ops_mail_claim() rename to s2a_ops_mail_claim_without_transport;
revoke all on function public.s2a_ops_mail_claim_without_transport() from service_role;
create function public.s2a_ops_mail_claim(p_transport text default 'http') returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
 if p_transport is null or p_transport not in('http','smtp') then raise exception 'invalid_mail_transport';end if;
 if not pg_try_advisory_xact_lock(hashtextextended('s2a-ops-mail-dispatch',0)) then return '[]';end if;
 -- An expired SMTP lease cannot prove whether the remote server accepted DATA.
 update public.s2a_ops_mail_delivery set status='failed',last_error='smtp_delivery_uncertain',lease_id=null,lease_until=null
 where transport='smtp' and status='sending' and lease_until<=now();
 update public.s2a_ops_mail_delivery set status='failed',last_error='delivery_transport_changed',lease_id=null,lease_until=null
 where transport is not null and transport<>p_transport and status in('pending','sending') and (lease_until is null or lease_until<=now());
 result:=public.s2a_ops_mail_claim_without_transport();
 update public.s2a_ops_mail_delivery set transport=p_transport where id in(select (value->>'id')::uuid from jsonb_array_elements(result));
 return result;
end $$;
revoke all on function public.s2a_ops_mail_claim(text) from public,anon,authenticated;
grant execute on function public.s2a_ops_mail_claim(text) to service_role;
notify pgrst,'reload schema';
