-- Account lifecycle is separate from credential expiration and operational status.
alter table public.s2a_accounts add column schedulable boolean not null default true;
alter table public.s2a_accounts add column expires_at timestamptz;
alter table public.s2a_accounts add column auto_pause_on_expired boolean not null default true;

create or replace function public.s2a_acquire(
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
    where candidate.group_id = k.group_id and candidate.status = 'active' and candidate.schedulable
      and (not candidate.auto_pause_on_expired or candidate.expires_at is null or candidate.expires_at > now())
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

drop function public.s2a_oauth_account_create(uuid,uuid,uuid,text,integer,integer,text,jsonb);
create function public.s2a_oauth_account_create(p_ticket_id uuid,p_user_id uuid,p_group_id uuid,p_name text,
  p_concurrency integer,p_priority integer,p_notes text default '',p_extra jsonb default '{}',p_schedulable boolean default true,p_expires_at timestamptz default null,p_auto_pause_on_expired boolean default true,p_status text default 'active')
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
  insert into public.s2a_accounts(group_id,name,platform,type,concurrency,priority,notes,extra,account_fingerprint,ciphertext,iv,schedulable,expires_at,auto_pause_on_expired,status)
    values(p_group_id,p_name,'openai','oauth',p_concurrency,p_priority,p_notes,t.metadata || p_extra,t.account_fingerprint,t.ciphertext,t.iv,p_schedulable,p_expires_at,p_auto_pause_on_expired,p_status)
    returning * into a;
  update public.s2a_oauth_tickets set used_account_id=a.id,used_for='create',ciphertext=null,iv=null where id=t.id;
  return jsonb_build_object('id',a.id);
end $$;
revoke all on function public.s2a_oauth_account_create(uuid,uuid,uuid,text,integer,integer,text,jsonb,boolean,timestamptz,boolean,text) from public,anon,authenticated;
grant execute on function public.s2a_oauth_account_create(uuid,uuid,uuid,text,integer,integer,text,jsonb,boolean,timestamptz,boolean,text) to service_role;
