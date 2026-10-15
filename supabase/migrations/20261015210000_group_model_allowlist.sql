create function public.s2a_model_allowlist_normalize(p_value jsonb)
returns jsonb language plpgsql immutable set search_path='' as $$
declare enabled boolean; models jsonb:='[]';seen text[]:='{}';item jsonb;model text;
begin
 if jsonb_typeof(p_value) is distinct from 'object' or exists(select 1 from jsonb_object_keys(p_value) k where k not in ('enabled','models'))
  or p_value ? 'enabled' and jsonb_typeof(p_value->'enabled') is distinct from 'boolean'
  or p_value ? 'models' and jsonb_typeof(p_value->'models') is distinct from 'array' then raise exception 'invalid_model_allowlist';end if;
 enabled:=coalesce((p_value->>'enabled')::boolean,false);
 if jsonb_array_length(coalesce(p_value->'models','[]'))>500 then raise exception 'invalid_model_allowlist';end if;
 for item in select value from jsonb_array_elements(coalesce(p_value->'models','[]')) loop
  if jsonb_typeof(item)<>'string' or length(item#>>'{}')>200 or (item#>>'{}') ~ '[[:cntrl:]]' then raise exception 'invalid_model_allowlist';end if;
  model:=btrim(item#>>'{}');if model='' then continue;end if;
  if strpos(regexp_replace(model,'\*$',''),'*')>0 then raise exception 'invalid_model_allowlist';end if;
  if not lower(model)=any(seen) then seen:=array_append(seen,lower(model));models:=models||jsonb_build_array(model);end if;
 end loop;
 if enabled and jsonb_array_length(models)=0 then raise exception 'invalid_model_allowlist';end if;
 return jsonb_build_object('enabled',enabled,'models',models);
end $$;
create function public.s2a_model_allowlist_guard() returns trigger language plpgsql set search_path='' as $$
begin new.model_allowlist:=public.s2a_model_allowlist_normalize(new.model_allowlist);return new;end $$;
alter table public.s2a_groups add column model_allowlist jsonb not null default '{"enabled":false,"models":[]}';
create trigger s2a_model_allowlist_guard before insert or update of model_allowlist on public.s2a_groups for each row execute function public.s2a_model_allowlist_guard();
create function public.s2a_model_allowlist_allows(p_config jsonb,p_candidates text[]) returns boolean
language sql immutable set search_path='' as $$
 select not coalesce((p_config->>'enabled')::boolean,false) or exists(
  select 1 from jsonb_array_elements_text(p_config->'models') entry cross join unnest(p_candidates) candidate
  where entry<>'' and (lower(candidate)=lower(entry) or right(entry,1)='*' and left(lower(candidate),length(entry)-1)=left(lower(entry),length(entry)-1))
 );
$$;
revoke all on function public.s2a_model_allowlist_normalize(jsonb),public.s2a_model_allowlist_guard(),public.s2a_model_allowlist_allows(jsonb,text[]) from public,anon,authenticated;
grant execute on function public.s2a_model_allowlist_normalize(jsonb),public.s2a_model_allowlist_allows(jsonb,text[]) to service_role;

create or replace function public.s2a_group_create(p_name text,p_user_id uuid,p_platform text default 'openai',p_rate_multiplier numeric default 1,p_options jsonb default '{}')
returns jsonb language plpgsql set search_path='' as $$
declare g public.s2a_groups;
begin
 if p_options is null or jsonb_typeof(p_options)<>'object' or exists(select 1 from jsonb_object_keys(p_options) k where k not in ('is_exclusive','require_privacy_set','model_allowlist','rpm_limit','description','sort_order','subscription_type','daily_limit_usd','weekly_limit_usd','monthly_limit_usd')) then
  return jsonb_build_object('error','invalid_group_options','status',400);
 end if;
 if p_options ? 'require_privacy_set' and jsonb_typeof(p_options->'require_privacy_set') is distinct from 'boolean' then return jsonb_build_object('error','invalid_group_options','status',400);end if;
 insert into public.s2a_groups(name,platform,rate_multiplier,is_exclusive,require_privacy_set,model_allowlist,rpm_limit,description,sort_order,subscription_type,daily_limit_usd,weekly_limit_usd,monthly_limit_usd)
 values(p_name,p_platform,p_rate_multiplier,coalesce((p_options->>'is_exclusive')::boolean,false),coalesce((p_options->>'require_privacy_set')::boolean,false),public.s2a_model_allowlist_normalize(coalesce(p_options->'model_allowlist','{}')),coalesce((p_options->>'rpm_limit')::integer,0),p_options->>'description',coalesce((p_options->>'sort_order')::integer,0),coalesce(p_options->>'subscription_type','standard'),(p_options->>'daily_limit_usd')::numeric,(p_options->>'weekly_limit_usd')::numeric,(p_options->>'monthly_limit_usd')::numeric) returning * into g;
 insert into public.s2a_memberships(user_id,group_id) values(p_user_id,g.id);
 return to_jsonb(g);
end $$;

create or replace function public.s2a_groups_available(p_user_id uuid) returns jsonb
language sql stable set search_path='' as $$
 select coalesce(jsonb_agg(jsonb_build_object('id',id,'name',name,'platform',platform,'enabled',enabled,
  'created_at',created_at,'description',description,'sort_order',sort_order,'rate_multiplier',rate_multiplier,
  'is_exclusive',is_exclusive,'require_privacy_set',require_privacy_set,'model_allowlist',model_allowlist,'rpm_limit',rpm_limit,'subscription_type',subscription_type,
  'daily_limit_usd',daily_limit_usd,'weekly_limit_usd',weekly_limit_usd,'monthly_limit_usd',monthly_limit_usd) order by sort_order,id),'[]'::jsonb)
 from public.s2a_groups where public.s2a_group_can_bind(p_user_id,id);
$$;

create or replace function public.s2a_acquire(p_key_hash text,p_model text,p_request_id uuid,
 p_excluded uuid[],p_count_request boolean,p_client_ip text,p_billing_context jsonb)
returns jsonb language plpgsql set search_path='' as $$
declare k public.s2a_keys; g public.s2a_groups; w public.s2a_wallets; prices jsonb; result jsonb; subscription public.s2a_subscriptions; multiplier numeric;policy_model text;candidates text[];
begin
 if p_billing_context is null or jsonb_typeof(p_billing_context)<>'object' then return jsonb_build_object('error','invalid_billing_context','status',400); end if;
 select * into k from public.s2a_keys where key_hash=p_key_hash;
 if not found or k.revoked or k.expires_at<=now() or not exists(select 1 from auth.users where id=k.user_id and (banned_until is null or banned_until<=now())) then
  return jsonb_build_object('error','invalid_api_key','status',401);
 end if;
 insert into public.s2a_user_limits(user_id) values(k.user_id) on conflict do nothing;
 perform 1 from public.s2a_user_limits where user_id=k.user_id for update;
 select * into k from public.s2a_keys where key_hash=p_key_hash for update;
 if not found or k.revoked or k.expires_at<=now() then return jsonb_build_object('error','invalid_api_key','status',401); end if;
 select * into g from public.s2a_groups where id=k.group_id and enabled;
 if not found or (g.subscription_type='standard' and not public.s2a_group_can_bind(k.user_id,k.group_id)) then
  return jsonb_build_object('error','group_access_denied','status',403);
 end if;
 begin
 if cardinality(k.ip_blacklist)>0 and p_client_ip is not null and exists(select 1 from unnest(k.ip_blacklist) rule where p_client_ip::inet <<= rule::cidr) then
  return jsonb_build_object('error','ip_restricted','status',403);
 end if;
 if cardinality(k.ip_whitelist)>0 and (p_client_ip is null or not exists(select 1 from unnest(k.ip_whitelist) rule where p_client_ip::inet <<= rule::cidr)) then
  return jsonb_build_object('error','ip_restricted','status',403);
 end if;
 exception when invalid_text_representation then return jsonb_build_object('error','ip_restricted','status',403);
 end;
 -- Candidate aliases come from the trusted Edge Function, never a client payload.
 policy_model:=coalesce(nullif(p_billing_context->>'policy_model',''),nullif(p_model,'__models__'));
 if p_billing_context ? 'model_candidates' then
  if jsonb_typeof(p_billing_context->'model_candidates')<>'array' then return jsonb_build_object('error','invalid_billing_context','status',400);end if;
  if jsonb_array_length(p_billing_context->'model_candidates')>4 or exists(select 1 from jsonb_array_elements(p_billing_context->'model_candidates') x where jsonb_typeof(x)<>'string' or length(x#>>'{}')>200) then return jsonb_build_object('error','invalid_billing_context','status',400);end if;
  select array_agg(value) into candidates from jsonb_array_elements_text(p_billing_context->'model_candidates');
 end if;
 if p_model<>'__models__' and p_billing_context ? 'policy_model' and p_billing_context->>'policy_model' is distinct from p_model then return jsonb_build_object('error','invalid_billing_context','status',400);end if;
 if policy_model is not null and not public.s2a_model_allowlist_allows(g.model_allowlist,array_prepend(lower(btrim(policy_model)),coalesce(candidates,'{}'))) then
  return jsonb_build_object('error',case when p_model='__models__' then 'model_not_found' else 'model_not_allowed' end,'status',case when p_model='__models__' then 404 else 403 end);
 end if;
 multiplier:=coalesce((select rate_multiplier from public.s2a_user_group_rates where user_id=k.user_id and group_id=g.id),g.rate_multiplier);
 if g.subscription_type='subscription' then
  select * into subscription from public.s2a_subscriptions where user_id=k.user_id and group_id=g.id and status<>'revoked' for update;
  if not found then return jsonb_build_object('error','subscription_required','status',403); end if;
  perform public.s2a_subscription_refresh(subscription.id);
  select * into subscription from public.s2a_subscriptions where id=subscription.id;
  if subscription.status<>'active' or subscription.expires_at<=now() then return jsonb_build_object('error','subscription_inactive','status',403); end if;
  if subscription.starts_at>now() then return jsonb_build_object('error','subscription_not_started','status',403); end if;
  if p_model<>'__models__' then
   if g.daily_limit_usd is not null and subscription.daily_usage_usd>=g.daily_limit_usd then return jsonb_build_object('error','daily_limit_exceeded','status',429); end if;
   if g.weekly_limit_usd is not null and subscription.weekly_usage_usd>=g.weekly_limit_usd then return jsonb_build_object('error','weekly_limit_exceeded','status',429); end if;
   if g.monthly_limit_usd is not null and subscription.monthly_usage_usd>=g.monthly_limit_usd then return jsonb_build_object('error','monthly_limit_exceeded','status',429); end if;
  end if;
 end if;
 if p_model<>'__models__' then
  if g.subscription_type='standard' then
   result:=public.s2a_platform_quota_check(k.user_id,g.platform);if result ? 'error' then return result;end if;
  end if;
  if k.rate_limit_5h>0 and k.window_5h_start+interval '5 hours'>now() and k.usage_5h>=k.rate_limit_5h then return jsonb_build_object('error','api_key_rate_5h_exceeded','status',429);end if;
  if k.rate_limit_1d>0 and k.window_1d_start+interval '24 hours'>now() and k.usage_1d>=k.rate_limit_1d then return jsonb_build_object('error','api_key_rate_1d_exceeded','status',429);end if;
  if k.rate_limit_7d>0 and k.window_7d_start+interval '7 days'>now() and k.usage_7d>=k.rate_limit_7d then return jsonb_build_object('error','api_key_rate_7d_exceeded','status',429);end if;
  prices := public.s2a_price_lookup(g.platform,p_model);
  if prices is null then return jsonb_build_object('error','model_pricing_unavailable','status',422); end if;
  if k.monetary_quota is not null and k.monetary_used>=k.monetary_quota then
   return jsonb_build_object('error','monetary_quota_exceeded','status',429);
  end if;
  if g.subscription_type='standard' and multiplier>0 and exists(select 1 from jsonb_each_text(prices) rate where rate.value::numeric>0) then
   insert into public.s2a_wallets(user_id) values(k.user_id) on conflict do nothing;
   select * into w from public.s2a_wallets where user_id=k.user_id for update;
   if w.balance<=w.frozen_balance then return jsonb_build_object('error','insufficient_balance','status',402); end if;
  end if;
 end if;
 result := public.s2a_acquire(p_key_hash,p_model,p_request_id,p_excluded,p_count_request,p_client_ip);
 if result ? 'lease_id' then
  result:=result||jsonb_build_object('model_allowlist',g.model_allowlist);
  update public.s2a_leases set billing=jsonb_build_object('rates',prices,'platform',g.platform,
   'subscription_id',subscription.id,'group_id',g.id,'rate_multiplier',multiplier,
   'account_rate_multiplier',coalesce((result->'account'->>'rate_multiplier')::numeric,1),'service_tier',p_billing_context->>'service_tier',
   'stream',coalesce((p_billing_context->>case when result->'account'->>'type'='apikey' then 'native_stream' else 'stream' end)::boolean,false)) where id=(result->>'lease_id')::uuid;
 end if;
 return result;
end $$;


notify pgrst,'reload schema';
