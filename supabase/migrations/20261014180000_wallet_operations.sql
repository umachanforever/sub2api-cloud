create function public.s2a_wallet_update(p_user_id uuid, p_amount numeric, p_operation text,
 p_notes text default '', p_actor_id uuid default null)
returns jsonb language plpgsql set search_path = '' as $$
declare w public.s2a_wallets; next_balance numeric(20,8); change numeric(20,8);
begin
 if p_amount is null or p_amount::text in ('NaN','Infinity','-Infinity') or p_amount < 0
  or p_amount > 1000000000 or p_amount <> round(p_amount,8)
  or p_operation is null or p_operation not in ('set','add','subtract') then
  return jsonb_build_object('error','invalid_balance','status',400);
 end if;
 if not exists(select 1 from auth.users where id=p_user_id) then
  return jsonb_build_object('error','user_not_found','status',404);
 end if;
 insert into public.s2a_wallets(user_id) values(p_user_id) on conflict do nothing;
 select * into w from public.s2a_wallets where user_id=p_user_id for update;
 next_balance := case p_operation when 'set' then p_amount when 'add' then w.balance+p_amount else w.balance-p_amount end;
 if next_balance < w.frozen_balance then
  return jsonb_build_object('error','insufficient_balance','status',409);
 end if;
 change := next_balance-w.balance;
 if change <> 0 then
  update public.s2a_wallets set balance=next_balance, updated_at=now() where user_id=p_user_id;
  insert into public.s2a_wallet_ledger(user_id,delta,balance_after,reason,notes,actor_id)
   values(p_user_id,change,next_balance,'admin_'||p_operation,coalesce(p_notes,''),p_actor_id);
 end if;
 return jsonb_build_object('balance',next_balance,'frozen_balance',w.frozen_balance);
end $$;

create function public.s2a_wallet_history(p_user_id uuid,p_page integer,p_size integer,p_type text default '')
returns jsonb language sql stable set search_path = '' as $$
 with filtered as (
  select * from public.s2a_wallet_ledger where user_id=p_user_id
   and (p_type='' or p_type='admin_balance' and reason in ('admin_set','admin_add','admin_subtract'))
 ), entries as (
  select id, '' as code, 'admin_balance' as type, delta as value,
   'used' as status, user_id as used_by, created_at as used_at, created_at,
   null::uuid as group_id, 0 as validity_days, notes, balance_after
  from filtered order by created_at desc,id desc limit p_size offset (p_page-1)*p_size
 ) select jsonb_build_object('items',coalesce((select jsonb_agg(to_jsonb(entries)) from entries),'[]'::jsonb),
  'total',(select count(*) from filtered),'page',p_page,'page_size',p_size,
  'pages',ceil((select count(*) from filtered)::numeric/p_size),
  'total_recharged',(select coalesce(sum(delta),0) from public.s2a_wallet_ledger
    where user_id=p_user_id and delta>0 and reason='admin_add'));
$$;
revoke all on function public.s2a_wallet_update(uuid,numeric,text,text,uuid) from public,anon,authenticated;
revoke all on function public.s2a_wallet_history(uuid,integer,integer,text) from public,anon,authenticated;
grant execute on function public.s2a_wallet_update(uuid,numeric,text,text,uuid) to service_role;
grant execute on function public.s2a_wallet_history(uuid,integer,integer,text) to service_role;
