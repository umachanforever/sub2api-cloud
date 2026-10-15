create table public.s2a_privacy_jobs (
 account_id uuid primary key references public.s2a_accounts(id) on delete cascade,
 revision bigint not null default 1,
 attempts integer not null default 0,
 next_attempt_at timestamptz not null default now(),
 lease_id uuid, lease_until timestamptz,
 last_error text check(last_error in ('verification_failed','worker_failed','training_set_cf_blocked'))
);
alter table public.s2a_privacy_jobs enable row level security;
revoke all on public.s2a_privacy_jobs from public,anon,authenticated,service_role;
create index s2a_privacy_jobs_due on public.s2a_privacy_jobs(next_attempt_at);

create function public.s2a_privacy_enqueue() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if new.platform<>'openai' or new.type<>'oauth' then
  delete from public.s2a_privacy_jobs where account_id=new.id;
 elsif coalesce(btrim(new.extra->>'privacy_mode'),'') in ('','training_set_failed','training_set_cf_blocked') then
  if tg_op='INSERT' then
   insert into public.s2a_privacy_jobs(account_id) values(new.id) on conflict do nothing;
  elsif new.credential_version is distinct from old.credential_version or new.ciphertext is distinct from old.ciphertext or new.iv is distinct from old.iv
   or new.platform is distinct from old.platform or new.type is distinct from old.type
   or coalesce(btrim(old.extra->>'privacy_mode'),'') not in ('','training_set_failed','training_set_cf_blocked') then
   insert into public.s2a_privacy_jobs(account_id) values(new.id)
   on conflict(account_id) do update set revision=s2a_privacy_jobs.revision+1,attempts=0,next_attempt_at=now(),lease_id=null,lease_until=null,last_error=null;
  end if;
 end if;
 return new;
end $$;
create trigger s2a_privacy_enqueue after insert or update of platform,type,credential_version,ciphertext,iv,extra on public.s2a_accounts
 for each row execute function public.s2a_privacy_enqueue();
insert into public.s2a_privacy_jobs(account_id)
 select id from public.s2a_accounts where platform='openai' and type='oauth'
 and coalesce(btrim(extra->>'privacy_mode'),'') in ('','training_set_failed','training_set_cf_blocked');

create function public.s2a_privacy_jobs_claim() returns jsonb
language sql security definer set search_path='' as $$
 with due as (
  select account_id from public.s2a_privacy_jobs where next_attempt_at<=now() and (lease_until is null or lease_until<=now())
  order by next_attempt_at,account_id limit 4 for update skip locked
 ), claimed as (
  update public.s2a_privacy_jobs j set lease_id=gen_random_uuid(),lease_until=now()+interval '120 seconds',attempts=least(attempts+1,1000000)
  from due where j.account_id=due.account_id returning j.account_id,j.revision,j.lease_id
 ) select coalesce(jsonb_agg(to_jsonb(claimed)),'[]'::jsonb) from claimed;
$$;
create function public.s2a_privacy_jobs_finish(p_account_id uuid,p_revision bigint,p_lease_id uuid,p_error text default null)
returns boolean language plpgsql security definer set search_path='' as $$
declare j public.s2a_privacy_jobs; mode text; supported boolean;
begin
 if p_error is not null and p_error<>'worker_failed' then raise exception 'invalid_privacy_job_error';end if;
 select * into j from public.s2a_privacy_jobs where account_id=p_account_id and revision=p_revision and lease_id=p_lease_id and lease_until>now() for update;
 if not found then return false;end if;
 -- Do not lock accounts here: account writes acquire the job lock in the enqueue trigger.
 select btrim(extra->>'privacy_mode'),platform='openai' and type='oauth' into mode,supported from public.s2a_accounts where id=p_account_id;
 if not found or not supported or (coalesce(mode,'') not in ('','training_set_failed','training_set_cf_blocked') and p_error is null) then
  delete from public.s2a_privacy_jobs where account_id=p_account_id;
 else
  update public.s2a_privacy_jobs set lease_id=null,lease_until=null,
   next_attempt_at=now()+make_interval(secs=>greatest(case when mode='training_set_cf_blocked' then 900 else 60 end,least(21600,60*power(2,least(j.attempts-1,9))::integer))),
   last_error=coalesce(p_error,case when mode='training_set_cf_blocked' then mode else 'verification_failed' end)
   where account_id=p_account_id;
 end if;
 return true;
end $$;
revoke all on function public.s2a_privacy_enqueue() from public,anon,authenticated;
revoke all on function public.s2a_privacy_jobs_claim() from public,anon,authenticated;
revoke all on function public.s2a_privacy_jobs_finish(uuid,bigint,uuid,text) from public,anon,authenticated;
grant execute on function public.s2a_privacy_jobs_claim(),public.s2a_privacy_jobs_finish(uuid,bigint,uuid,text) to service_role;
notify pgrst,'reload schema';
