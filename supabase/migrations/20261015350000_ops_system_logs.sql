create table public.s2a_log_runtime (
 id boolean primary key default true check(id),
 config jsonb not null default '{"level":"info","persist_access_logs":false,"enable_sampling":false,"sampling_initial":100,"sampling_thereafter":100,"caller":true,"stacktrace_level":"error","retention_days":30,"request_retention_days":0}',
 updated_at timestamptz not null default now(), updated_by_user_id uuid
);
insert into public.s2a_log_runtime(id) values(true);
create table public.s2a_system_logs (
 id bigint generated always as identity primary key, created_at timestamptz not null default clock_timestamp(),
 host text not null, level text not null, component text not null, message text not null,
 request_id text, client_request_id text, user_id uuid, api_key_id uuid, account_id uuid,
 platform text, model text, extra jsonb not null default '{}'
);
create index s2a_system_logs_created on public.s2a_system_logs(created_at desc,id desc);
create index s2a_system_logs_request on public.s2a_system_logs(request_id) where request_id is not null;
create table public.s2a_log_sink (
 id boolean primary key default true check(id), written_count bigint not null default 0,
 dropped_count bigint not null default 0, write_failed_count bigint not null default 0,
 total_write_delay_ms numeric not null default 0, last_error text
);
insert into public.s2a_log_sink(id) values(true);
create table public.s2a_log_samples (
 bucket timestamptz not null, level text not null, message text not null, count bigint not null,
 primary key(bucket,level,message)
);
alter table public.s2a_log_runtime enable row level security;
alter table public.s2a_system_logs enable row level security;
alter table public.s2a_log_sink enable row level security;
alter table public.s2a_log_samples enable row level security;
revoke all on public.s2a_log_runtime,public.s2a_system_logs,public.s2a_log_sink,public.s2a_log_samples from public,anon,authenticated,service_role;
grant select on public.s2a_system_logs to service_role;
create trigger s2a_log_runtime_audit after update on public.s2a_log_runtime for each row execute function public.s2a_audit_mutation();

create function public.s2a_log_config_get() returns jsonb language sql stable security definer set search_path='' as $$
 select config||jsonb_build_object('source','database','updated_at',updated_at,'updated_by_user_id',updated_by_user_id) from public.s2a_log_runtime where id=true;
