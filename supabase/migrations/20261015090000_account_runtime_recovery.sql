alter table public.s2a_accounts drop constraint s2a_accounts_status_check;
alter table public.s2a_accounts add constraint s2a_accounts_status_check check(status in ('active','disabled','error'));
alter table public.s2a_accounts
 add column error_message text,
 add column cooldown_status integer check(cooldown_status between 100 and 599),
 add column cooldown_started_at timestamptz;
alter table public.s2a_leases add column credential_version bigint;
create function public.s2a_lease_credential_version() returns trigger
language plpgsql set search_path='' as $$
begin
 select credential_version into new.credential_version from public.s2a_accounts where id=new.account_id;
 return new;
end $$;
revoke all on function public.s2a_lease_credential_version() from public,anon,authenticated,service_role;
create trigger s2a_lease_credential_version before insert on public.s2a_leases
 for each row execute function public.s2a_lease_credential_version();

drop function public.s2a_finish(uuid,integer,text,bigint,bigint,bigint,bigint,integer);
create function public.s2a_finish(
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
revoke all on function public.s2a_finish(uuid,integer,text,bigint,bigint,bigint,bigint,integer,bigint) from public,anon,authenticated;
grant execute on function public.s2a_finish(uuid,integer,text,bigint,bigint,bigint,bigint,integer,bigint) to service_role;

create function public.s2a_account_recover(p_account_id uuid,p_action text)
returns jsonb language plpgsql set search_path='' as $$
declare a public.s2a_accounts; clear_cooldown boolean;
begin
 if p_action is null or p_action not in ('clear-error','clear-rate-limit','recover-state','clear-temp') then return jsonb_build_object('error','invalid_account_recovery','status',400);end if;
 select * into a from public.s2a_accounts where id=p_account_id for update;
 if not found then return jsonb_build_object('error','account_not_found','status',404);end if;
 clear_cooldown:=p_action<>'clear-temp' or coalesce(a.cooldown_status,0)<>429 and coalesce(a.cooldown_status,0)<500;
 update public.s2a_accounts set
  status=case when p_action='clear-error' or p_action='recover-state' and status='error' then 'active' else status end,
  error_message=case when p_action='clear-error' or p_action='recover-state' and status='error' then null else error_message end,
  cooldown_until=case when clear_cooldown then null else cooldown_until end,
  cooldown_status=case when clear_cooldown then null else cooldown_status end,
  cooldown_started_at=case when clear_cooldown then null else cooldown_started_at end where id=a.id;
 return jsonb_build_object('id',a.id);
end $$;
revoke all on function public.s2a_account_recover(uuid,text) from public,anon,authenticated;
grant execute on function public.s2a_account_recover(uuid,text) to service_role;
notify pgrst,'reload schema';
