create function public.s2a_openai_quota_cache_save(p_account_id uuid,p_version bigint,p_fetched_at bigint,p_credits jsonb,p_reset_credits jsonb default null)
returns boolean language plpgsql set search_path='' as $$
declare patch jsonb; detail jsonb; details jsonb;
begin
 if p_fetched_at is null or p_fetched_at<0 or p_fetched_at>extract(epoch from now())+120 then raise exception 'invalid_quota_snapshot';end if;
 if p_credits is not null and p_credits<>'null'::jsonb and (jsonb_typeof(p_credits)<>'object'
  or jsonb_typeof(p_credits->'has_credits') is distinct from 'boolean' or jsonb_typeof(p_credits->'unlimited') is distinct from 'boolean'
  or not p_credits?'balance' or (p_credits->'balance'<>'null'::jsonb and (jsonb_typeof(p_credits->'balance')<>'string' or p_credits->>'balance' !~ '^-?[0-9]+(\.[0-9]+)?$'))
  or length(p_credits->>'balance')>100 or octet_length(p_credits::text)>1024) then raise exception 'invalid_quota_snapshot';end if;
 if p_reset_credits is not null and p_reset_credits<>'null'::jsonb then
  if jsonb_typeof(p_reset_credits)<>'object' or jsonb_typeof(p_reset_credits->'available_count') is distinct from 'number'
   or p_reset_credits->>'available_count' !~ '^[0-9]+$' or (p_reset_credits->>'available_count')::numeric>1000000
   or octet_length(p_reset_credits::text)>128*1024 then raise exception 'invalid_quota_snapshot';end if;
  if (p_reset_credits->>'available_count')::integer>0 and (jsonb_typeof(p_reset_credits->'credits') is distinct from 'array'
   or jsonb_array_length(p_reset_credits->'credits')<(p_reset_credits->>'available_count')::integer) then raise exception 'incomplete_reset_credit_snapshot';end if;
  if p_reset_credits?'credits' and p_reset_credits->'credits'<>'null'::jsonb then
   if jsonb_typeof(p_reset_credits->'credits')<>'array' or jsonb_array_length(p_reset_credits->'credits')>1000 then raise exception 'invalid_quota_snapshot';end if;
   details:='[]'::jsonb;
   for detail in select value from jsonb_array_elements(p_reset_credits->'credits') loop
    if jsonb_typeof(detail)<>'object' or jsonb_typeof(detail->'expires_at') is distinct from 'string' or length(detail->>'expires_at')>64 then raise exception 'invalid_quota_snapshot';end if;
    begin perform (detail->>'expires_at')::timestamptz;exception when others then raise exception 'invalid_quota_snapshot';end;
    details:=details||jsonb_build_array(jsonb_build_object('expires_at',detail->>'expires_at'));
   end loop;
   p_reset_credits:=jsonb_build_object('available_count',p_reset_credits->'available_count','credits',details);
  else
   p_reset_credits:=jsonb_build_object('available_count',p_reset_credits->'available_count');
  end if;
 end if;
 if p_credits is not null and p_credits<>'null'::jsonb then p_credits:=jsonb_build_object('has_credits',p_credits->'has_credits','unlimited',p_credits->'unlimited','balance',p_credits->'balance');end if;
 patch:=jsonb_build_object('codex_credits_snapshot',jsonb_build_object('credits',coalesce(p_credits,'null'::jsonb),'fetched_at',p_fetched_at));
 if p_reset_credits is not null and p_reset_credits<>'null'::jsonb then patch:=patch||jsonb_build_object('codex_reset_credit_snapshot',p_reset_credits);end if;
 update public.s2a_accounts set extra=extra||patch where id=p_account_id and platform='openai' and type='oauth' and credential_version=p_version
  and (case when extra->'codex_credits_snapshot'->>'fetched_at' ~ '^[0-9]+$' then (extra->'codex_credits_snapshot'->>'fetched_at')::numeric else -1 end)<=p_fetched_at;
 return found;
end $$;
revoke all on function public.s2a_openai_quota_cache_save(uuid,bigint,bigint,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.s2a_openai_quota_cache_save(uuid,bigint,bigint,jsonb,jsonb) to service_role;
notify pgrst,'reload schema';
