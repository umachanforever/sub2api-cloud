alter table public.s2a_groups
 add column subscription_type text not null default 'standard' check(subscription_type in ('standard','subscription')),
 add column daily_limit_usd numeric(20,8) check(daily_limit_usd>=0),
 add column weekly_limit_usd numeric(20,8) check(weekly_limit_usd>=0),
 add column monthly_limit_usd numeric(20,8) check(monthly_limit_usd>=0);
create table public.s2a_subscriptions (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null references auth.users(id) on delete cascade,
 group_id uuid not null references public.s2a_groups(id),
 status text not null default 'active' check(status in ('active','expired','revoked','suspended')),
 starts_at timestamptz not null default now(),
 expires_at timestamptz not null,
 validity_days integer not null check(validity_days between 1 and 36500),
 daily_usage_usd numeric(20,8) not null default 0 check(daily_usage_usd>=0),
 weekly_usage_usd numeric(20,8) not null default 0 check(weekly_usage_usd>=0),
 monthly_usage_usd numeric(20,8) not null default 0 check(monthly_usage_usd>=0),
 daily_window_start timestamptz not null default (date_trunc('day',now() at time zone 'Asia/Shanghai') at time zone 'Asia/Shanghai'),
 weekly_window_start timestamptz not null default now(),
 monthly_window_start timestamptz not null default now(),
 revoked_at timestamptz,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
create unique index s2a_subscriptions_current on public.s2a_subscriptions(user_id,group_id) where status<>'revoked';
create index s2a_subscriptions_user on public.s2a_subscriptions(user_id,created_at desc);
alter table public.s2a_subscriptions enable row level security;
revoke all on public.s2a_subscriptions from public,anon,authenticated;
grant select,insert,update,delete on public.s2a_subscriptions to service_role;
create trigger s2a_subscriptions_audit after insert or update or delete on public.s2a_subscriptions
 for each row execute function public.s2a_audit_mutation();
alter table public.s2a_usage add column subscription_id uuid references public.s2a_subscriptions(id) on delete set null;

create function public.s2a_subscription_refresh(p_id uuid) returns void
language plpgsql set search_path='' as $$
declare s public.s2a_subscriptions; today timestamptz; weekly timestamptz; monthly timestamptz;
begin
 select * into s from public.s2a_subscriptions where id=p_id for update;
 if not found then return; end if;
 today:=date_trunc('day',now() at time zone 'Asia/Shanghai') at time zone 'Asia/Shanghai';
 weekly:=s.weekly_window_start+floor(extract(epoch from(least(now(),s.expires_at-interval '1 microsecond')-s.weekly_window_start))/604800)*interval '7 days';
 monthly:=s.monthly_window_start+floor(extract(epoch from(least(now(),s.expires_at-interval '1 microsecond')-s.monthly_window_start))/2592000)*interval '30 days';
 update public.s2a_subscriptions set
  status=case when status='active' and expires_at<=now() then 'expired' else status end,
  daily_usage_usd=case when today>s.daily_window_start and today<s.expires_at then 0 else daily_usage_usd end,
  daily_window_start=case when today>s.daily_window_start and today<s.expires_at then today else daily_window_start end,
  weekly_usage_usd=case when weekly>s.weekly_window_start then 0 else weekly_usage_usd end,
  weekly_window_start=greatest(weekly,s.weekly_window_start),
  monthly_usage_usd=case when monthly>s.monthly_window_start then 0 else monthly_usage_usd end,
  monthly_window_start=greatest(monthly,s.monthly_window_start)
 where id=p_id;
end $$;

create function public.s2a_subscription_dto(p_id uuid,p_admin boolean default false)
returns jsonb language sql stable set search_path='' as $$
 select to_jsonb(s)||jsonb_build_object('status',case when s.status='active' and s.expires_at<=now() then 'expired' else s.status end,
  'group',to_jsonb(g)||jsonb_build_object('status',case when g.enabled then 'active' else 'inactive' end),
  'user',case when p_admin then jsonb_build_object('id',u.id,'email',u.email,'username',coalesce(u.raw_user_meta_data->>'username',split_part(u.email,'@',1))) else null end)
 from public.s2a_subscriptions s join public.s2a_groups g on g.id=s.group_id join auth.users u on u.id=s.user_id where s.id=p_id;
$$;
create function public.s2a_subscription_assign(p_user_id uuid,p_group_id uuid,p_days integer default 30,p_renew boolean default false)
returns jsonb language plpgsql set search_path='' as $$
declare s public.s2a_subscriptions; reused boolean:=false;
begin
 if p_days is null or p_days not between 1 and 36500 then return jsonb_build_object('error','invalid_validity_days','status',400); end if;
 if not exists(select 1 from auth.users where id=p_user_id) then return jsonb_build_object('error','user_not_found','status',404); end if;
 insert into public.s2a_user_limits(user_id) values(p_user_id) on conflict do nothing;
 perform 1 from public.s2a_user_limits where user_id=p_user_id for update;
 if not exists(select 1 from public.s2a_groups where id=p_group_id and enabled and subscription_type='subscription') then
  return jsonb_build_object('error','group_not_subscription_type','status',400);
 end if;
 select * into s from public.s2a_subscriptions where user_id=p_user_id and group_id=p_group_id and status<>'revoked' for update;
 if found then
  reused:=true;
  if s.status='suspended' then return jsonb_build_object('error','subscription_suspended','status',409); end if;
  if s.expires_at>now() and not p_renew then
   if s.validity_days<>p_days or s.expires_at<>least(s.starts_at+make_interval(days=>p_days),'2099-12-31 23:59:59+00'::timestamptz) then
    return jsonb_build_object('error','subscription_assign_conflict','status',409);
   end if;
  elsif s.expires_at>now() then
   update public.s2a_subscriptions set expires_at=least(expires_at+make_interval(days=>p_days),'2099-12-31 23:59:59+00'::timestamptz),updated_at=now() where id=s.id;
  else
   update public.s2a_subscriptions set starts_at=now(),expires_at=least(now()+make_interval(days=>p_days),'2099-12-31 23:59:59+00'::timestamptz),
    validity_days=p_days,status='active',daily_usage_usd=0,weekly_usage_usd=0,monthly_usage_usd=0,
    daily_window_start=date_trunc('day',now() at time zone 'Asia/Shanghai') at time zone 'Asia/Shanghai',
    weekly_window_start=now(),monthly_window_start=now(),updated_at=now() where id=s.id;
  end if;
 else
  insert into public.s2a_subscriptions(user_id,group_id,validity_days,expires_at)
   values(p_user_id,p_group_id,p_days,least(now()+make_interval(days=>p_days),'2099-12-31 23:59:59+00'::timestamptz)) returning * into s;
 end if;
 insert into public.s2a_memberships(user_id,group_id) values(p_user_id,p_group_id) on conflict do nothing;
 return public.s2a_subscription_dto(s.id,true)||jsonb_build_object('reused',reused);
end $$;
create function public.s2a_subscription_mutate(p_id uuid,p_action text,p_days integer default null,p_windows jsonb default '{}')
returns jsonb language plpgsql set search_path='' as $$
declare s public.s2a_subscriptions; target timestamptz;
begin
 select * into s from public.s2a_subscriptions where id=p_id;
 if not found then return jsonb_build_object('error','subscription_not_found','status',404); end if;
 perform 1 from public.s2a_user_limits where user_id=s.user_id for update;
 select * into s from public.s2a_subscriptions where id=p_id for update;
 if not found then return jsonb_build_object('error','subscription_not_found','status',404); end if;
 if p_action='revoke' then
  update public.s2a_subscriptions set status='revoked',revoked_at=coalesce(revoked_at,now()),updated_at=now() where id=p_id;
 elsif p_action='restore' then
  if s.status<>'revoked' then return jsonb_build_object('error','subscription_not_revoked','status',409); end if;
  if exists(select 1 from public.s2a_subscriptions where user_id=s.user_id and group_id=s.group_id and status<>'revoked') then
   return jsonb_build_object('error','subscription_restore_conflict','status',409);
  end if;
  update public.s2a_subscriptions set status=case when expires_at>now() then 'active' else 'expired' end,revoked_at=null,updated_at=now() where id=p_id;
 elsif p_action='extend' then
  if p_days is null or p_days=0 or abs(p_days)>36500 then return jsonb_build_object('error','invalid_validity_days','status',400); end if;
  if s.status in ('revoked','suspended') then return jsonb_build_object('error','subscription_inactive','status',409); end if;
  target:=least(greatest(s.expires_at,now())+make_interval(days=>p_days),'2099-12-31 23:59:59+00'::timestamptz);
  if target<=now() then return jsonb_build_object('error','adjust_would_expire','status',400); end if;
  if s.expires_at<=now() then
   update public.s2a_subscriptions set starts_at=now(),daily_usage_usd=0,weekly_usage_usd=0,monthly_usage_usd=0,
    daily_window_start=date_trunc('day',now() at time zone 'Asia/Shanghai') at time zone 'Asia/Shanghai',weekly_window_start=now(),monthly_window_start=now() where id=p_id;
  end if;
  update public.s2a_subscriptions set expires_at=target,status='active',updated_at=now() where id=p_id;
 elsif p_action='reset_quota' then
  if p_windows is null or jsonb_typeof(p_windows)<>'object' or exists(select 1 from jsonb_each(p_windows) e where e.key not in ('daily','weekly','monthly') or jsonb_typeof(e.value)<>'boolean')
   or not(coalesce((p_windows->>'daily')::boolean,false) or coalesce((p_windows->>'weekly')::boolean,false) or coalesce((p_windows->>'monthly')::boolean,false)) then
   return jsonb_build_object('error','invalid_quota_reset','status',400);
  end if;
  update public.s2a_subscriptions set daily_usage_usd=case when (p_windows->>'daily')::boolean then 0 else daily_usage_usd end,
   weekly_usage_usd=case when (p_windows->>'weekly')::boolean then 0 else weekly_usage_usd end,
   monthly_usage_usd=case when (p_windows->>'monthly')::boolean then 0 else monthly_usage_usd end,
   daily_window_start=case when (p_windows->>'daily')::boolean then now() else daily_window_start end,
   weekly_window_start=case when (p_windows->>'weekly')::boolean then now() else weekly_window_start end,
   monthly_window_start=case when (p_windows->>'monthly')::boolean then now() else monthly_window_start end,updated_at=now() where id=p_id;
 else return jsonb_build_object('error','invalid_subscription_action','status',400);
 end if;
 return public.s2a_subscription_dto(p_id,true);
end $$;

create function public.s2a_subscription_list(p_user_id uuid default null,p_group_id uuid default null,p_status text default '',
 p_page integer default 1,p_size integer default 20,p_sort text default 'created_at',p_order text default 'desc',p_platform text default '',p_admin boolean default false)
returns jsonb language plpgsql set search_path='' as $$
declare result jsonb; sid uuid;
begin
 if p_page is null or p_size is null or p_page<1 or p_size not between 1 and 100 or p_sort not in ('created_at','expires_at','starts_at','status','daily_usage_usd','weekly_usage_usd','monthly_usage_usd')
  or p_order not in ('asc','desc') or p_status not in ('','active','expired','revoked','suspended') or p_platform not in ('','openai','anthropic','gemini') then
  return jsonb_build_object('error','invalid_subscription_query','status',400);
 end if;
 for sid in select id from public.s2a_subscriptions where (p_user_id is null or user_id=p_user_id) and (p_group_id is null or group_id=p_group_id) order by user_id,id loop
  perform public.s2a_subscription_refresh(sid);
 end loop;
 execute format('with filtered as (select s.id from public.s2a_subscriptions s join public.s2a_groups g on g.id=s.group_id where ($1 is null or s.user_id=$1) and ($2 is null or s.group_id=$2) and ($3='''' or s.status=$3) and ($4='''' or g.platform=$4)),
 paged as (select s.id from public.s2a_subscriptions s join filtered f on f.id=s.id order by s.%I %s,s.id %s limit $5 offset $6)
 select jsonb_build_object(''items'',coalesce((select jsonb_agg(public.s2a_subscription_dto(id,$7)) from paged),''[]''::jsonb),''total'',(select count(*) from filtered),''page'',$8,''page_size'',$5,''pages'',ceil((select count(*) from filtered)::numeric/$5))',p_sort,p_order,p_order)
 into result using p_user_id,p_group_id,p_status,p_platform,p_size,(p_page-1)::bigint*p_size,p_admin,p_page;
 return result;
end $$;

do $$ declare fn regprocedure; begin
 for fn in select oid::regprocedure from pg_proc where pronamespace='public'::regnamespace and proname in
 ('s2a_subscription_refresh','s2a_subscription_dto','s2a_subscription_assign','s2a_subscription_mutate','s2a_subscription_list') loop
  execute format('revoke all on function %s from public,anon,authenticated',fn);
  execute format('grant execute on function %s to service_role',fn);
 end loop;
end $$;

create or replace function public.s2a_acquire(p_key_hash text,p_model text,p_request_id uuid,
 p_excluded uuid[],p_count_request boolean,p_client_ip text,p_billing_context jsonb)
returns jsonb language plpgsql set search_path='' as $$
declare k public.s2a_keys; g public.s2a_groups; w public.s2a_wallets; prices jsonb; result jsonb; subscription public.s2a_subscriptions;
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
 if not found or not exists(select 1 from public.s2a_memberships where user_id=k.user_id and group_id=k.group_id) then
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
  prices := public.s2a_price_lookup(g.platform,p_model);
  if prices is null then return jsonb_build_object('error','model_pricing_unavailable','status',422); end if;
  if k.monetary_quota is not null and k.monetary_used>=k.monetary_quota then
   return jsonb_build_object('error','monetary_quota_exceeded','status',429);
  end if;
  if g.subscription_type='standard' and g.rate_multiplier>0 and exists(select 1 from jsonb_each_text(prices) rate where rate.value::numeric>0) then
   insert into public.s2a_wallets(user_id) values(k.user_id) on conflict do nothing;
   select * into w from public.s2a_wallets where user_id=k.user_id for update;
   if w.balance<=w.frozen_balance then return jsonb_build_object('error','insufficient_balance','status',402); end if;
  end if;
 end if;
 result := public.s2a_acquire(p_key_hash,p_model,p_request_id,p_excluded,p_count_request,p_client_ip);
 if result ? 'lease_id' then
  update public.s2a_leases set billing=jsonb_build_object('rates',prices,'platform',g.platform,
   'subscription_id',subscription.id,'group_id',g.id,'rate_multiplier',g.rate_multiplier,'service_tier',p_billing_context->>'service_tier',
   'stream',coalesce((p_billing_context->>case when result->'account'->>'type'='apikey' then 'native_stream' else 'stream' end)::boolean,false)) where id=(result->>'lease_id')::uuid;
 end if;
 return result;
end $$;

create or replace function public.s2a_finish(
 p_lease_id uuid,p_status integer,p_outcome text,
 p_input_tokens bigint default null,p_output_tokens bigint default null,
 p_cache_creation_tokens bigint default null,p_cache_read_tokens bigint default null,
 p_cooldown_seconds integer default 0)
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
  total_cost,actual_cost,rate_multiplier,service_tier,stream,billing_status)
 values(l.id,l.request_id,l.account_id,l.key_id,k.user_id,l.model,p_status,p_outcome,p_input_tokens,p_output_tokens,
  p_cache_creation_tokens,p_cache_read_tokens,greatest(0,floor(extract(epoch from(clock_timestamp()-l.started_at))*1000)::integer),
  coalesce((l.billing->>'group_id')::uuid,k.group_id),input_price,output_price,creation_price,read_price,total,charged,
  multiplier,tier,(l.billing->>'stream')::boolean,state);
 update public.s2a_keys set quota_used=quota_used+coalesce(p_input_tokens,0)+coalesce(p_output_tokens,0),
  monetary_used=monetary_used+coalesce(charged,0) where id=k.id;
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
 if p_cooldown_seconds>0 then update public.s2a_accounts set cooldown_until=greatest(coalesce(cooldown_until,now()),now()+make_interval(secs=>least(p_cooldown_seconds,3600))) where id=l.account_id; end if;
 delete from public.s2a_leases where id=l.id;
end $$;

drop function public.s2a_group_create(text,uuid,text,numeric);
create function public.s2a_group_create(p_name text,p_user_id uuid,p_platform text default 'openai',p_rate_multiplier numeric default 1,p_options jsonb default '{}')
returns jsonb language plpgsql set search_path='' as $$
declare g public.s2a_groups;
begin
 if p_options is null or jsonb_typeof(p_options)<>'object' or exists(select 1 from jsonb_object_keys(p_options) k where k not in ('subscription_type','daily_limit_usd','weekly_limit_usd','monthly_limit_usd')) then
  return jsonb_build_object('error','invalid_group_options','status',400);
 end if;
 insert into public.s2a_groups(name,platform,rate_multiplier,subscription_type,daily_limit_usd,weekly_limit_usd,monthly_limit_usd)
 values(p_name,p_platform,p_rate_multiplier,coalesce(p_options->>'subscription_type','standard'),(p_options->>'daily_limit_usd')::numeric,(p_options->>'weekly_limit_usd')::numeric,(p_options->>'monthly_limit_usd')::numeric) returning * into g;
 insert into public.s2a_memberships(user_id,group_id) values(p_user_id,g.id);
 return to_jsonb(g);
end $$;
revoke all on function public.s2a_group_create(text,uuid,text,numeric,jsonb) from public,anon,authenticated;
grant execute on function public.s2a_group_create(text,uuid,text,numeric,jsonb) to service_role;
create function public.s2a_group_subscription_guard() returns trigger language plpgsql set search_path='' as $$
begin
 if old.subscription_type<>new.subscription_type and (exists(select 1 from public.s2a_subscriptions where group_id=old.id and status<>'revoked')
  or exists(select 1 from public.s2a_leases l join public.s2a_keys k on k.id=l.key_id where k.group_id=old.id and l.expires_at>now())) then
  raise exception using errcode='23505',message='group_billing_mode_in_use';
 end if;
 return new;
end $$;
revoke all on function public.s2a_group_subscription_guard() from public,anon,authenticated,service_role;
create trigger s2a_group_subscription_guard before update on public.s2a_groups for each row execute function public.s2a_group_subscription_guard();

create table public.s2a_subscription_operations (
 actor_id uuid not null references auth.users(id) on delete cascade,
 idempotency_key text not null check(length(idempotency_key) between 1 and 128),
 input jsonb not null,
 result jsonb,
 created_at timestamptz not null default now(),
 primary key(actor_id,idempotency_key)
);
alter table public.s2a_subscription_operations enable row level security;
revoke all on public.s2a_subscription_operations from public,anon,authenticated;
grant select,insert,update,delete on public.s2a_subscription_operations to service_role;
create function public.s2a_subscription_bulk(p_actor_id uuid,p_key text,p_ids uuid[],p_action text,p_days integer default null,p_windows jsonb default '{}')
returns jsonb language plpgsql set search_path='' as $$
declare operation public.s2a_subscription_operations; input jsonb; sid uuid; uid uuid; item jsonb;
 outcome jsonb:='[]'; successes integer:=0; failures integer:=0;
begin
 if p_key is null or length(p_key) not between 1 and 128 or p_ids is null or cardinality(p_ids) not between 1 and 500 or array_position(p_ids,null) is not null
  or p_action is null or p_action not in ('extend','reset_quota','revoke','restore') then return jsonb_build_object('error','invalid_bulk_action','status',400); end if;
 select array_agg(id order by id) into p_ids from (select distinct unnest(p_ids) id) d;
 input:=jsonb_build_object('ids',to_jsonb(p_ids),'action',p_action,'days',p_days,'windows',p_windows);
 insert into public.s2a_subscription_operations(actor_id,idempotency_key,input) values(p_actor_id,p_key,input) on conflict do nothing;
 select * into operation from public.s2a_subscription_operations where actor_id=p_actor_id and idempotency_key=p_key for update;
 if operation.input<>input then return jsonb_build_object('error','idempotency_conflict','status',409); end if;
 if operation.result is not null then return operation.result; end if;
 -- Every billing and management writer takes the same user lock before subscription locks.
 for uid in select distinct user_id from public.s2a_subscriptions where id=any(p_ids) order by user_id loop
  perform 1 from public.s2a_user_limits where user_id=uid for update;
 end loop;
 foreach sid in array p_ids loop
  item:=public.s2a_subscription_mutate(sid,p_action,p_days,p_windows);
  if item ? 'error' then failures:=failures+1; outcome:=outcome||jsonb_build_array(jsonb_build_object('subscription_id',sid,'success',false,'error',item->>'error'));
  else successes:=successes+1; outcome:=outcome||jsonb_build_array(jsonb_build_object('subscription_id',sid,'success',true)); end if;
 end loop;
 outcome:=jsonb_build_object('success_count',successes,'failed_count',failures,'results',outcome);
 update public.s2a_subscription_operations set result=outcome where actor_id=p_actor_id and idempotency_key=p_key;
 return outcome;
end $$;
revoke all on function public.s2a_subscription_bulk(uuid,text,uuid[],text,integer,jsonb) from public,anon,authenticated;
grant execute on function public.s2a_subscription_bulk(uuid,text,uuid[],text,integer,jsonb) to service_role;
