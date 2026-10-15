alter function public.s2a_openai_quota_cache_save(uuid,bigint,bigint,jsonb,jsonb) rename to s2a_openai_quota_cache_write;
revoke all on function public.s2a_openai_quota_cache_write(uuid,bigint,bigint,jsonb,jsonb) from service_role;
create function public.s2a_openai_quota_cache_save(p_account_id uuid,p_version bigint,p_fetched_at bigint,p_credits jsonb,p_reset_credits jsonb default null,p_windows jsonb default null)
returns boolean language plpgsql security definer set search_path='' as $$
declare entry record;
begin
 if p_windows is not null then
  if jsonb_typeof(p_windows)<>'object' or octet_length(p_windows::text)>8192 then raise exception 'invalid_quota_windows';end if;
  for entry in select * from jsonb_each(p_windows) loop
   if entry.key in ('codex_5h_reset_at','codex_7d_reset_at','codex_usage_updated_at') then
    if jsonb_typeof(entry.value)<>'string' or length(entry.value#>>'{}')>64 then raise exception 'invalid_quota_windows';end if;
    begin perform (entry.value#>>'{}')::timestamptz;exception when others then raise exception 'invalid_quota_windows';end;
   elsif entry.key in ('codex_5h_used_percent','codex_7d_used_percent','codex_5h_reset_after_seconds','codex_7d_reset_after_seconds','codex_5h_window_minutes','codex_7d_window_minutes') then
    if jsonb_typeof(entry.value)<>'number' then raise exception 'invalid_quota_windows';end if;
    if entry.key not like '%reset_after_seconds' and (entry.value#>>'{}')::numeric<0 then raise exception 'invalid_quota_windows';end if;
    if entry.key not like '%used_percent' and (entry.value#>>'{}') !~ '^-?[0-9]+$' then raise exception 'invalid_quota_windows';end if;
   else raise exception 'invalid_quota_windows';end if;
  end loop;
 end if;
 if not public.s2a_openai_quota_cache_write(p_account_id,p_version,p_fetched_at,p_credits,p_reset_credits) then return false;end if;
 if p_windows is not null then update public.s2a_accounts set extra=extra||p_windows where id=p_account_id;end if;
 return true;
end $$;
revoke all on function public.s2a_openai_quota_cache_save(uuid,bigint,bigint,jsonb,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.s2a_openai_quota_cache_save(uuid,bigint,bigint,jsonb,jsonb,jsonb) to service_role;
notify pgrst,'reload schema';
