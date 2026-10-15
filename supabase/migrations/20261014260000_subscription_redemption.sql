drop function public.s2a_redeem_generate(integer,text,numeric,timestamptz,text);
create function public.s2a_redeem_generate(p_count integer,p_type text,p_value numeric,
 p_expires_at timestamptz default null,p_notes text default '',p_group_id uuid default null,p_validity_days integer default 0)
returns jsonb language plpgsql set search_path='' as $$
declare c public.s2a_redeem_codes; result jsonb:='[]'; token text; n integer;
begin
 if p_count is null or p_count not between 1 and 100 or p_type is null or p_type not in ('balance','concurrency','invitation','subscription')
  or p_notes is null or length(p_notes)>10000 or p_expires_at<=now() then
  return jsonb_build_object('error','invalid_redeem_code','status',400);
 end if;
 if p_type='subscription' then
  if p_group_id is null or p_validity_days is null or abs(p_validity_days)>36500 or not exists(select 1 from public.s2a_groups where id=p_group_id and enabled and subscription_type='subscription') then
   return jsonb_build_object('error','invalid_subscription_group','status',400);
  end if;
 elsif p_group_id is not null or p_validity_days<>0 then return jsonb_build_object('error','invalid_redeem_group','status',400);
 end if;
 if p_type='invitation' then p_value:=0; end if;
 if p_value is null or p_value::text in ('NaN','Infinity','-Infinity') or abs(p_value)>1000000000 or p_value<>round(p_value,8)
  or p_type<>'invitation' and p_value=0 or p_type='concurrency' and (p_value<>trunc(p_value) or abs(p_value)>1000000) then
  return jsonb_build_object('error','invalid_redeem_value','status',400);
 end if;
 for n in 1..p_count loop
  token:=upper(replace(gen_random_uuid()::text,'-',''));
  token:=substring(token,1,8)||'-'||substring(token,9,8)||'-'||substring(token,17,8)||'-'||substring(token,25,8);
  insert into public.s2a_redeem_codes(code,type,value,expires_at,notes,group_id,validity_days) values(token,p_type,p_value,p_expires_at,p_notes,p_group_id,p_validity_days) returning * into c;
  result:=result||jsonb_build_array(to_jsonb(c));
 end loop;
 return result;
end $$;


create or replace function public.s2a_redeem_use(p_user_id uuid,p_code text,p_admin boolean default false)
returns jsonb language plpgsql set search_path='' as $$
declare c public.s2a_redeem_codes; attempts public.s2a_redeem_attempts; result jsonb; failure text; status_code integer; next_limit integer; subscription public.s2a_subscriptions;
begin
 p_admin:=coalesce(p_admin,false);
 if not exists(select 1 from auth.users where id=p_user_id and (banned_until is null or banned_until<=now())) then
  return jsonb_build_object('error','user_not_found','status',404);
 end if;
 if p_code is null or length(trim(p_code)) not between 3 and 128 then return jsonb_build_object('error','invalid_redeem_code','status',400); end if;
 insert into public.s2a_user_limits(user_id) values(p_user_id) on conflict do nothing;
 perform 1 from public.s2a_user_limits where user_id=p_user_id for update;
 insert into public.s2a_redeem_attempts(user_id) values(p_user_id) on conflict do nothing;
 select * into attempts from public.s2a_redeem_attempts where user_id=p_user_id for update;
 if attempts.window_start<=now()-interval '10 minutes' then
  update public.s2a_redeem_attempts set window_start=now(),failures=0 where user_id=p_user_id;
  attempts.failures:=0;
 end if;
 if not p_admin and attempts.failures>=30 then return jsonb_build_object('error','redeem_rate_limited','status',429); end if;
 select * into c from public.s2a_redeem_codes where code=trim(p_code) for update;
 if not found then failure:='redeem_code_not_found'; status_code:=404;
 elsif c.status='used' then
  if p_admin and c.used_by=p_user_id then return public.s2a_redeem_dto(c.id,true); end if;
  failure:='redeem_code_used'; status_code:=409;
 elsif c.status='expired' or c.expires_at<=now() then failure:='redeem_code_expired'; status_code:=409;
 elsif c.status='disabled' then failure:='redeem_code_disabled'; status_code:=409;
 end if;
 if failure is not null then
  if not p_admin then update public.s2a_redeem_attempts set failures=failures+1 where user_id=p_user_id; end if;
  return jsonb_build_object('error',failure,'status',status_code);
 end if;
 if c.type='invitation' then return jsonb_build_object('error','invitation_requires_registration','status',400); end if;

 if c.type='balance' then
  result:=public.s2a_wallet_adjust(p_user_id,c.value,'redeem',c.id::text);
  if result ? 'error' then return result; end if;
 elsif c.type='subscription' then
  if c.validity_days>=0 then
   result:=public.s2a_subscription_assign(p_user_id,c.group_id,case when c.validity_days=0 then 30 else c.validity_days end,true);
   if result ? 'error' then return result; end if;
  else
   select * into subscription from public.s2a_subscriptions where user_id=p_user_id and group_id=c.group_id and status='active' and expires_at>now() for update;
   if not found then return jsonb_build_object('error','subscription_not_found','status',404); end if;
   if subscription.expires_at+make_interval(days=>c.validity_days)<=now() then
    result:=public.s2a_subscription_mutate(subscription.id,'revoke');
   else result:=public.s2a_subscription_mutate(subscription.id,'extend',c.validity_days);
   end if;
   if result ? 'error' then return result; end if;
  end if;
  result:=jsonb_build_object('subscription',result);
 elsif c.type='concurrency' then
  select concurrency+c.value::integer into next_limit from public.s2a_user_limits where user_id=p_user_id;
  if next_limit not between 0 and 1000000 then return jsonb_build_object('error','invalid_resulting_concurrency','status',400); end if;
  update public.s2a_user_limits set concurrency=next_limit where user_id=p_user_id;
  result:=jsonb_build_object('new_concurrency',next_limit);
 end if;
 update public.s2a_redeem_codes set status='used',used_by=p_user_id,used_at=now() where id=c.id;
 return public.s2a_redeem_dto(c.id,p_admin)||jsonb_build_object('message','Code redeemed successfully')||
  case when c.type='balance' then jsonb_build_object('new_balance',result->'balance') else result end;
