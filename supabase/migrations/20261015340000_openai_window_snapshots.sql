create function public.s2a_openai_windows_validate(p_windows jsonb) returns void
language plpgsql immutable set search_path='' as $$
declare entry record;
begin
 if p_windows is null or jsonb_typeof(p_windows)<>'object' or octet_length(p_windows::text)>8192 then raise exception 'invalid_quota_windows';end if;
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
end $$;
create function public.s2a_openai_windows_save(p_account_id uuid,p_version bigint,p_fetched_at bigint,p_windows jsonb)
returns boolean language plpgsql security definer set search_path='' as $$
begin
 if p_fetched_at is null or p_fetched_at<0 or p_fetched_at>extract(epoch from now())+120 then raise exception 'invalid_quota_windows';end if;
 perform public.s2a_openai_windows_validate(p_windows);
 update public.s2a_accounts set extra=extra||p_windows||jsonb_build_object('codex_usage_updated_at',to_char(to_timestamp(p_fetched_at) at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'))
 where id=p_account_id and platform='openai' and type='oauth' and credential_version=p_version
 and coalesce(public.s2a_quota_pause_time(extra->'codex_usage_updated_at'),'-infinity'::timestamptz)<=to_timestamp(p_fetched_at);
 return found;
end $$;
create or replace function public.s2a_openai_quota_cache_save(p_account_id uuid,p_version bigint,p_fetched_at bigint,p_credits jsonb,p_reset_credits jsonb default null,p_windows jsonb default null)
returns boolean language plpgsql security definer set search_path='' as $$
declare a public.s2a_accounts;
begin
 if p_windows is not null then
  perform public.s2a_openai_windows_validate(p_windows);
  select * into a from public.s2a_accounts where id=p_account_id for update;
  if not found or public.s2a_quota_pause_time(a.extra->'codex_usage_updated_at')>to_timestamp(p_fetched_at) then return false;end if;
 end if;
 if not public.s2a_openai_quota_cache_write(p_account_id,p_version,p_fetched_at,p_credits,p_reset_credits) then return false;end if;
 if p_windows is not null then update public.s2a_accounts set extra=extra||p_windows where id=p_account_id;end if;
 return true;
end $$;

create function public.s2a_openai_auto_reset_wake() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if (new.extra->'codex_usage_updated_at' is distinct from old.extra->'codex_usage_updated_at'
  or new.extra->'codex_5h_used_percent' is distinct from old.extra->'codex_5h_used_percent'
  or new.extra->'codex_7d_used_percent' is distinct from old.extra->'codex_7d_used_percent')
  and new.extra->'auto_reset_credit_enabled'='true'::jsonb
  and public.s2a_openai_quota_paused(new.extra,new.platform,new.type) then
  update public.s2a_openai_auto_reset_jobs set next_attempt_at=least(next_attempt_at,now()) where account_id=new.id and (lease_until is null or lease_until<=now());
 end if;
 return new;
end $$;
create trigger s2a_openai_auto_reset_wake after update of extra on public.s2a_accounts
 for each row execute function public.s2a_openai_auto_reset_wake();
revoke all on function public.s2a_openai_windows_validate(jsonb),public.s2a_openai_auto_reset_wake() from public,anon,authenticated,service_role;
revoke all on function public.s2a_openai_windows_save(uuid,bigint,bigint,jsonb) from public,anon,authenticated;
grant execute on function public.s2a_openai_windows_save(uuid,bigint,bigint,jsonb) to service_role;
notify pgrst,'reload schema';
