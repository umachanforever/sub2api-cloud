create table public.s2a_wallets (
  user_id uuid primary key references auth.users(id) on delete cascade,
  balance numeric(20,8) not null default 0 check (balance >= 0),
  frozen_balance numeric(20,8) not null default 0 check (frozen_balance >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table public.s2a_wallet_ledger (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  delta numeric(20,8) not null,
  balance_after numeric(20,8) not null check (balance_after >= 0),
  reason text not null check (length(reason) between 1 and 200),
  notes text not null default '',
  actor_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index s2a_wallet_ledger_user on public.s2a_wallet_ledger(user_id, created_at desc, id desc);
do $$ declare t text; begin
  foreach t in array array['s2a_wallets','s2a_wallet_ledger'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public, anon, authenticated', t);
    execute format('grant select, insert, update, delete on table public.%I to service_role', t);
  end loop;
end $$;

create function public.s2a_wallet_get(p_user_id uuid) returns jsonb
language plpgsql set search_path = '' as $$
declare w public.s2a_wallets;
begin
  insert into public.s2a_wallets(user_id) values (p_user_id) on conflict (user_id) do nothing;
  select * into w from public.s2a_wallets where user_id = p_user_id;
  return jsonb_build_object('user_id', w.user_id, 'balance', w.balance::float8,
    'frozen_balance', w.frozen_balance::float8, 'updated_at', w.updated_at);
end $$;

create function public.s2a_wallet_adjust(
  p_user_id uuid, p_delta numeric, p_reason text, p_notes text default '', p_actor_id uuid default null
) returns jsonb language plpgsql set search_path = '' as $$
declare w public.s2a_wallets; next_balance numeric;
begin
  if p_delta is null or p_delta = 0 or abs(p_delta) > 1000000000 then
    return jsonb_build_object('error','invalid_balance_delta','status',400);
  end if;
  insert into public.s2a_wallets(user_id) values (p_user_id) on conflict (user_id) do nothing;
  select * into w from public.s2a_wallets where user_id = p_user_id for update;
  next_balance := w.balance + p_delta;
  if next_balance < 0 then return jsonb_build_object('error','insufficient_balance','status',409); end if;
  update public.s2a_wallets set balance = next_balance, updated_at = now() where user_id = p_user_id;
  insert into public.s2a_wallet_ledger(user_id,delta,balance_after,reason,notes,actor_id)
    values(p_user_id,p_delta,next_balance,left(coalesce(p_reason,'manual'),200),left(coalesce(p_notes,''),2000),p_actor_id);
  return jsonb_build_object('user_id',p_user_id,'balance',next_balance::float8,'frozen_balance',w.frozen_balance::float8,'updated_at',now());
end $$;
revoke all on function public.s2a_wallet_get(uuid) from public, anon, authenticated;
revoke all on function public.s2a_wallet_adjust(uuid,numeric,text,text,uuid) from public, anon, authenticated;
grant execute on function public.s2a_wallet_get(uuid) to service_role;
grant execute on function public.s2a_wallet_adjust(uuid,numeric,text,text,uuid) to service_role;
