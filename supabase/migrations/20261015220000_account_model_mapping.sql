create function public.s2a_model_mapping_validate(p_value jsonb) returns jsonb language plpgsql immutable set search_path='' as $$
declare k text;v jsonb;
begin
 if jsonb_typeof(p_value) is distinct from 'object' then raise exception 'invalid_model_mapping';end if;
 if (select count(*) from jsonb_object_keys(p_value))>500 then raise exception 'invalid_model_mapping';end if;
 for k,v in select * from jsonb_each(p_value) loop
  if length(k) not between 1 and 200 or k<>btrim(k) or k ~ '[[:cntrl:]]' or strpos(regexp_replace(k,'\*$',''),'*')>0
   or jsonb_typeof(v)<>'string' or length(v#>>'{}') not between 1 and 200 or v#>>'{}'<>btrim(v#>>'{}') or v#>>'{}' ~ '[[:cntrl:]*]' then raise exception 'invalid_model_mapping';end if;
 end loop;return p_value;
end $$;
alter table public.s2a_accounts add column model_mapping jsonb not null default '{}' check(model_mapping=public.s2a_model_mapping_validate(model_mapping));
alter table public.s2a_usage add column billing_model text,add column upstream_model text,add column model_mapping_chain text;
create function public.s2a_account_mapped_model(p_mapping jsonb,p_model text,p_platform text) returns text language plpgsql immutable set search_path='' as $$
declare target text;normalized text:=btrim(p_model);
begin
 if p_mapping='{}' then return p_model;end if;
 select value into target from jsonb_each_text(p_mapping) where key=p_model or right(key,1)='*' and left(p_model,length(key)-1)=left(key,length(key)-1)
  order by (key=p_model) desc,octet_length(key) desc,key collate "C" limit 1;
 if found then return target;end if;
 if p_platform='gemini' and normalized='gemini-3.1-pro-preview-customtools' then normalized:='gemini-3.1-pro-preview';end if;
 if normalized<>p_model then
  select value into target from jsonb_each_text(p_mapping) where key=normalized or right(key,1)='*' and left(normalized,length(key)-1)=left(key,length(key)-1)
   order by (key=normalized) desc,octet_length(key) desc,key collate "C" limit 1;
 end if;
 return target;
end $$;
revoke all on function public.s2a_model_mapping_validate(jsonb),public.s2a_account_mapped_model(jsonb,text,text) from public,anon,authenticated;
grant execute on function public.s2a_model_mapping_validate(jsonb),public.s2a_account_mapped_model(jsonb,text,text) to service_role;

create or replace function public.s2a_apikey_account_update(p_account_id uuid,p_platform text,p_expected_version integer,
  p_fingerprint text,p_ciphertext text,p_iv text,p_patch jsonb default '{}')
returns jsonb language plpgsql set search_path='' as $$
declare a public.s2a_accounts; v public.s2a_accounts; changed boolean;
begin
  if jsonb_typeof(p_patch) is distinct from 'object' or exists(
    select 1 from jsonb_object_keys(p_patch) k where k not in
    ('name','notes','extra','model_mapping','status','priority','concurrency','rate_multiplier','load_factor','group_id','schedulable','expires_at','auto_pause_on_expired')
  ) then return jsonb_build_object('error','invalid_account_update','status',400); end if;
  if p_fingerprint is null or length(p_fingerprint) <> 64 or coalesce(p_ciphertext,'')='' or coalesce(p_iv,'')='' then
    return jsonb_build_object('error','invalid_credentials','status',400);
  end if;
  select * into a from public.s2a_accounts where id=p_account_id for update;
  if not found then return jsonb_build_object('error','account_not_found','status',404); end if;
  if a.type <> 'apikey' or a.platform is distinct from p_platform then
    return jsonb_build_object('error','account_provider_type_mismatch','status',400);
  end if;
  if a.credential_version is distinct from p_expected_version then
    return jsonb_build_object('error','credential_version_conflict','status',409);
  end if;
  if a.refresh_lock_until > now() or exists(select 1 from public.s2a_leases where account_id=a.id and expires_at>now()) then
    return jsonb_build_object('error','account_busy_retry_after_requests','status',409);
  end if;
  v:=jsonb_populate_record(a,p_patch);
  changed:=a.account_fingerprint <> p_fingerprint;
  update public.s2a_accounts set name=v.name,notes=v.notes,extra=v.extra,status=v.status,
    priority=v.priority,concurrency=v.concurrency,model_mapping=v.model_mapping,rate_multiplier=v.rate_multiplier,load_factor=v.load_factor,group_id=v.group_id,schedulable=v.schedulable,
    expires_at=v.expires_at,auto_pause_on_expired=v.auto_pause_on_expired,
    account_fingerprint=p_fingerprint,
    ciphertext=case when changed then p_ciphertext else a.ciphertext end,
    iv=case when changed then p_iv else a.iv end,
    credential_version=a.credential_version+case when changed then 1 else 0 end,
    cooldown_until=case when changed then null else a.cooldown_until end where id=a.id;
  return jsonb_build_object('ok',true);
exception when unique_violation then
  return jsonb_build_object('error','account_credentials_already_registered','status',409);
end $$;

create or replace function public.s2a_account_save(p_account_id uuid,p_patch jsonb,p_groups uuid[],
 p_oauth_ticket uuid default null,p_user_id uuid default null,p_rotation jsonb default null)
returns jsonb language plpgsql set search_path='' as $$
declare a public.s2a_accounts; v public.s2a_accounts; provider text; result jsonb; ticket public.s2a_oauth_tickets;
begin
 if p_groups is null or cardinality(p_groups) not between 1 and 100 or array_position(p_groups,null) is not null
  or cardinality(p_groups)<>(select count(distinct x) from unnest(p_groups) x)
  or p_patch is null or jsonb_typeof(p_patch)<>'object' then return jsonb_build_object('error','invalid_account_groups','status',400);end if;
 if p_account_id is null then
  if exists(select 1 from jsonb_object_keys(p_patch) k where k not in
   ('name','notes','extra','model_mapping','status','priority','concurrency','rate_multiplier','load_factor','group_id','schedulable','expires_at','auto_pause_on_expired','platform','type','account_fingerprint','ciphertext','iv')) then return jsonb_build_object('error','invalid_account_update','status',400);end if;
  provider:=p_patch->>'platform';
  if p_rotation is not null then return jsonb_build_object('error','invalid_account_update','status',400);end if;
  if p_oauth_ticket is not null then
   select * into ticket from public.s2a_oauth_tickets where id=p_oauth_ticket and user_id=p_user_id and expires_at>now() for update;
   if not found then return jsonb_build_object('error','oauth_ticket_invalid','status',400);end if;
   if ticket.used_account_id is not null then
    if ticket.used_for<>'create' then return jsonb_build_object('error','oauth_ticket_used','status',409);end if;
    return jsonb_build_object('id',ticket.used_account_id);
   end if;
   if provider<>'openai' or p_patch->>'type'<>'oauth' then return jsonb_build_object('error','oauth_ticket_provider_mismatch','status',400);end if;
  end if;
 else
  if p_oauth_ticket is not null or exists(select 1 from jsonb_object_keys(p_patch) k where k not in
   ('name','notes','extra','model_mapping','status','priority','concurrency','rate_multiplier','load_factor','group_id','schedulable','expires_at','auto_pause_on_expired')) then return jsonb_build_object('error','invalid_account_update','status',400);end if;
  select * into a from public.s2a_accounts where id=p_account_id for update;
  if not found then return jsonb_build_object('error','account_not_found','status',404);end if;
  provider:=a.platform;
 end if;
 -- Hold every routing group until metadata, credentials, and memberships commit together.
 perform id from public.s2a_groups where id=any(p_groups) and platform=provider order by id for share;
 if (select count(*) from public.s2a_groups where id=any(p_groups) and platform=provider)<>cardinality(p_groups) then return jsonb_build_object('error','account_group_platform_mismatch','status',400);end if;
 p_patch:=p_patch||jsonb_build_object('group_id',p_groups[1]);
 if p_account_id is null then
  if p_oauth_ticket is not null then
   result:=public.s2a_oauth_account_create(p_oauth_ticket,p_user_id,p_groups[1],p_patch->>'name',(p_patch->>'concurrency')::integer,(p_patch->>'priority')::integer,
    p_patch->>'notes',p_patch->'extra',(p_patch->>'schedulable')::boolean,(p_patch->>'expires_at')::timestamptz,(p_patch->>'auto_pause_on_expired')::boolean,p_patch->>'status');
   if result ? 'error' then return result;end if;
   p_account_id:=(result->>'id')::uuid;
   update public.s2a_accounts set model_mapping=coalesce(p_patch->'model_mapping','{}'),rate_multiplier=coalesce((p_patch->>'rate_multiplier')::numeric,1),load_factor=(p_patch->>'load_factor')::integer where id=p_account_id;
  else
   v:=jsonb_populate_record(null::public.s2a_accounts,p_patch);
   insert into public.s2a_accounts(name,notes,extra,status,priority,concurrency,group_id,schedulable,expires_at,auto_pause_on_expired,platform,type,account_fingerprint,ciphertext,iv,rate_multiplier,load_factor,model_mapping)
    values(v.name,v.notes,v.extra,v.status,v.priority,v.concurrency,v.group_id,v.schedulable,v.expires_at,v.auto_pause_on_expired,v.platform,v.type,v.account_fingerprint,v.ciphertext,v.iv,coalesce(v.rate_multiplier,1),v.load_factor,coalesce(v.model_mapping,'{}')) returning id into p_account_id;
  end if;
 elsif p_rotation is not null then
  result:=public.s2a_apikey_account_update(p_account_id,provider,(p_rotation->>'expected_version')::integer,p_rotation->>'fingerprint',p_rotation->>'ciphertext',p_rotation->>'iv',p_patch);
  if result ? 'error' then return result;end if;
 else
  v:=jsonb_populate_record(a,p_patch);
  update public.s2a_accounts set name=v.name,notes=v.notes,extra=v.extra,status=v.status,priority=v.priority,concurrency=v.concurrency,model_mapping=v.model_mapping,rate_multiplier=v.rate_multiplier,load_factor=v.load_factor,
   group_id=v.group_id,schedulable=v.schedulable,expires_at=v.expires_at,auto_pause_on_expired=v.auto_pause_on_expired where id=a.id;
 end if;
 result:=public.s2a_account_groups_replace(p_account_id,p_groups);
 if result ? 'error' then raise check_violation using message='account_groups_save_failed';end if;
 return jsonb_build_object('id',p_account_id);
exception when unique_violation then return jsonb_build_object('error','account_credentials_already_registered','status',409);
end $$;


drop function public.s2a_credentials_replace(uuid,text,text,text);
create function public.s2a_credentials_replace(p_account_id uuid, p_fingerprint text, p_ciphertext text, p_iv text,p_model_mapping jsonb default null)
returns jsonb language plpgsql set search_path = '' as $$
declare a public.s2a_accounts;
begin
  select * into a from public.s2a_accounts where id = p_account_id for update;
  if not found then return jsonb_build_object('error','account_not_found','status',404); end if;
  if a.account_fingerprint <> p_fingerprint then return jsonb_build_object('error','account_identity_mismatch','status',400); end if;
  if a.status <> 'disabled' or a.refresh_lock_until > now()
    or exists(select 1 from public.s2a_leases where account_id = a.id and expires_at > now()) then
    return jsonb_build_object('error','account_busy_disable_first','status',409);
  end if;
  update public.s2a_accounts set model_mapping=coalesce(p_model_mapping,a.model_mapping),ciphertext = p_ciphertext, iv = p_iv, credential_version = credential_version + 1,
    refresh_lock_id = null, refresh_lock_until = null, cooldown_until = null where id = a.id;
  return jsonb_build_object('ok',true);
end $$;
revoke all on function public.s2a_credentials_replace(uuid,text,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.s2a_credentials_replace(uuid,text,text,text,jsonb) to service_role;

drop function public.s2a_oauth_account_replace(uuid,uuid,uuid,jsonb);
create function public.s2a_oauth_account_replace(p_ticket_id uuid,p_user_id uuid,p_account_id uuid,p_extra jsonb default '{}',p_model_mapping jsonb default null)
returns jsonb language plpgsql set search_path='' as $$
declare t public.s2a_oauth_tickets; a public.s2a_accounts;
begin
  select * into t from public.s2a_oauth_tickets where id=p_ticket_id and user_id=p_user_id and expires_at > now() for update;
  if not found then return jsonb_build_object('error','oauth_ticket_invalid','status',400); end if;
  if t.used_account_id is not null then
    if t.used_for <> 'replace' or t.used_account_id <> p_account_id then return jsonb_build_object('error','oauth_ticket_used','status',409); end if;
    return jsonb_build_object('ok',true,'id',t.used_account_id);
  end if;
  select * into a from public.s2a_accounts where id=p_account_id for update;
  if not found then return jsonb_build_object('error','account_not_found','status',404); end if;
  if a.platform <> 'openai' or a.type <> 'oauth' or a.account_fingerprint <> t.account_fingerprint then
    return jsonb_build_object('error','account_identity_mismatch','status',400);
  end if;
  if a.status <> 'disabled' or a.refresh_lock_until > now()
    or exists(select 1 from public.s2a_leases where account_id=a.id and expires_at>now()) then
    return jsonb_build_object('error','account_busy_disable_first','status',409);
  end if;
  update public.s2a_accounts set model_mapping=coalesce(p_model_mapping,a.model_mapping),ciphertext=t.ciphertext,iv=t.iv,extra=extra || t.metadata || p_extra,
    credential_version=credential_version+1,refresh_lock_id=null,refresh_lock_until=null,cooldown_until=null where id=a.id;
  update public.s2a_oauth_tickets set used_account_id=a.id,used_for='replace',ciphertext=null,iv=null where id=t.id;
  return jsonb_build_object('ok',true,'id',a.id);
end $$;
revoke all on function public.s2a_oauth_account_replace(uuid,uuid,uuid,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.s2a_oauth_account_replace(uuid,uuid,uuid,jsonb,jsonb) to service_role;

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
      and (p_model='__models__' or public.s2a_account_mapped_model(candidate.model_mapping,p_model,candidate.platform) is not null) and candidate.status = 'active' and candidate.schedulable and (not candidate.auto_pause_on_expired or candidate.expires_at is null or candidate.expires_at > now())
      and (candidate.cooldown_until is null or candidate.cooldown_until <= now()) and not (candidate.id = any(p_excluded))
      and (select count(*) from public.s2a_leases l where l.account_id = candidate.id) < candidate.concurrency
    order by candidate.priority,
      (select count(*)::numeric from public.s2a_leases l where l.account_id=candidate.id)/coalesce(candidate.load_factor,candidate.concurrency), candidate.last_used_at nulls first, candidate.id limit 1 for update skip locked;
  if not found then return jsonb_build_object('error', 'no_available_account', 'status', 503); end if;
  if (select count(*) from public.s2a_leases l where l.account_id = a.id and l.expires_at > now()) >= a.concurrency then return jsonb_build_object('error', 'no_available_account', 'status', 503); end if;
  insert into public.s2a_leases(request_id, account_id, key_id, model) values (p_request_id, a.id, k.id, p_model) returning id into lease_id;
  update public.s2a_accounts set last_used_at = now() where id = a.id;
  if p_count_request then update public.s2a_keys set window_count = window_count + 1 where id = k.id; end if;
  return jsonb_build_object('lease_id', lease_id, 'account', to_jsonb(a),'upstream_model',case when p_model='__models__' then null else public.s2a_account_mapped_model(a.model_mapping,p_model,a.platform) end);
end $$;
create or replace function public.s2a_acquire(p_key_hash text,p_model text,p_request_id uuid,
 p_excluded uuid[],p_count_request boolean,p_client_ip text,p_billing_context jsonb)
returns jsonb language plpgsql set search_path='' as $$
declare k public.s2a_keys; g public.s2a_groups; w public.s2a_wallets; prices jsonb; result jsonb; subscription public.s2a_subscriptions; multiplier numeric;policy_model text;candidates text[];billing_model text;
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
  if k.monetary_quota is not null and k.monetary_used>=k.monetary_quota then
   return jsonb_build_object('error','monetary_quota_exceeded','status',429);
  end if;
 end if;
 begin
 result := public.s2a_acquire(p_key_hash,p_model,p_request_id,p_excluded,p_count_request,p_client_ip);
 if result ? 'lease_id' then
  billing_model:=coalesce(result->>'upstream_model',p_model);
  if p_model<>'__models__' then
   prices:=public.s2a_price_lookup(g.platform,billing_model);
   if prices is null then raise sqlstate 'S2P01';end if;
   if g.subscription_type='standard' and multiplier>0 and exists(select 1 from jsonb_each_text(prices) rate where rate.value::numeric>0) then
    insert into public.s2a_wallets(user_id) values(k.user_id) on conflict do nothing;
    select * into w from public.s2a_wallets where user_id=k.user_id for update;
    if w.balance<=w.frozen_balance then raise sqlstate 'S2B01';end if;
   end if;
  end if;
  result:=result||jsonb_build_object('model_allowlist',g.model_allowlist);
  if p_model='__models__' then
   result:=result||jsonb_build_object('model_sources',jsonb_build_object(
    'mapping',coalesce((select jsonb_object_agg(key,value) from (select distinct on(e.key) e.key,e.value from public.s2a_accounts a join public.s2a_account_groups ag on ag.account_id=a.id cross join lateral jsonb_each_text(a.model_mapping) e where ag.group_id=g.id and (not g.require_privacy_set or case a.platform when 'openai' then a.extra->>'privacy_mode'='training_off' when 'antigravity' then a.extra->>'privacy_mode'='privacy_set' else true end) and a.status='active' and a.schedulable and (not a.auto_pause_on_expired or a.expires_at is null or a.expires_at>now()) order by e.key,a.priority,a.id) mapped),'{}'),
    'include_upstream',exists(select 1 from public.s2a_accounts a join public.s2a_account_groups ag on ag.account_id=a.id where ag.group_id=g.id and (not g.require_privacy_set or case a.platform when 'openai' then a.extra->>'privacy_mode'='training_off' when 'antigravity' then a.extra->>'privacy_mode'='privacy_set' else true end) and a.status='active' and a.schedulable and a.model_mapping='{}' and (not a.auto_pause_on_expired or a.expires_at is null or a.expires_at>now()))));
  end if;
  update public.s2a_leases set billing=jsonb_build_object('rates',prices,'platform',g.platform,'billing_model',billing_model,'upstream_model',billing_model,'model_mapping_chain',case when billing_model<>p_model then p_model||' → '||billing_model else null end,
   'subscription_id',subscription.id,'group_id',g.id,'rate_multiplier',multiplier,
   'account_rate_multiplier',coalesce((result->'account'->>'rate_multiplier')::numeric,1),'service_tier',p_billing_context->>'service_tier',
   'stream',coalesce((p_billing_context->>case when result->'account'->>'type'='apikey' then 'native_stream' else 'stream' end)::boolean,false)) where id=(result->>'lease_id')::uuid;
 end if;
 return result;
 exception when sqlstate 'S2P01' then return jsonb_build_object('error','model_pricing_unavailable','status',422);
 when sqlstate 'S2B01' then return jsonb_build_object('error','insufficient_balance','status',402);
 end;
end $$;
create or replace function public.s2a_finish(
 p_lease_id uuid,p_status integer,p_outcome text,
 p_input_tokens bigint default null,p_output_tokens bigint default null,
 p_cache_creation_tokens bigint default null,p_cache_read_tokens bigint default null,
 p_cooldown_seconds integer default 0,p_credential_version bigint default null)
returns void language plpgsql set search_path='' as $$
declare l public.s2a_leases; k public.s2a_keys; prices jsonb; tier text; context bigint; billable_input bigint;
 input_price numeric; output_price numeric; creation_price numeric; read_price numeric;
 total numeric; charged numeric(20,8); multiplier numeric; next_balance numeric; sub_id uuid; state text:='unknown';
begin
 select * into l from public.s2a_leases where id=p_lease_id;
 if not found then return; end if;
 select * into k from public.s2a_keys where id=l.key_id;
 perform 1 from public.s2a_user_limits where user_id=k.user_id for update;
 select * into k from public.s2a_keys where id=l.key_id for update;
 select * into l from public.s2a_leases where id=p_lease_id for update;
 if not found then return; end if;
 sub_id := (l.billing->>'subscription_id')::uuid;
 if sub_id is not null then perform public.s2a_subscription_refresh(sub_id); end if;
 prices := l.billing->'rates';
 tier := l.billing->>'service_tier';
 multiplier := coalesce((l.billing->>'rate_multiplier')::numeric,1);
 if p_input_tokens is not null and p_output_tokens is not null and jsonb_typeof(prices)='object' then
  billable_input := greatest(0,p_input_tokens-case when l.billing->>'platform'='anthropic' then 0 else coalesce(p_cache_creation_tokens,0)+coalesce(p_cache_read_tokens,0) end);
  context := billable_input+coalesce(p_cache_creation_tokens,0)+coalesce(p_cache_read_tokens,0);
  input_price := billable_input*public.s2a_price_rate(prices,'input_cost_per_token',context,tier);
  output_price := p_output_tokens*public.s2a_price_rate(prices,'output_cost_per_token',context,tier);
  creation_price := coalesce(p_cache_creation_tokens,0)*public.s2a_price_rate(prices,'cache_creation_input_token_cost',context,tier);
  read_price := coalesce(p_cache_read_tokens,0)*public.s2a_price_rate(prices,'cache_read_input_token_cost',context,tier);
  total := input_price+output_price+creation_price+read_price;
  charged := round(total*multiplier,8);
  state := case when charged>0 then 'settled' else 'free' end;
 end if;
 insert into public.s2a_usage(id,request_id,account_id,key_id,user_id,model,status,outcome,input_tokens,output_tokens,
  cache_creation_tokens,cache_read_tokens,duration_ms,group_id,input_cost,output_cost,cache_creation_cost,cache_read_cost,
  total_cost,actual_cost,rate_multiplier,service_tier,stream,billing_status,account_rate_multiplier,account_stats_cost,billing_model,upstream_model,model_mapping_chain)
 values(l.id,l.request_id,l.account_id,l.key_id,k.user_id,l.model,p_status,p_outcome,p_input_tokens,p_output_tokens,
  p_cache_creation_tokens,p_cache_read_tokens,greatest(0,floor(extract(epoch from(clock_timestamp()-l.started_at))*1000)::integer),
  coalesce((l.billing->>'group_id')::uuid,k.group_id),input_price,output_price,creation_price,read_price,total,charged,
  multiplier,tier,(l.billing->>'stream')::boolean,state,coalesce((l.billing->>'account_rate_multiplier')::numeric,1),
  total,l.billing->>'billing_model',l.billing->>'upstream_model',l.billing->>'model_mapping_chain');
 update public.s2a_keys set quota_used=quota_used+coalesce(p_input_tokens,0)+coalesce(p_output_tokens,0),
  monetary_used=monetary_used+coalesce(charged,0) where id=k.id;
 if sub_id is null and charged>0 then perform public.s2a_platform_quota_charge(k.user_id,l.billing->>'platform',charged);end if;
 update public.s2a_usage set subscription_id=sub_id,
  billing_mode=case when sub_id is null then 'token' else 'subscription' end where id=l.id;
 if sub_id is not null and charged>0 then
  update public.s2a_subscriptions set daily_usage_usd=daily_usage_usd+charged,weekly_usage_usd=weekly_usage_usd+charged,
   monthly_usage_usd=monthly_usage_usd+charged,updated_at=now() where id=sub_id;
 elsif charged>0 then
  insert into public.s2a_wallets(user_id) values(k.user_id) on conflict do nothing;
  update public.s2a_wallets set balance=balance-charged,updated_at=now() where user_id=k.user_id returning balance into next_balance;
  insert into public.s2a_wallet_ledger(user_id,delta,balance_after,reason,notes)
   values(k.user_id,-charged,next_balance,'usage',l.id::text);
 end if;
 if p_status=401 then
  update public.s2a_accounts set status='error',error_message='Upstream authentication rejected (401)'
   where id=l.account_id and status='active' and credential_version=coalesce(p_credential_version,l.credential_version);
 end if;
 if p_cooldown_seconds>0 then
  update public.s2a_accounts set cooldown_until=greatest(coalesce(cooldown_until,now()),now()+make_interval(secs=>least(p_cooldown_seconds,3600))),
   cooldown_status=case when cooldown_until>now()+make_interval(secs=>least(p_cooldown_seconds,3600)) then cooldown_status else p_status end,
   cooldown_started_at=case when cooldown_until>now()+make_interval(secs=>least(p_cooldown_seconds,3600)) then cooldown_started_at else now() end
   where id=l.account_id and credential_version=coalesce(p_credential_version,l.credential_version);
 end if;
 delete from public.s2a_leases where id=l.id;
end $$;
notify pgrst,'reload schema';
