create function public.s2a_openai_auto_reset_dispatch() returns bigint
language plpgsql security definer set search_path='' as $$
declare config public.s2a_privacy_scheduler;key text;ticket text;signature text;crypto_schema text;request_id bigint;
begin
 if not exists(select 1 from public.s2a_openai_auto_reset_jobs where next_attempt_at<=now() and (lease_until is null or lease_until<=now())) then return null;end if;
 select * into config from public.s2a_privacy_scheduler;if not found then return null;end if;
 execute 'select decrypted_secret from vault.decrypted_secrets where id=$1' into key using config.secret_id;if key is null then return null;end if;
 -- Only a short-lived scoped signature may enter the readable pg_net queue.
 ticket:=(floor(extract(epoch from clock_timestamp()))::bigint+90)::text||':'||gen_random_uuid()::text;
 select n.nspname into crypto_schema from pg_catalog.pg_extension e join pg_catalog.pg_namespace n on n.oid=e.extnamespace where e.extname='pgcrypto';
 execute format('select encode(%I.hmac($1,$2,''sha256''),''hex'')',crypto_schema) into signature using 's2a-quota-reset:'||ticket,key;
 execute 'select net.http_post(url:=$1,headers:=$2,body:=$3,timeout_milliseconds:=55000)'
 into request_id using regexp_replace(config.endpoint,'/privacy$','/quota-reset'),jsonb_build_object('Content-Type','application/json','x-s2a-quota-reset-job-token',ticket||':'||signature),'{}'::jsonb;
 return request_id;
end $$;
create function public.s2a_openai_auto_reset_scheduler_configure(p_enabled boolean default true)
returns jsonb language plpgsql security definer set search_path='' as $$
declare job bigint;
begin
 if p_enabled is null then raise exception 'invalid_scheduler_enabled';end if;
 if not exists(select 1 from pg_catalog.pg_extension where extname='pg_cron') then return jsonb_build_object('error','scheduler_extensions_unavailable');end if;
 if not p_enabled then
  execute 'select jobid from cron.job where jobname=$1' into job using 's2a-openai-auto-reset';
  if job is not null then execute 'select cron.unschedule($1)' using job;end if;
  return jsonb_build_object('enabled',false);
 end if;
 if not exists(select 1 from public.s2a_privacy_scheduler) then return jsonb_build_object('error','job_scheduler_not_configured');end if;
 execute 'select cron.schedule($1,$2,$3)' into job using 's2a-openai-auto-reset','* * * * *','select public.s2a_openai_auto_reset_dispatch();';
 return jsonb_build_object('enabled',true);
end $$;
revoke all on function public.s2a_openai_auto_reset_dispatch() from public,anon,authenticated,service_role;
revoke all on function public.s2a_openai_auto_reset_scheduler_configure(boolean) from public,anon,authenticated;
grant execute on function public.s2a_openai_auto_reset_scheduler_configure(boolean) to service_role;
notify pgrst,'reload schema';