$$;
create function public.s2a_log_config_set(p_config jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare e record; actor text;
begin
 if p_config is null or jsonb_typeof(p_config)<>'object' or (select count(*) from jsonb_object_keys(p_config))<>9 then raise exception 'invalid_log_config';end if;
 for e in select * from jsonb_each(p_config) loop
  if e.key='level' then
   if jsonb_typeof(e.value)<>'string' or e.value#>>'{}' not in('debug','info','warn','error') then raise exception 'invalid_log_config';end if;
  elsif e.key='stacktrace_level' then
   if jsonb_typeof(e.value)<>'string' or e.value#>>'{}' not in('none','error','fatal') then raise exception 'invalid_log_config';end if;
  elsif e.key in('persist_access_logs','enable_sampling','caller') then
   if jsonb_typeof(e.value)<>'boolean' then raise exception 'invalid_log_config';end if;
  elsif e.key in('sampling_initial','sampling_thereafter','retention_days','request_retention_days') then
   if jsonb_typeof(e.value)<>'number' or e.value#>>'{}' !~ '^[0-9]+$' then raise exception 'invalid_log_config';end if;
   if (e.value#>>'{}')::numeric<(case when e.key='request_retention_days' then 0 else 1 end)
    or (e.value#>>'{}')::numeric>(case when e.key like 'sampling_%' then 1000000 else 3650 end) then raise exception 'invalid_log_config';end if;
  else raise exception 'invalid_log_config';end if;
 end loop;
 actor:=nullif(current_setting('request.headers',true),'')::jsonb->>'x-s2a-actor-id';
 update public.s2a_log_runtime set config=p_config,updated_at=clock_timestamp(),updated_by_user_id=actor::uuid where id=true;
 return public.s2a_log_config_get();
end $$;

create function public.s2a_log_write(p_event jsonb) returns boolean language plpgsql security definer set search_path='' as $$
declare cfg jsonb; event_level text; msg text; extra jsonb; n bigint; started timestamptz:=clock_timestamp();
begin
 select config into cfg from public.s2a_log_runtime where id=true;
 if jsonb_typeof(p_event)<>'object' or p_event is null or octet_length(p_event::text)>16384 then raise exception 'invalid_log_event';end if;
 event_level:=p_event->>'level'; msg:=p_event->>'message'; extra:=coalesce(p_event->'extra','{}'::jsonb);
 if event_level is null or event_level not in('debug','info','warn','error','fatal') or msg is null or msg not in('response_started','request_completed','request_failed','unhandled_error')
  or p_event->>'host'<>'supabase-edge' or p_event->>'host' is null or p_event->>'component' not in('edge','gateway') or p_event->>'component' is null
  or jsonb_typeof(extra)<>'object' then raise exception 'invalid_log_event';end if;
 if array_position(array['debug','info','warn','error','fatal'],event_level)<array_position(array['debug','info','warn','error','fatal'],cfg->>'level')
  or (msg in('response_started','request_completed') and not (cfg->>'persist_access_logs')::boolean) then return false;end if;
 if not (cfg->>'caller')::boolean then extra:=extra-'caller';end if;
 if cfg->>'stacktrace_level'='none' or (cfg->>'stacktrace_level'='fatal' and event_level<>'fatal') or event_level not in('error','fatal') then extra:=extra-'stacktrace';end if;
 begin
  if (cfg->>'enable_sampling')::boolean then
   insert into public.s2a_log_samples(bucket,level,message,count) values(date_trunc('second',started),event_level,msg,1)
    on conflict(bucket,level,message) do update set count=public.s2a_log_samples.count+1 returning count into n;
   if n>(cfg->>'sampling_initial')::integer and (n-(cfg->>'sampling_initial')::integer)%(cfg->>'sampling_thereafter')::integer<>0 then
    update public.s2a_log_sink set dropped_count=dropped_count+1 where id=true;return false;
   end if;
  end if;
  insert into public.s2a_system_logs(host,level,component,message,request_id,client_request_id,user_id,api_key_id,account_id,platform,model,extra)
  values(p_event->>'host',event_level,p_event->>'component',msg,p_event->>'request_id',p_event->>'client_request_id',
   (p_event->>'user_id')::uuid,(p_event->>'api_key_id')::uuid,(p_event->>'account_id')::uuid,p_event->>'platform',p_event->>'model',extra);
  update public.s2a_log_sink set written_count=written_count+1,total_write_delay_ms=total_write_delay_ms+greatest(0,extract(epoch from(clock_timestamp()-started))*1000) where id=true;
  return true;
 exception when others then
  update public.s2a_log_sink set write_failed_count=write_failed_count+1,last_error='system_log_write_failed' where id=true;
  return false;
 end;
end $$;
create function public.s2a_log_health() returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('queue_depth',0,'queue_capacity',0,'written_count',written_count,'dropped_count',dropped_count,
  'write_failed_count',write_failed_count,'avg_write_delay_ms',case when written_count=0 then 0 else total_write_delay_ms/written_count end,'last_error',last_error)
 from public.s2a_log_sink where id=true;
$$;
create function public.s2a_usage_system_log() returns trigger language plpgsql security definer set search_path='' as $$
begin
 perform public.s2a_log_write(jsonb_build_object('host','supabase-edge','component','gateway',
  'level',case when new.status>=500 then 'error' when new.status>=400 or new.outcome<>'completed' then 'warn' else 'info' end,
  'message',case when new.status>=400 or new.outcome<>'completed' then 'request_failed' else 'request_completed' end,
  'request_id',new.request_id,'user_id',new.user_id,'api_key_id',new.key_id,'account_id',new.account_id,
  'platform',(select platform from public.s2a_accounts where id=new.account_id),'model',new.model,
  'extra',jsonb_build_object('status_code',new.status,'latency_ms',new.duration_ms,'outcome',new.outcome,'caller','database.s2a_finish')));
 return new;
exception when others then
 -- Observability must never roll back a request settlement.
 return new;
end $$;
create trigger s2a_usage_system_log after insert on public.s2a_usage for each row execute function public.s2a_usage_system_log();

create function public.s2a_log_cleanup(p_filters jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare e record; removed bigint;
begin
 if p_filters is null or jsonb_typeof(p_filters)<>'object' or p_filters='{}'::jsonb then raise exception 'OPS_SYSTEM_LOG_CLEANUP_FILTER_REQUIRED';end if;
 for e in select * from jsonb_each(p_filters) loop
  if e.key not in('start_time','end_time','host','level','component','request_id','client_request_id','user_id','api_key_id','account_id','platform','model','q')
   or jsonb_typeof(e.value)<>'string' or length(e.value#>>'{}') not between 1 and 200 then raise exception 'invalid_log_filter';end if;
 end loop;
 if p_filters->>'start_time' is not null and p_filters->>'end_time' is not null and (p_filters->>'start_time')::timestamptz>(p_filters->>'end_time')::timestamptz then raise exception 'invalid_date_range';end if;
 delete from public.s2a_system_logs l where
  (p_filters->>'start_time' is null or l.created_at>=(p_filters->>'start_time')::timestamptz)
  and (p_filters->>'end_time' is null or l.created_at<=(p_filters->>'end_time')::timestamptz)
  and (p_filters->>'host' is null or l.host=p_filters->>'host')
  and (p_filters->>'level' is null or l.level=p_filters->>'level')
  and (p_filters->>'component' is null or l.component=p_filters->>'component')
  and (p_filters->>'request_id' is null or l.request_id=p_filters->>'request_id')
  and (p_filters->>'client_request_id' is null or l.client_request_id=p_filters->>'client_request_id')
  and (p_filters->>'user_id' is null or l.user_id=(p_filters->>'user_id')::uuid)
  and (p_filters->>'api_key_id' is null or l.api_key_id=(p_filters->>'api_key_id')::uuid)
  and (p_filters->>'account_id' is null or l.account_id=(p_filters->>'account_id')::uuid)
  and (p_filters->>'platform' is null or l.platform=p_filters->>'platform')
  and (p_filters->>'model' is null or l.model=p_filters->>'model')
  and (p_filters->>'q' is null or position(lower(p_filters->>'q') in lower(l.message))>0);
 get diagnostics removed=row_count;
 return jsonb_build_object('deleted',removed);
end $$;
create function public.s2a_log_retention() returns jsonb language plpgsql security definer set search_path='' as $$
declare cfg jsonb; logs bigint; requests bigint:=0;
begin
 select config into cfg from public.s2a_log_runtime where id=true;
 delete from public.s2a_system_logs where id in(select id from public.s2a_system_logs where created_at<now()-make_interval(days=>(cfg->>'retention_days')::integer) order by created_at,id limit 10000);
 get diagnostics logs=row_count;
 if (cfg->>'request_retention_days')::integer>0 then
  delete from public.s2a_usage where id in(select id from public.s2a_usage where created_at<now()-make_interval(days=>(cfg->>'request_retention_days')::integer) order by created_at,id limit 10000);
  get diagnostics requests=row_count;
 end if;
 delete from public.s2a_log_samples where bucket<now()-interval '1 minute';
 return jsonb_build_object('logs_deleted',logs,'requests_deleted',requests);
end $$;
create function public.s2a_log_scheduler_configure(p_enabled boolean default true) returns jsonb language plpgsql security definer set search_path='' as $$
declare job bigint;
begin
 if p_enabled is null then raise exception 'invalid_scheduler_enabled';end if;
 if not exists(select 1 from pg_catalog.pg_extension where extname='pg_cron') then return jsonb_build_object('error','scheduler_extensions_unavailable');end if;
 if not p_enabled then
  execute 'select jobid from cron.job where jobname=$1' into job using 's2a-log-retention';
  if job is not null then execute 'select cron.unschedule($1)' using job;end if;
 else
  execute 'select cron.schedule($1,$2,$3)' into job using 's2a-log-retention','* * * * *','select public.s2a_log_retention();';
 end if;
 return jsonb_build_object('enabled',p_enabled);
end $$;
revoke all on function public.s2a_usage_system_log(),public.s2a_log_retention() from public,anon,authenticated,service_role;
revoke all on function public.s2a_log_config_get(),public.s2a_log_config_set(jsonb),public.s2a_log_write(jsonb),public.s2a_log_health(),public.s2a_log_cleanup(jsonb),public.s2a_log_scheduler_configure(boolean) from public,anon,authenticated;
grant execute on function public.s2a_log_config_get(),public.s2a_log_config_set(jsonb),public.s2a_log_write(jsonb),public.s2a_log_health(),public.s2a_log_cleanup(jsonb),public.s2a_log_scheduler_configure(boolean) to service_role;
notify pgrst,'reload schema';