end $$;


drop function public.s2a_redeem_create_and_use(uuid,text,text,numeric,timestamptz,text);
create function public.s2a_redeem_create_and_use(p_user_id uuid,p_code text,p_type text,p_value numeric,
 p_expires_at timestamptz default null,p_notes text default '',p_group_id uuid default null,p_validity_days integer default 0)
returns jsonb language plpgsql set search_path='' as $$
declare c public.s2a_redeem_codes; result jsonb;
begin
 if p_code is null or length(trim(p_code)) not between 3 and 128 or p_type is null or p_type not in ('balance','concurrency','subscription')
  or p_value is null or p_value::text in ('NaN','Infinity','-Infinity') or p_value=0 or abs(p_value)>1000000000 or p_value<>round(p_value,8)
  or p_type='concurrency' and (p_value<>trunc(p_value) or abs(p_value)>1000000)
  or p_notes is null or length(p_notes)>10000 or p_expires_at<=now() then
  return jsonb_build_object('error','invalid_redeem_code','status',400);
 end if;
 if not exists(select 1 from auth.users where id=p_user_id and (banned_until is null or banned_until<=now())) then return jsonb_build_object('error','user_not_found','status',404); end if;
 if p_type='subscription' then
  if p_group_id is null or p_validity_days is null or abs(p_validity_days)>36500 or not exists(select 1 from public.s2a_groups where id=p_group_id and enabled and subscription_type='subscription') then
   return jsonb_build_object('error','invalid_subscription_group','status',400);
  end if;
 elsif p_group_id is not null or p_validity_days<>0 then return jsonb_build_object('error','invalid_redeem_group','status',400);
 end if;
 insert into public.s2a_user_limits(user_id) values(p_user_id) on conflict do nothing;
 perform 1 from public.s2a_user_limits where user_id=p_user_id for update;
 insert into public.s2a_redeem_codes(code,type,value,expires_at,notes,group_id,validity_days) values(trim(p_code),p_type,p_value,p_expires_at,p_notes,p_group_id,p_validity_days) on conflict(code) do nothing;
 select * into c from public.s2a_redeem_codes where code=trim(p_code) for update;
 if c.type<>p_type or c.value<>p_value or c.group_id is distinct from p_group_id or c.validity_days is distinct from p_validity_days or c.status='used' and c.used_by is distinct from p_user_id then
  return jsonb_build_object('error','redeem_code_conflict','status',409);
 end if;
 result:=public.s2a_redeem_use(p_user_id,p_code,true);
 if result ? 'error' then return result; end if;
 return jsonb_build_object('redeem_code',public.s2a_redeem_dto(c.id,true));
end $$;


revoke all on function public.s2a_redeem_generate(integer,text,numeric,timestamptz,text,uuid,integer) from public,anon,authenticated;
grant execute on function public.s2a_redeem_generate(integer,text,numeric,timestamptz,text,uuid,integer) to service_role;
revoke all on function public.s2a_redeem_create_and_use(uuid,text,text,numeric,timestamptz,text,uuid,integer) from public,anon,authenticated;
grant execute on function public.s2a_redeem_create_and_use(uuid,text,text,numeric,timestamptz,text,uuid,integer) to service_role;
