create function public.s2a_group_account_count(g public.s2a_groups)
returns bigint language sql stable set search_path='' as $$
 select count(*) from public.s2a_account_groups where group_id=g.id;
$$;
revoke all on function public.s2a_group_account_count(public.s2a_groups) from public,anon,authenticated;
grant execute on function public.s2a_group_account_count(public.s2a_groups) to service_role;
notify pgrst,'reload schema';
