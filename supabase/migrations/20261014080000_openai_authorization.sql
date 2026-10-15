-- OAuth verifiers and pending credentials survive independent Edge invocations.
alter table public.s2a_accounts add column notes text not null default '';
alter table public.s2a_accounts add column extra jsonb not null default '{}';
create table public.s2a_oauth_sessions (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  state_hash text not null,
  ciphertext text not null,
  iv text not null,
  phase text not null default 'pending' check (phase in ('pending','exchanging')),
  expires_at timestamptz not null default now() + interval '30 minutes'
);
create table public.s2a_oauth_tickets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  account_fingerprint text not null,
  ciphertext text,
  iv text,
  metadata jsonb not null default '{}',
  used_account_id uuid references public.s2a_accounts(id) on delete cascade,
  used_for text check (used_for in ('create','replace')),
  expires_at timestamptz not null default now() + interval '10 minutes',
  check ((used_account_id is null and ciphertext is not null and iv is not null and used_for is null)
    or (used_account_id is not null and ciphertext is null and iv is null and used_for is not null))
);
create index on public.s2a_oauth_sessions(expires_at);
create index on public.s2a_oauth_tickets(expires_at);
alter table public.s2a_oauth_sessions enable row level security;
alter table public.s2a_oauth_tickets enable row level security;
revoke all on public.s2a_oauth_sessions, public.s2a_oauth_tickets from public, anon, authenticated;
grant all on public.s2a_oauth_sessions, public.s2a_oauth_tickets to service_role;

create function public.s2a_oauth_session_start(p_id uuid,p_user_id uuid,p_state_hash text,p_ciphertext text,p_iv text)
returns void language plpgsql set search_path='' as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_user_id::text, 0));
  delete from public.s2a_oauth_sessions where expires_at <= now();
  delete from public.s2a_oauth_tickets where expires_at <= now();
  if (select count(*) from public.s2a_oauth_sessions where user_id=p_user_id) >= 20 then
    raise check_violation using message='oauth_session_limit';
  end if;
  insert into public.s2a_oauth_sessions(id,user_id,state_hash,ciphertext,iv)
    values(p_id,p_user_id,p_state_hash,p_ciphertext,p_iv);
end $$;
create function public.s2a_oauth_session_claim(p_id uuid,p_user_id uuid,p_state_hash text)
returns jsonb language plpgsql set search_path='' as $$
declare s public.s2a_oauth_sessions;
begin
  update public.s2a_oauth_sessions set phase='exchanging'
    where id=p_id and user_id=p_user_id and state_hash=p_state_hash and expires_at > now() and phase='pending'
    returning * into s;
  if not found then return null; end if;
  return jsonb_build_object('ciphertext',s.ciphertext,'iv',s.iv);
end $$;

create function public.s2a_oauth_account_create(p_ticket_id uuid,p_user_id uuid,p_group_id uuid,p_name text,
  p_concurrency integer,p_priority integer,p_notes text default '',p_extra jsonb default '{}')
returns jsonb language plpgsql set search_path='' as $$
declare t public.s2a_oauth_tickets; a public.s2a_accounts;
begin
  select * into t from public.s2a_oauth_tickets where id=p_ticket_id and user_id=p_user_id and expires_at > now() for update;
  if not found then return jsonb_build_object('error','oauth_ticket_invalid','status',400); end if;
  if t.used_account_id is not null then
    if t.used_for <> 'create' then return jsonb_build_object('error','oauth_ticket_used','status',409); end if;
    return jsonb_build_object('id',t.used_account_id);
  end if;
  perform 1 from public.s2a_groups where id=p_group_id and platform='openai' for share;
  if not found then return jsonb_build_object('error','account_group_platform_mismatch','status',400); end if;
  insert into public.s2a_accounts(group_id,name,platform,type,concurrency,priority,notes,extra,account_fingerprint,ciphertext,iv)
    values(p_group_id,p_name,'openai','oauth',p_concurrency,p_priority,p_notes,t.metadata || p_extra,t.account_fingerprint,t.ciphertext,t.iv)
    returning * into a;
  update public.s2a_oauth_tickets set used_account_id=a.id,used_for='create',ciphertext=null,iv=null where id=t.id;
  return jsonb_build_object('id',a.id);
end $$;
create function public.s2a_oauth_account_replace(p_ticket_id uuid,p_user_id uuid,p_account_id uuid,p_extra jsonb default '{}')
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
  update public.s2a_accounts set ciphertext=t.ciphertext,iv=t.iv,extra=extra || t.metadata || p_extra,
    credential_version=credential_version+1,refresh_lock_id=null,refresh_lock_until=null,cooldown_until=null where id=a.id;
  update public.s2a_oauth_tickets set used_account_id=a.id,used_for='replace',ciphertext=null,iv=null where id=t.id;
  return jsonb_build_object('ok',true,'id',a.id);
end $$;
revoke all on function public.s2a_oauth_session_start(uuid,uuid,text,text,text), public.s2a_oauth_session_claim(uuid,uuid,text),
  public.s2a_oauth_account_create(uuid,uuid,uuid,text,integer,integer,text,jsonb), public.s2a_oauth_account_replace(uuid,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.s2a_oauth_session_start(uuid,uuid,text,text,text), public.s2a_oauth_session_claim(uuid,uuid,text),
  public.s2a_oauth_account_create(uuid,uuid,uuid,text,integer,integer,text,jsonb), public.s2a_oauth_account_replace(uuid,uuid,uuid,jsonb) to service_role;
