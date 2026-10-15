-- Experimental Supabase schema; not a migration of an existing Sub2API database.
create table public.s2a_groups (
  id uuid primary key default gen_random_uuid(),
  name text not null unique check (length(name) between 1 and 100),
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);
create table public.s2a_memberships (
  user_id uuid not null references auth.users(id) on delete cascade,
  group_id uuid not null references public.s2a_groups(id) on delete cascade,
  primary key (user_id, group_id)
);
create table public.s2a_accounts (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.s2a_groups(id),
  name text not null check (length(name) between 1 and 100),
  platform text not null default 'openai' check (platform = 'openai'),
  type text not null default 'oauth' check (type = 'oauth'),
  status text not null default 'active' check (status in ('active', 'disabled')),
  concurrency integer not null default 3 check (concurrency between 1 and 100),
  priority integer not null default 50 check (priority between 0 and 1000),
  -- One imported ChatGPT account identity, even across routing groups.
  account_fingerprint text not null unique,
  ciphertext text not null,
  iv text not null,
  credential_version bigint not null default 1,
  refresh_lock_id uuid,
  refresh_lock_until timestamptz,
  cooldown_until timestamptz,
  last_used_at timestamptz,
  created_at timestamptz not null default now()
);
create table public.s2a_keys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  group_id uuid not null references public.s2a_groups(id),
  name text not null check (length(name) between 1 and 100),
  key_hash text not null unique check (length(key_hash) = 64),
  key_prefix text not null,
  revoked boolean not null default false,
  expires_at timestamptz,
  rpm integer not null default 60 check (rpm between 1 and 1000),
  concurrency integer not null default 3 check (concurrency between 1 and 100),
  window_start timestamptz not null default now(),
  window_count integer not null default 0,
  created_at timestamptz not null default now()
);
create table public.s2a_leases (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null,
  account_id uuid not null references public.s2a_accounts(id),
  key_id uuid not null references public.s2a_keys(id) on delete cascade,
  model text not null,
  started_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '150 seconds')
);
create index s2a_leases_account on public.s2a_leases(account_id, expires_at);
create index s2a_leases_key on public.s2a_leases(key_id, expires_at);
create index s2a_accounts_schedule on public.s2a_accounts(group_id, priority, last_used_at);
create table public.s2a_usage (
  id uuid primary key,
  request_id uuid not null,
  account_id uuid not null references public.s2a_accounts(id),
  key_id uuid not null references public.s2a_keys(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  model text not null,
  status integer not null,
  outcome text not null check (outcome in ('completed', 'failed', 'cancelled', 'incomplete')),
  input_tokens bigint check (input_tokens >= 0),
  output_tokens bigint check (output_tokens >= 0),
  duration_ms integer not null check (duration_ms >= 0),
  created_at timestamptz not null default now()
);
create index s2a_usage_user on public.s2a_usage(user_id, created_at desc);

-- All access goes through the function's service role after application authorization.
do $$ declare t text; begin
  foreach t in array array['s2a_groups', 's2a_memberships', 's2a_accounts', 's2a_keys', 's2a_leases', 's2a_usage'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public, anon, authenticated', t);
    execute format('grant select, insert, update, delete on table public.%I to service_role', t);
  end loop;
end $$;

create function public.s2a_acquire(
  p_key_hash text, p_model text, p_request_id uuid,
  p_excluded uuid[] default '{}', p_count_request boolean default true
) returns jsonb language plpgsql set search_path = '' as $$
declare k public.s2a_keys; a public.s2a_accounts; lease_id uuid;
begin
  select * into k from public.s2a_keys where key_hash = p_key_hash for update;
  if not found or k.revoked or k.expires_at <= now() then
    return jsonb_build_object('error', 'invalid_api_key', 'status', 401);
  end if;
  if not exists (select 1 from auth.users u where u.id = k.user_id and (u.banned_until is null or u.banned_until <= now())) then
    return jsonb_build_object('error', 'invalid_api_key', 'status', 401);
  end if;
  if not exists (select 1 from public.s2a_groups g where g.id = k.group_id and g.enabled)
    or not exists (select 1 from public.s2a_memberships m where m.user_id = k.user_id and m.group_id = k.group_id) then
    return jsonb_build_object('error', 'group_access_denied', 'status', 403);
  end if;
  if p_count_request then
    if k.window_start <= now() - interval '60 seconds' then
      update public.s2a_keys set window_start = now(), window_count = 0 where id = k.id;
      k.window_count := 0;
    end if;
    if k.window_count >= k.rpm then
      return jsonb_build_object('error', 'rate_limit_exceeded', 'status', 429);
    end if;
  end if;
  delete from public.s2a_leases where expires_at <= now();
  if (select count(*) from public.s2a_leases l where l.key_id = k.id) >= k.concurrency then
    return jsonb_build_object('error', 'concurrency_limit_exceeded', 'status', 429);
  end if;
  select * into a from public.s2a_accounts candidate
    where candidate.group_id = k.group_id and candidate.status = 'active'
      and (candidate.cooldown_until is null or candidate.cooldown_until <= now())
      and not (candidate.id = any(p_excluded))
      and (select count(*) from public.s2a_leases l where l.account_id = candidate.id) < candidate.concurrency
    order by candidate.priority, candidate.last_used_at nulls first, candidate.id
    limit 1 for update skip locked;
  if not found then return jsonb_build_object('error', 'no_available_account', 'status', 503); end if;
  -- Recheck after locking: another key may have committed since the selection snapshot.
  if (select count(*) from public.s2a_leases l where l.account_id = a.id and l.expires_at > now()) >= a.concurrency then
    return jsonb_build_object('error', 'no_available_account', 'status', 503);
  end if;
  insert into public.s2a_leases(request_id, account_id, key_id, model)
    values (p_request_id, a.id, k.id, p_model) returning id into lease_id;
  update public.s2a_accounts set last_used_at = now() where id = a.id;
  if p_count_request then update public.s2a_keys set window_count = window_count + 1 where id = k.id; end if;
  return jsonb_build_object('lease_id', lease_id, 'account', to_jsonb(a));
end $$;

create function public.s2a_finish(
  p_lease_id uuid, p_status integer, p_outcome text,
  p_input_tokens bigint default null, p_output_tokens bigint default null,
  p_cooldown_seconds integer default 0
) returns void language plpgsql set search_path = '' as $$
declare l public.s2a_leases;
begin
  select * into l from public.s2a_leases where id = p_lease_id for update;
  if not found then return; end if;
  insert into public.s2a_usage(id, request_id, account_id, key_id, user_id, model,
    status, outcome, input_tokens, output_tokens, duration_ms)
    select l.id, l.request_id, l.account_id, l.key_id, k.user_id, l.model,
      p_status, p_outcome, p_input_tokens, p_output_tokens,
      greatest(0, floor(extract(epoch from (clock_timestamp() - l.started_at)) * 1000)::integer)
    from public.s2a_keys k where k.id = l.key_id;
  if p_cooldown_seconds > 0 then
    update public.s2a_accounts set cooldown_until = greatest(coalesce(cooldown_until, now()), now() + make_interval(secs => least(p_cooldown_seconds, 3600))) where id = l.account_id;
  end if;
  delete from public.s2a_leases where id = l.id;
end $$;

create function public.s2a_refresh_acquire(p_account_id uuid, p_version bigint, p_lock_id uuid)
returns boolean language plpgsql set search_path = '' as $$
begin
  update public.s2a_accounts set refresh_lock_id = p_lock_id, refresh_lock_until = now() + interval '30 seconds'
    where id = p_account_id and credential_version = p_version
      and (refresh_lock_until is null or refresh_lock_until <= now());
  return found;
end $$;
create function public.s2a_refresh_save(p_account_id uuid, p_lock_id uuid, p_ciphertext text, p_iv text)
returns boolean language plpgsql set search_path = '' as $$
begin
  update public.s2a_accounts set ciphertext = p_ciphertext, iv = p_iv,
    credential_version = credential_version + 1, refresh_lock_id = null, refresh_lock_until = null
    where id = p_account_id and refresh_lock_id = p_lock_id and refresh_lock_until > now();
  return found;
end $$;
create function public.s2a_refresh_release(p_account_id uuid, p_lock_id uuid)
returns void language sql set search_path = '' as $$
  update public.s2a_accounts set refresh_lock_id = null, refresh_lock_until = null
    where id = p_account_id and refresh_lock_id = p_lock_id;
$$;

revoke all on function public.s2a_acquire(text,text,uuid,uuid[],boolean) from public, anon, authenticated;
revoke all on function public.s2a_finish(uuid,integer,text,bigint,bigint,integer) from public, anon, authenticated;
revoke all on function public.s2a_refresh_acquire(uuid,bigint,uuid) from public, anon, authenticated;
revoke all on function public.s2a_refresh_save(uuid,uuid,text,text) from public, anon, authenticated;
revoke all on function public.s2a_refresh_release(uuid,uuid) from public, anon, authenticated;
grant execute on function public.s2a_acquire(text,text,uuid,uuid[],boolean) to service_role;
grant execute on function public.s2a_finish(uuid,integer,text,bigint,bigint,integer) to service_role;
grant execute on function public.s2a_refresh_acquire(uuid,bigint,uuid) to service_role;
grant execute on function public.s2a_refresh_save(uuid,uuid,text,text) to service_role;
grant execute on function public.s2a_refresh_release(uuid,uuid) to service_role;
