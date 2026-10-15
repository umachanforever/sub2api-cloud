alter table public.s2a_groups add column require_privacy_set boolean not null default false;

create or replace function public.s2a_group_create(p_name text,p_user_id uuid,p_platform text default 'openai',p_rate_multiplier numeric default 1,p_options jsonb default '{}')
returns jsonb language plpgsql set search_path='' as $$
declare g public.s2a_groups;
begin
 if p_options is null or jsonb_typeof(p_options)<>'object' or exists(select 1 from jsonb_object_keys(p_options) k where k not in ('is_exclusive','require_privacy_set','rpm_limit','description','sort_order','subscription_type','daily_limit_usd','weekly_limit_usd','monthly_limit_usd')) then
  return jsonb_build_object('error','invalid_group_options','status',400);
 end if;
 if p_options ? 'require_privacy_set' and jsonb_typeof(p_options->'require_privacy_set') is distinct from 'boolean' then return jsonb_build_object('error','invalid_group_options','status',400);end if;
 insert into public.s2a_groups(name,platform,rate_multiplier,is_exclusive,require_privacy_set,rpm_limit,description,sort_order,subscription_type,daily_limit_usd,weekly_limit_usd,monthly_limit_usd)
 values(p_name,p_platform,p_rate_multiplier,coalesce((p_options->>'is_exclusive')::boolean,false),coalesce((p_options->>'require_privacy_set')::boolean,false),coalesce((p_options->>'rpm_limit')::integer,0),p_options->>'description',coalesce((p_options->>'sort_order')::integer,0),coalesce(p_options->>'subscription_type','standard'),(p_options->>'daily_limit_usd')::numeric,(p_options->>'weekly_limit_usd')::numeric,(p_options->>'monthly_limit_usd')::numeric) returning * into g;
 insert into public.s2a_memberships(user_id,group_id) values(p_user_id,g.id);
 return to_jsonb(g);
end $$;

create or replace function public.s2a_groups_available(p_user_id uuid) returns jsonb
language sql stable set search_path='' as $$
 select coalesce(jsonb_agg(jsonb_build_object('id',id,'name',name,'platform',platform,'enabled',enabled,
  'created_at',created_at,'description',description,'sort_order',sort_order,'rate_multiplier',rate_multiplier,
  'is_exclusive',is_exclusive,'require_privacy_set',require_privacy_set,'rpm_limit',rpm_limit,'subscription_type',subscription_type,
  'daily_limit_usd',daily_limit_usd,'weekly_limit_usd',weekly_limit_usd,'monthly_limit_usd',monthly_limit_usd) order by sort_order,id),'[]'::jsonb)
 from public.s2a_groups where public.s2a_group_can_bind(p_user_id,id);
$$;

create or replace function public.s2a_acquire_key(
  p_key_hash text, p_model text, p_request_id uuid,
  p_excluded uuid[] default '{}', p_count_request boolean default true
) returns jsonb language plpgsql set search_path = '' as $$
declare k public.s2a_keys; a public.s2a_accounts; lease_id uuid;
begin
  select * into k from public.s2a_keys where key_hash = p_key_hash for update;
  if not found or k.revoked or k.expires_at <= now() then return jsonb_build_object('error', 'invalid_api_key', 'status', 401); end if;
  if not exists (select 1 from auth.users u where u.id = k.user_id and (u.banned_until is null or u.banned_until <= now())) then return jsonb_build_object('error', 'invalid_api_key', 'status', 401); end if;
  if not public.s2a_group_can_bind(k.user_id,k.group_id) then return jsonb_build_object('error', 'group_access_denied', 'status', 403); end if;
  if k.quota_total is not null and k.quota_used >= k.quota_total then return jsonb_build_object('error', 'quota_exceeded', 'status', 429); end if;
  if p_count_request then
    if k.window_start <= now() - interval '60 seconds' then update public.s2a_keys set window_start = now(), window_count = 0 where id = k.id; k.window_count := 0; end if;
    if k.window_count >= k.rpm then return jsonb_build_object('error', 'rate_limit_exceeded', 'status', 429); end if;
  end if;
  delete from public.s2a_leases where expires_at <= now();
  if (select count(*) from public.s2a_leases l where l.key_id = k.id) >= k.concurrency then return jsonb_build_object('error', 'concurrency_limit_exceeded', 'status', 429); end if;
  select candidate.* into a from public.s2a_accounts candidate join public.s2a_account_groups ag on ag.account_id = candidate.id and ag.group_id = k.group_id
    where (not (select require_privacy_set from public.s2a_groups where id=k.group_id) or
      case candidate.platform when 'openai' then candidate.extra->>'privacy_mode'='training_off' when 'antigravity' then candidate.extra->>'privacy_mode'='privacy_set' else true end)
      and candidate.status = 'active' and candidate.schedulable and (not candidate.auto_pause_on_expired or candidate.expires_at is null or candidate.expires_at > now())
      and (candidate.cooldown_until is null or candidate.cooldown_until <= now()) and not (candidate.id = any(p_excluded))
      and (select count(*) from public.s2a_leases l where l.account_id = candidate.id) < candidate.concurrency
    order by candidate.priority,
      (select count(*)::numeric from public.s2a_leases l where l.account_id=candidate.id)/coalesce(candidate.load_factor,candidate.concurrency), candidate.last_used_at nulls first, candidate.id limit 1 for update skip locked;
  if not found then return jsonb_build_object('error', 'no_available_account', 'status', 503); end if;
  if (select count(*) from public.s2a_leases l where l.account_id = a.id and l.expires_at > now()) >= a.concurrency then return jsonb_build_object('error', 'no_available_account', 'status', 503); end if;
  insert into public.s2a_leases(request_id, account_id, key_id, model) values (p_request_id, a.id, k.id, p_model) returning id into lease_id;
  update public.s2a_accounts set last_used_at = now() where id = a.id;
  if p_count_request then update public.s2a_keys set window_count = window_count + 1 where id = k.id; end if;
  return jsonb_build_object('lease_id', lease_id, 'account', to_jsonb(a));
end $$;

notify pgrst,'reload schema';
