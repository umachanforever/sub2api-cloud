create table public.s2a_audit_logs (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  actor_user_id uuid references auth.users(id) on delete set null,
  actor_email text not null default '',
  actor_role text not null default 'system',
  auth_method text not null default 'service',
  credential_masked text not null default '',
  action text not null,
  method text not null default '',
  path text not null default '',
  request_id text not null default '',
  client_ip text not null default '',
  user_agent text not null default '',
  status_code integer not null default 200,
  latency_ms integer,
  extra jsonb not null default '{}'
);
create index s2a_audit_logs_created on public.s2a_audit_logs(created_at desc,id desc);
create index s2a_audit_logs_actor on public.s2a_audit_logs(actor_user_id,created_at desc);
alter table public.s2a_audit_logs enable row level security;
revoke all on public.s2a_audit_logs from public,anon,authenticated,service_role;
grant select on public.s2a_audit_logs to service_role;

create function public.s2a_audit_mutation() returns trigger
language plpgsql security definer set search_path = '' as $$
declare headers jsonb; before_row jsonb; after_row jsonb; changed jsonb;
begin
  headers := coalesce(nullif(current_setting('request.headers', true), ''), '{}')::jsonb;
  before_row := case when tg_op = 'INSERT' then '{}'::jsonb else to_jsonb(old) end;
  after_row := case when tg_op = 'DELETE' then '{}'::jsonb else to_jsonb(new) end;
  select coalesce(jsonb_agg(k), '[]'::jsonb) into changed
  from jsonb_object_keys(before_row || after_row) k
  where k not in ('ciphertext','iv','key_hash','refresh_lock_id','refresh_lock_until',
    'last_used_at','window_start','window_count','credential_version','cooldown_until')
    and before_row->k is distinct from after_row->k;
  if tg_op = 'UPDATE' and (before_row->'ciphertext' is distinct from after_row->'ciphertext'
    or before_row->'iv' is distinct from after_row->'iv') then
    changed := changed || '["credentials"]'::jsonb;
  end if;
  if changed = '[]'::jsonb then
    return coalesce(new,old);
  end if;
  insert into public.s2a_audit_logs(actor_user_id,actor_email,actor_role,auth_method,
    action,method,path,request_id,extra)
  values(nullif(headers->>'x-s2a-actor-id','')::uuid,
    coalesce(headers->>'x-s2a-actor-email',''),
    coalesce(headers->>'x-s2a-actor-role','system'),
    case when headers ? 'x-s2a-actor-id' then 'jwt' else 'service' end,
    tg_table_name || '.' || lower(tg_op),
    coalesce(headers->>'x-s2a-request-method',''),
    coalesce(headers->>'x-s2a-request-path',''),
    coalesce(headers->>'x-s2a-request-id',''),
    jsonb_build_object('resource_id',coalesce(after_row->>'id',before_row->>'id'),
      'changed_fields',changed));
  return coalesce(new,old);
end $$;
revoke all on function public.s2a_audit_mutation() from public,anon,authenticated,service_role;
create trigger s2a_groups_audit after insert or update or delete on public.s2a_groups
  for each row execute function public.s2a_audit_mutation();
create trigger s2a_accounts_audit after insert or update or delete on public.s2a_accounts
  for each row execute function public.s2a_audit_mutation();
create trigger s2a_keys_audit after insert or update or delete on public.s2a_keys
  for each row execute function public.s2a_audit_mutation();
create trigger s2a_memberships_audit after insert or update or delete on public.s2a_memberships
  for each row execute function public.s2a_audit_mutation();

create function public.s2a_audit_clear(p_user_id uuid,p_email text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare deleted_count bigint;
begin
  -- Serialise a clear with mutations so no committed management event disappears uncounted.
  lock table public.s2a_audit_logs in exclusive mode;
  delete from public.s2a_audit_logs;
  get diagnostics deleted_count = row_count;
  insert into public.s2a_audit_logs(actor_user_id,actor_email,actor_role,auth_method,
    action,method,path,extra)
  values(p_user_id,p_email,'admin','jwt+totp','audit_logs.clear','POST',
    '/api/v1/admin/audit-logs/clear',jsonb_build_object('deleted',deleted_count));
  return jsonb_build_object('deleted',deleted_count);
end $$;
revoke all on function public.s2a_audit_clear(uuid,text) from public,anon,authenticated;
grant execute on function public.s2a_audit_clear(uuid,text) to service_role;
