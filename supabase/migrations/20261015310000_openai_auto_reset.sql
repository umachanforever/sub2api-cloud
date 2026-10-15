create table public.s2a_openai_auto_reset_jobs (
 account_id uuid primary key references public.s2a_accounts(id) on delete cascade,
 revision bigint not null default 1,next_attempt_at timestamptz not null default now(),
 lease_id uuid,lease_until timestamptz
);
alter table public.s2a_openai_auto_reset_jobs enable row level security;
revoke all on public.s2a_openai_auto_reset_jobs from public,anon,authenticated,service_role;
create index s2a_openai_auto_reset_due on public.s2a_openai_auto_reset_jobs(next_attempt_at);

create function public.s2a_openai_auto_reset_config() returns trigger
language plpgsql security definer set search_path='' as $$
declare k text;v jsonb;
begin
 if new.extra ?| array['auto_reset_credit_enabled','auto_reset_credit_5h_threshold','auto_reset_credit_7d_threshold'] then
  if new.platform<>'openai' or new.type<>'oauth' then raise exception 'invalid_auto_reset_account';end if;
  if new.extra?'auto_reset_credit_enabled' and jsonb_typeof(new.extra->'auto_reset_credit_enabled')<>'boolean' then raise exception 'invalid_auto_reset_enabled';end if;
  foreach k in array array['auto_reset_credit_5h_threshold','auto_reset_credit_7d_threshold'] loop
   v:=new.extra->k;
   if v is not null and (jsonb_typeof(v)<>'number' or (v#>>'{}')::numeric<0.001 or (v#>>'{}')::numeric>1) then raise exception 'invalid_auto_reset_threshold';end if;
   if v is null and new.extra->'auto_reset_credit_enabled'='true'::jsonb then new.extra:=new.extra||jsonb_build_object(k,1);end if;
  end loop;
 end if;
 -- Account edits and imports cannot erase a worker's saved attempt identity.
 if tg_op='UPDATE' and old.extra?'codex_auto_reset_credit_state' and not new.extra?'codex_auto_reset_credit_state' then
  new.extra:=new.extra||jsonb_build_object('codex_auto_reset_credit_state',old.extra->'codex_auto_reset_credit_state');
 end if;
 return new;
end $$;
create trigger s2a_openai_auto_reset_config before insert or update of extra,platform,type on public.s2a_accounts
 for each row execute function public.s2a_openai_auto_reset_config();

create function public.s2a_openai_auto_reset_enqueue() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if new.platform<>'openai' or new.type<>'oauth' or new.status<>'active' or not new.schedulable or new.extra->'auto_reset_credit_enabled' is distinct from 'true'::jsonb then
  delete from public.s2a_openai_auto_reset_jobs where account_id=new.id;
 elsif tg_op='INSERT' then
  insert into public.s2a_openai_auto_reset_jobs(account_id) values(new.id) on conflict do nothing;
 elsif new.credential_version is distinct from old.credential_version or new.status is distinct from old.status or new.schedulable is distinct from old.schedulable
  or new.extra->'auto_reset_credit_enabled' is distinct from old.extra->'auto_reset_credit_enabled'
  or new.extra->'auto_reset_credit_5h_threshold' is distinct from old.extra->'auto_reset_credit_5h_threshold'
  or new.extra->'auto_reset_credit_7d_threshold' is distinct from old.extra->'auto_reset_credit_7d_threshold' then
  insert into public.s2a_openai_auto_reset_jobs(account_id) values(new.id)
  on conflict(account_id) do update set revision=s2a_openai_auto_reset_jobs.revision+1,next_attempt_at=now(),lease_id=null,lease_until=null;
 end if;
 return new;
end $$;
create trigger s2a_openai_auto_reset_enqueue after insert or update of extra,credential_version,status,schedulable,platform,type on public.s2a_accounts
 for each row execute function public.s2a_openai_auto_reset_enqueue();
insert into public.s2a_openai_auto_reset_jobs(account_id) select id from public.s2a_accounts
 where platform='openai' and type='oauth' and status='active' and schedulable and extra->'auto_reset_credit_enabled'='true'::jsonb;

create function public.s2a_openai_auto_reset_claim() returns jsonb
language sql security definer set search_path='' as $$
 with due as (
  select account_id from public.s2a_openai_auto_reset_jobs where next_attempt_at<=now() and (lease_until is null or lease_until<=now())
  order by next_attempt_at,account_id limit 4 for update skip locked
 ), claimed as (
  update public.s2a_openai_auto_reset_jobs j set lease_id=gen_random_uuid(),lease_until=now()+interval '3 minutes'
  from due where j.account_id=due.account_id returning j.account_id,j.revision,j.lease_id
 ) select coalesce(jsonb_agg(to_jsonb(claimed)),'[]'::jsonb) from claimed;
$$;

create function public.s2a_openai_auto_reset_state(p_account_id uuid,p_revision bigint,p_lease_id uuid,p_state jsonb)
returns boolean language plpgsql security definer set search_path='' as $$
declare a public.s2a_accounts;e record;clean jsonb:='{}';
begin
 if p_state is null or jsonb_typeof(p_state)<>'object' or octet_length(p_state::text)>8192
  or jsonb_typeof(p_state->'status') is distinct from 'string' or p_state->>'status' not in ('checking','available','resetting','success','no_credit','failed')
  or jsonb_typeof(p_state->'available_count') is distinct from 'number' or p_state->>'available_count' !~ '^[0-9]+$'
  or (p_state->>'available_count')::numeric>1000000 then raise exception 'invalid_auto_reset_state';end if;
 for e in select * from jsonb_each(p_state) loop
  if e.key in ('status','available_count') then clean:=clean||jsonb_build_object(e.key,e.value);
  elsif e.key in ('checked_at','last_result_at') then
   if jsonb_typeof(e.value)<>'string' or length(e.value#>>'{}')>64 then raise exception 'invalid_auto_reset_state';end if;
   begin perform (e.value#>>'{}')::timestamptz;exception when others then raise exception 'invalid_auto_reset_state';end;
   clean:=clean||jsonb_build_object(e.key,e.value);
  elsif e.key in ('attempt_cycle_hash','attempt_credit_hash') then
   if jsonb_typeof(e.value)<>'string' or e.value#>>'{}' !~ '^[a-f0-9]{24}$' then raise exception 'invalid_auto_reset_state';end if;
   clean:=clean||jsonb_build_object(e.key,e.value);
  elsif e.key='trigger_window' then
   if e.value not in ('""'::jsonb,'"5h"'::jsonb,'"7d"'::jsonb,'"5h+7d"'::jsonb) then raise exception 'invalid_auto_reset_state';end if;
   clean:=clean||jsonb_build_object(e.key,e.value);
  elsif e.key='error_code' then
   if jsonb_typeof(e.value)<>'string' or e.value#>>'{}' !~ '^[A-Za-z][A-Za-z0-9_]{0,95}$' then raise exception 'invalid_auto_reset_state';end if;
   clean:=clean||jsonb_build_object(e.key,e.value);
  else raise exception 'invalid_auto_reset_state';end if;
 end loop;
 select * into a from public.s2a_accounts where id=p_account_id for update;
 if not found or a.extra->'auto_reset_credit_enabled' is distinct from 'true'::jsonb or a.status<>'active' or not a.schedulable then return false;end if;
 perform 1 from public.s2a_openai_auto_reset_jobs where account_id=p_account_id and revision=p_revision and lease_id=p_lease_id and lease_until>now() for update;
 if not found then return false;end if;
 update public.s2a_accounts set extra=extra||jsonb_build_object('codex_auto_reset_credit_state',clean) where id=p_account_id;
 return true;
end $$;
create function public.s2a_openai_auto_reset_finish(p_account_id uuid,p_revision bigint,p_lease_id uuid,p_state jsonb,p_delay integer)
returns boolean language plpgsql security definer set search_path='' as $$
begin
 if p_delay not in (60,600) or p_delay is null then raise exception 'invalid_auto_reset_delay';end if;
 if not public.s2a_openai_auto_reset_state(p_account_id,p_revision,p_lease_id,p_state) then return false;end if;
 update public.s2a_openai_auto_reset_jobs set lease_id=null,lease_until=null,next_attempt_at=now()+make_interval(secs=>p_delay) where account_id=p_account_id;
 if p_state?'last_result_at' and p_state?'attempt_cycle_hash' and p_state->>'status' in ('success','failed','no_credit') then
  insert into public.s2a_audit_logs(actor_email,actor_role,auth_method,action,method,path,status_code,extra)
  values('system','system','service','system.openai.reset_credit.auto','SYSTEM','/system/openai/accounts/'||p_account_id||'/auto-reset-credit',
   case when p_state->>'status'='success' then 200 else 409 end,
   jsonb_build_object('account_id',p_account_id,'result_code',p_state->>'status','trigger_window',p_state->>'trigger_window','available_count',p_state->'available_count','error_code',p_state->>'error_code'));
 end if;
 return true;
end $$;

alter table public.s2a_openai_quota_resets add column credit_id text check(credit_id is null or length(credit_id) between 1 and 512);
alter table public.s2a_openai_quota_resets add column job_revision bigint,add column job_lease_id uuid;
drop function public.s2a_openai_quota_reset_begin(uuid,uuid,text,bigint);
create function public.s2a_openai_quota_reset_begin(p_account_id uuid,p_actor_id uuid,p_key text,p_version bigint,p_credit_id text default null,p_job_revision bigint default null,p_job_lease_id uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare a public.s2a_accounts;j public.s2a_openai_quota_resets;
begin
 if p_key is null or p_key !~ '^[A-Za-z0-9._:-]{1,128}$' then raise exception 'invalid_idempotency_key';end if;
 if p_credit_id is not null and (length(p_credit_id) not between 1 and 512 or p_credit_id ~ '[[:cntrl:]]') then raise exception 'invalid_credit_id';end if;
 select * into a from public.s2a_accounts where id=p_account_id for update;
 if not found then return jsonb_build_object('error','account_not_found','status',404);end if;
 if a.platform<>'openai' or a.type<>'oauth' then return jsonb_build_object('error','openai_quota_requires_oauth','status',400);end if;
 if p_credit_id is not null and (a.extra->'auto_reset_credit_enabled' is distinct from 'true'::jsonb or a.status<>'active' or not a.schedulable) then return jsonb_build_object('error','auto_reset_disabled','status',409);end if;
 if p_credit_id is not null and not exists(select 1 from public.s2a_openai_auto_reset_jobs where account_id=a.id and revision=p_job_revision and lease_id=p_job_lease_id and lease_until>now()) then return jsonb_build_object('error','auto_reset_job_changed','status',409);end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(a.account_fingerprint,514));
 select * into j from public.s2a_openai_quota_resets where account_fingerprint=a.account_fingerprint and p_key=any(request_keys) order by created_at desc limit 1 for update;
 if found and j.credit_id is distinct from p_credit_id then return jsonb_build_object('error','quota_reset_target_conflict','status',409);end if;
 if found and j.completed_at is not null then return jsonb_build_object('response',j.response_result,'replayed',true);end if;
 if not found then select * into j from public.s2a_openai_quota_resets where account_fingerprint=a.account_fingerprint and completed_at is null for update;end if;
 if j.id is not null then
  if j.credit_id is distinct from p_credit_id then return jsonb_build_object('error','quota_reset_target_conflict','status',409);end if;
  if not p_key=any(j.request_keys) then
   if cardinality(j.request_keys)>=128 then return jsonb_build_object('error','quota_reset_retry_limit','status',429);end if;
   update public.s2a_openai_quota_resets set request_keys=array_append(request_keys,p_key) where id=j.id;
  end if;
  if j.lease_until>now() then return jsonb_build_object('error','openai_quota_reset_in_progress','status',409);end if;
 end if;
 if a.credential_version is distinct from p_version then return jsonb_build_object('error','account_credentials_changed_retry','status',409);end if;
 if j.id is null then
  insert into public.s2a_openai_quota_resets(account_id,account_fingerprint,actor_id,request_keys,credit_id,job_revision,job_lease_id)
   values(a.id,a.account_fingerprint,p_actor_id,array[p_key],p_credit_id,p_job_revision,p_job_lease_id) returning * into j;
 else update public.s2a_openai_quota_resets set account_id=a.id,lease_id=gen_random_uuid(),lease_until=now()+interval '3 minutes',job_revision=p_job_revision,job_lease_id=p_job_lease_id where id=j.id returning * into j;end if;
 return jsonb_build_object('id',j.id,'lease_id',j.lease_id,'consumed',j.consumed_result);
end $$;
create or replace function public.s2a_openai_quota_reset_dispatch(p_id uuid,p_lease_id uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare a public.s2a_accounts;j public.s2a_openai_quota_resets;
begin
 select a0.* into a from public.s2a_accounts a0 join public.s2a_openai_quota_resets j0 on j0.account_id=a0.id where j0.id=p_id for update of a0;
 if not found then return false;end if;
 select * into j from public.s2a_openai_quota_resets where id=p_id for update;
 if j.credit_id is not null and (a.extra->'auto_reset_credit_enabled' is distinct from 'true'::jsonb or a.status<>'active' or not a.schedulable) then return false;end if;
 if j.credit_id is not null and not exists(select 1 from public.s2a_openai_auto_reset_jobs where account_id=a.id and revision=j.job_revision and lease_id=j.job_lease_id and lease_until>now()) then return false;end if;
 update public.s2a_openai_quota_resets set dispatched_at=coalesce(dispatched_at,now())
  where id=p_id and lease_id=p_lease_id and lease_until>now() and completed_at is null and consumed_result is null;
 return found;
end $$;
create function public.s2a_openai_auto_reset_pending(p_account_id uuid) returns jsonb
language sql security definer set search_path='' as $$
 select jsonb_build_object('credit_id',j.credit_id,'key',j.request_keys[1]) from public.s2a_openai_quota_resets j
 join public.s2a_accounts a on a.account_fingerprint=j.account_fingerprint where a.id=p_account_id and j.completed_at is null and j.credit_id is not null;
$$;
revoke all on function public.s2a_openai_auto_reset_config(),public.s2a_openai_auto_reset_enqueue() from public,anon,authenticated,service_role;
revoke all on function public.s2a_openai_auto_reset_claim(),public.s2a_openai_auto_reset_state(uuid,bigint,uuid,jsonb),public.s2a_openai_auto_reset_finish(uuid,bigint,uuid,jsonb,integer),public.s2a_openai_auto_reset_pending(uuid),public.s2a_openai_quota_reset_begin(uuid,uuid,text,bigint,text,bigint,uuid) from public,anon,authenticated;
grant execute on function public.s2a_openai_auto_reset_claim(),public.s2a_openai_auto_reset_state(uuid,bigint,uuid,jsonb),public.s2a_openai_auto_reset_finish(uuid,bigint,uuid,jsonb,integer),public.s2a_openai_auto_reset_pending(uuid),public.s2a_openai_quota_reset_begin(uuid,uuid,text,bigint,text,bigint,uuid) to service_role;
notify pgrst,'reload schema';
