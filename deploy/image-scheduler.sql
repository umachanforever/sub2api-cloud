BEGIN;
create table if not exists public.s2a_image_scheduler (
 singleton boolean primary key default true check(singleton),
 endpoint text not null, secret_id uuid not null
);
alter table public.s2a_image_scheduler enable row level security;
revoke all on public.s2a_image_scheduler from public,anon,authenticated,service_role;

create or replace function public.s2a_image_jobs_dispatch() returns bigint
language plpgsql security definer set search_path='' as $$
declare config public.s2a_image_scheduler; key text; request_id bigint; crypto_schema text; ticket text; signature text;
begin
 select * into config from public.s2a_image_scheduler;
 if not found then return null;end if;
 execute 'select decrypted_secret from vault.decrypted_secrets where id=$1' into key using config.secret_id;
 if key is null then return null;end if;
 -- The pg_net queue can be readable by ordinary roles; enqueue only a short-lived ticket.
 ticket:=(floor(extract(epoch from clock_timestamp()))::bigint+90)::text||':'||gen_random_uuid()::text;
 select n.nspname into crypto_schema from pg_catalog.pg_extension e join pg_catalog.pg_namespace n on n.oid=e.extnamespace where e.extname='pgcrypto';
 execute format('select encode(%I.hmac($1,$2,''sha256''),''hex'')',crypto_schema) into signature using 's2a-images:'||ticket,key;
 execute 'select net.http_post(url:=$1,headers:=$2,body:=$3,timeout_milliseconds:=45000)'
 into request_id using config.endpoint,jsonb_build_object('Content-Type','application/json','x-s2a-images-job-token',ticket||':'||signature),'{}'::jsonb;
 return request_id;
end $$;

create or replace function public.s2a_image_scheduler_configure(p_url text,p_service_key text,p_enabled boolean default true)
returns jsonb language plpgsql security definer set search_path='' as $$
declare secret uuid; job bigint; payload text; role text;
begin
 if p_enabled is null then raise exception 'invalid_scheduler_enabled';end if;
 if not p_enabled then
  if exists(select 1 from pg_catalog.pg_extension where extname='pg_cron') then
   execute 'select jobid from cron.job where jobname=$1' into job using 's2a-images-jobs';
   if job is not null then execute 'select cron.unschedule($1)' using job;end if;
  end if;
  select secret_id into secret from public.s2a_image_scheduler;
  delete from public.s2a_image_scheduler;
  if secret is not null then execute 'delete from vault.secrets where id=$1' using secret;end if;
  return jsonb_build_object('enabled',false);
 end if;
 if p_url is null or p_url !~ '^(https://[a-z0-9-]+\.supabase\.co|http://kong:8000)$' then raise exception 'invalid_scheduler_url';end if;
 if p_service_key is null or p_service_key !~ '^[0-9a-f]{64}$' then raise exception 'invalid_scheduler_signing_key';end if;
 if (select count(*) from pg_catalog.pg_available_extensions where name in ('pg_cron','pg_net','supabase_vault','pgcrypto'))<>4 then
  return jsonb_build_object('error','scheduler_extensions_unavailable');
 end if;
 perform pg_catalog.set_config('search_path','public',true);
 execute 'create extension if not exists pg_cron';
 execute 'create extension if not exists pg_net';
 execute 'create extension if not exists supabase_vault';
 execute 'create extension if not exists pgcrypto';
 perform pg_catalog.set_config('search_path','',true);
 execute 'revoke all on all tables in schema vault from public,anon,authenticated';
 select secret_id into secret from public.s2a_image_scheduler;
 if secret is null then
  execute 'select vault.create_secret($1,$2,$3)' into secret using p_service_key,'s2a-images-job-key','Asynchronous image task scheduler signing key';
 else
  execute 'select vault.update_secret($1,$2)' using secret,p_service_key;
 end if;
 insert into public.s2a_image_scheduler(singleton,endpoint,secret_id) values(true,p_url||'/functions/v1/sub2api/internal/jobs/images',secret)
 on conflict(singleton) do update set endpoint=excluded.endpoint,secret_id=excluded.secret_id;
 execute 'select cron.schedule($1,$2,$3)' into job using 's2a-images-jobs','* * * * *','select public.s2a_image_jobs_dispatch();';
 return jsonb_build_object('enabled',true);
end $$;
revoke all on function public.s2a_image_jobs_dispatch() from public,anon,authenticated,service_role;
revoke all on function public.s2a_image_scheduler_configure(text,text,boolean) from public,anon,authenticated;
grant execute on function public.s2a_image_scheduler_configure(text,text,boolean) to service_role;
notify pgrst,'reload schema';

COMMIT;
