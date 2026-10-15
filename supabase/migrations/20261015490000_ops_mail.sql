create function public.s2a_ops_email_get() returns jsonb language sql stable security definer set search_path='' as $$
 select '{"alert":{"enabled":true,"recipients":[],"min_severity":"","rate_limit_per_hour":0,"batching_window_seconds":0,"include_resolved_alerts":false},"report":{"enabled":false,"recipients":[],"daily_summary_enabled":false,"daily_summary_schedule":"0 9 * * *","weekly_summary_enabled":false,"weekly_summary_schedule":"0 9 * * 1","error_digest_enabled":false,"error_digest_schedule":"0 9 * * *","error_digest_min_count":10,"account_health_enabled":false,"account_health_schedule":"0 9 * * *","account_health_error_rate_threshold":10}}'::jsonb
 ||coalesce(data->'ops_email_config','{}') from public.s2a_settings;
$$;
create table public.s2a_ops_mail_delivery (
 id uuid primary key default gen_random_uuid(),recipient text not null,kind text not null check(kind in('alert','report')),payload jsonb not null,
 attempts integer not null default 0,status text not null default 'pending' check(status in('pending','sending','sent','failed')),
 ready_at timestamptz not null default now(),first_attempt_at timestamptz,lease_id uuid,lease_until timestamptz,last_error text,created_at timestamptz not null default now(),sent_at timestamptz
);
create table public.s2a_ops_mail_queue (
 id uuid primary key default gen_random_uuid(),dedup_key text not null,recipient text not null,kind text not null check(kind in('alert','report')),
 event_id bigint,transition text,report_type text,payload jsonb not null,ready_at timestamptz not null,created_at timestamptz not null default now(),
 delivery_id uuid references public.s2a_ops_mail_delivery(id),unique(dedup_key,recipient)
);
create table public.s2a_ops_mail_attempts(id uuid primary key default gen_random_uuid(),created_at timestamptz not null default now());
create index s2a_ops_mail_due on public.s2a_ops_mail_delivery(ready_at) where status in('pending','sending');
create index s2a_ops_mail_queue_due on public.s2a_ops_mail_queue(ready_at) where delivery_id is null;
alter table public.s2a_ops_mail_delivery enable row level security;
alter table public.s2a_ops_mail_queue enable row level security;
alter table public.s2a_ops_mail_attempts enable row level security;
revoke all on public.s2a_ops_mail_delivery,public.s2a_ops_mail_queue,public.s2a_ops_mail_attempts from public,anon,authenticated,service_role;

create function public.s2a_ops_mail_alert_allowed(p_event bigint,p_transition text) returns boolean language plpgsql stable security definer set search_path='' as $$
declare e public.s2a_ops_alert_events;r public.s2a_ops_alert_rules;cfg jsonb:=public.s2a_ops_email_get()->'alert';silence jsonb:=public.s2a_ops_alert_runtime_get()->'silencing';entry jsonb;rank integer;minimum integer;
begin
 if not (cfg->>'enabled')::boolean then return false;end if;
 select * into e from public.s2a_ops_alert_events where id=p_event;if not found then return false;end if;
 select * into r from public.s2a_ops_alert_rules where id=e.rule_id;
 if not found or not r.notify_email or p_transition<>'firing' and not (cfg->>'include_resolved_alerts')::boolean then return false;end if;
 rank:=case e.severity when 'P0' then 3 when 'P1' then 2 else 1 end;
 minimum:=case cfg->>'min_severity' when 'critical' then 3 when 'warning' then 2 else 1 end;
 if rank<minimum then return false;end if;
 if (silence->>'enabled')::boolean then
  if nullif(silence->>'global_until_rfc3339','')::timestamptz>now() then return false;end if;
  for entry in select value from jsonb_array_elements(silence->'entries') loop
   if (entry->>'until_rfc3339')::timestamptz>=now() and (not entry?'rule_id' or (entry->>'rule_id')::bigint=r.id)
    and (jsonb_array_length(entry->'severities')=0 or entry->'severities'?e.severity) then return false;end if;
  end loop;
 end if;
 return true;
end $$;
create function public.s2a_ops_mail_alert_enqueue() returns trigger language plpgsql security definer set search_path='' as $$
declare cfg jsonb;transition text;recipient text;
begin
 transition:=case when new.status='firing' then 'firing' else 'resolved' end;
 if tg_op='UPDATE' and (old.status=new.status or old.status<>'firing') then return new;end if;
 if not public.s2a_ops_mail_alert_allowed(new.id,transition) then return new;end if;
 cfg:=public.s2a_ops_email_get()->'alert';
 for recipient in select value from jsonb_array_elements_text(cfg->'recipients') loop
  insert into public.s2a_ops_mail_queue(dedup_key,recipient,kind,event_id,transition,payload,ready_at)
  values(new.id::text||':'||transition,recipient,'alert',new.id,transition,to_jsonb(new)-'email_sent',now()+make_interval(secs=>(cfg->>'batching_window_seconds')::integer)) on conflict do nothing;
 end loop;
 return new;
end $$;
create trigger s2a_ops_mail_alert_enqueue after insert or update of status on public.s2a_ops_alert_events for each row execute function public.s2a_ops_mail_alert_enqueue();

create function public.s2a_ops_mail_report_enqueue(p_type text) returns jsonb language plpgsql security definer set search_path='' as $$
declare cfg jsonb:=public.s2a_ops_email_get()->'report';payload jsonb;recipient text;hours integer:=24;count bigint;availability jsonb;total bigint;errors bigint;
begin
 if p_type is null or p_type not in('daily_summary','weekly_summary','error_digest','account_health') then raise exception 'invalid_report_type';end if;
 if not (cfg->>'enabled')::boolean or not (cfg->>(p_type||'_enabled'))::boolean or not coalesce((select (data->>'ops_monitoring_enabled')::boolean from public.s2a_settings),true) then return '{"skipped":true}';end if;
 if p_type='weekly_summary' then hours:=168;end if;
 payload:=jsonb_build_object('report_type',p_type,'generated_at',now(),'overview',public.s2a_ops_dashboard(now()-make_interval(hours=>hours),now(),'',null,60,'overview','auto'));
 if p_type='error_digest' then
  select count(*) into count from public.s2a_ops_errors where created_at>=now()-interval '24 hours';
  if count<(cfg->>'error_digest_min_count')::bigint then return '{"skipped":true}';end if;
  payload:=payload||jsonb_build_object('error_count',count,'errors',(select coalesce(jsonb_agg(x),'[]') from (select type,phase,status_code,count(*) count from public.s2a_ops_errors where created_at>=now()-interval '24 hours' group by type,phase,status_code order by count(*) desc limit 100) x));
 elsif p_type='account_health' then
  availability:=public.s2a_ops_capacity('account-availability');
  select count(*),count(*) filter(where (value->>'has_error')::boolean) into total,errors from jsonb_each(availability->'account');
  payload:=payload||jsonb_build_object('error_rate_threshold',(cfg->>'account_health_error_rate_threshold')::numeric,
   'accounts_above_threshold',(select coalesce(jsonb_agg(x),'[]') from(
    select r.account_id,max(a.name) account_name,count(*) requests,count(*) filter(where r.kind='error') errors,round(count(*) filter(where r.kind='error')*100.0/count(*),2) error_rate
    from public.s2a_ops_requests r left join public.s2a_accounts a on a.id=r.account_id left join public.s2a_ops_errors e on e.id=r.error_id
    where r.account_id is not null and r.created_at>=now()-interval '24 hours' and not coalesce(e.is_business_limited,false)
    group by r.account_id having count(*) filter(where r.kind='error')*100.0/count(*)>=(cfg->>'account_health_error_rate_threshold')::numeric
    order by count(*) filter(where r.kind='error') desc,r.account_id limit 100
   ) x));
  payload:=payload||jsonb_build_object('total_accounts',total,'error_accounts',errors,'platforms',availability->'platform','groups',availability->'group');
 end if;
 for recipient in select value from jsonb_array_elements_text(cfg->'recipients') loop
  insert into public.s2a_ops_mail_queue(dedup_key,recipient,kind,report_type,payload,ready_at)
  values(p_type||':'||date_trunc('minute',now())::text,recipient,'report',p_type,payload,now()) on conflict do nothing;
 end loop;
 return '{"queued":true}';
end $$;

create function public.s2a_ops_email_scheduler_configure() returns jsonb language plpgsql security definer set search_path='' as $$
declare cfg jsonb:=public.s2a_ops_email_get()->'report';kind text;job bigint;
begin
 if not exists(select 1 from pg_catalog.pg_extension where extname='pg_cron') then
  if (cfg->>'enabled')::boolean then raise exception 'scheduler_extensions_unavailable';end if;return '{"enabled":false}';
 end if;
 foreach kind in array array['daily_summary','weekly_summary','error_digest','account_health'] loop
  if (cfg->>'enabled')::boolean and (cfg->>(kind||'_enabled'))::boolean then
   execute 'select cron.schedule($1,$2,$3)' into job using 's2a-ops-'||kind,cfg->>(kind||'_schedule'),format('select public.s2a_ops_mail_report_enqueue(%L);',kind);
  else
   execute 'select jobid from cron.job where jobname=$1' into job using 's2a-ops-'||kind;
   if job is not null then execute 'select cron.unschedule($1)' using job;end if;
  end if;
 end loop;
 if exists(select 1 from pg_catalog.pg_extension where extname='pg_net') then
  execute 'select cron.schedule($1,$2,$3)' into job using 's2a-ops-mail-delivery','* * * * *','select public.s2a_ops_mail_dispatch();';
 end if;
 return jsonb_build_object('enabled',(cfg->>'enabled')::boolean);
end $$;
create function public.s2a_ops_email_set(p_config jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare cfg jsonb:=public.s2a_ops_email_get();section text;entry record;value numeric;report jsonb;recipient jsonb;
begin
 if p_config is null or jsonb_typeof(p_config)<>'object' or octet_length(p_config::text)>100000 or p_config-'alert'-'report'<>'{}' then raise exception 'invalid_email_config';end if;
 foreach section in array array['alert','report'] loop
  if not p_config?section then continue;end if;
  if jsonb_typeof(p_config->section)<>'object' then raise exception 'invalid_email_config';end if;
  for entry in select * from jsonb_each(p_config->section) loop
   if not (cfg->section)?entry.key then raise exception 'invalid_email_config';end if;
   if entry.key='recipients' then
    if jsonb_typeof(entry.value) is distinct from 'array' or jsonb_array_length(entry.value)>100 then raise exception 'invalid_email_config';end if;
    for recipient in select x from jsonb_array_elements(entry.value) x loop
     if jsonb_typeof(recipient)<>'string' or length(recipient#>>'{}')>254 or recipient#>>'{}' !~ '^[^[:space:]@<>]+@[^[:space:]@<>]+\.[^[:space:]@<>]+$' then raise exception 'invalid_email_recipients';end if;
    end loop;
   elsif entry.key='min_severity' then
    if jsonb_typeof(entry.value) is distinct from 'string' or entry.value#>>'{}' not in('','critical','warning','info') then raise exception 'invalid_email_config';end if;
   elsif entry.key like '%_schedule' then
    if jsonb_typeof(entry.value) is distinct from 'string' or not public.s2a_ops_valid_cleanup_schedule(entry.value#>>'{}') then raise exception 'invalid_email_config';end if;
   elsif entry.key in('rate_limit_per_hour','batching_window_seconds','error_digest_min_count','account_health_error_rate_threshold') then
    if jsonb_typeof(entry.value) is distinct from 'number' then raise exception 'invalid_email_config';end if;
    value:=(entry.value#>>'{}')::numeric;
    if value<0 or value>(case when entry.key='account_health_error_rate_threshold' then 100 else 2147483647 end) or entry.key<>'account_health_error_rate_threshold' and value<>trunc(value) then raise exception 'invalid_email_config';end if;
   elsif jsonb_typeof(entry.value) is distinct from 'boolean' then raise exception 'invalid_email_config';end if;
  end loop;
  cfg:=jsonb_set(cfg,array[section],(cfg->section)||(p_config->section));
 end loop;
 update public.s2a_settings set data=data||jsonb_build_object('ops_email_config',cfg),updated_at=now() where id='11111111-0000-4000-8000-000000000001';
 perform public.s2a_ops_email_scheduler_configure();
 return cfg;
end $$;

create function public.s2a_ops_mail_claim() returns jsonb language plpgsql security definer set search_path='' as $$
declare cfg jsonb:=public.s2a_ops_email_get();d public.s2a_ops_mail_delivery;q record;ids uuid[];payload jsonb;result jsonb:='[]';cap integer:=(cfg->'alert'->>'rate_limit_per_hour')::integer;reserved bigint;
begin
 if not coalesce((select (data->>'ops_monitoring_enabled')::boolean from public.s2a_settings),true) then return result;end if;
 if not pg_try_advisory_xact_lock(hashtextextended('s2a-ops-mail-dispatch',0)) then return result;end if;
 delete from public.s2a_ops_mail_attempts where created_at<now()-interval '1 hour';
 update public.s2a_ops_mail_delivery set status='failed',last_error='delivery_window_expired',lease_id=null,lease_until=null where status in('pending','sending') and first_attempt_at<now()-interval '23 hours' and (lease_until is null or lease_until<=now());
 for q in select recipient,kind from public.s2a_ops_mail_queue where delivery_id is null and ready_at<=now() and case when kind='alert' then public.s2a_ops_mail_alert_allowed(event_id,transition) and cfg->'alert'->'recipients'?recipient else (cfg->'report'->>'enabled')::boolean and (cfg->'report'->>(report_type||'_enabled'))::boolean and cfg->'report'->'recipients'?recipient end group by recipient,kind order by min(ready_at) limit 4 loop
  select array_agg(id),jsonb_agg(eligible.payload order by eligible.created_at,eligible.id) into ids,payload from(
   select * from public.s2a_ops_mail_queue where recipient=q.recipient and kind=q.kind and delivery_id is null
   and case when kind='alert' then public.s2a_ops_mail_alert_allowed(event_id,transition) and cfg->'alert'->'recipients'?recipient
   else (cfg->'report'->>'enabled')::boolean and (cfg->'report'->>(report_type||'_enabled'))::boolean and cfg->'report'->'recipients'?recipient end
   order by created_at,id limit 100
  ) eligible;
  if ids is null then continue;end if;
  insert into public.s2a_ops_mail_delivery(recipient,kind,payload) values(q.recipient,q.kind,payload) returning * into d;
  update public.s2a_ops_mail_queue set delivery_id=d.id where id=any(ids);
 end loop;
 select count(*) into reserved from public.s2a_ops_mail_attempts;
 for d in select * from public.s2a_ops_mail_delivery where status in('pending','sending') and ready_at<=now() and (lease_until is null or lease_until<=now()) and attempts<8 and case when kind='alert' then (cfg->'alert'->>'enabled')::boolean and cfg->'alert'->'recipients'?recipient and not exists(select 1 from public.s2a_ops_mail_queue item where item.delivery_id=s2a_ops_mail_delivery.id and not public.s2a_ops_mail_alert_allowed(item.event_id,item.transition)) else (cfg->'report'->>'enabled')::boolean and cfg->'report'->'recipients'?recipient and not exists(select 1 from public.s2a_ops_mail_queue item where item.delivery_id=s2a_ops_mail_delivery.id and not (cfg->'report'->>(item.report_type||'_enabled'))::boolean) end order by ready_at,id limit 4 for update skip locked loop
  if d.kind='alert' then
   if cap>0 and reserved>=cap then continue;end if;
   if not (cfg->'alert'->>'enabled')::boolean or not cfg->'alert'->'recipients'?d.recipient or exists(select 1 from public.s2a_ops_mail_queue where delivery_id=d.id and not public.s2a_ops_mail_alert_allowed(event_id,transition)) then continue;end if;
   insert into public.s2a_ops_mail_attempts default values;reserved:=reserved+1;
  elsif not (cfg->'report'->>'enabled')::boolean or not cfg->'report'->'recipients'?d.recipient then continue;end if;
  update public.s2a_ops_mail_delivery set status='sending',lease_id=gen_random_uuid(),lease_until=now()+interval '120 seconds',attempts=attempts+1,first_attempt_at=coalesce(first_attempt_at,now()) where id=d.id returning * into d;
  result:=result||jsonb_build_array(jsonb_build_object('id',d.id,'lease_id',d.lease_id,'recipient',d.recipient,'payload',d.payload));
 end loop;
 return result;
end $$;
create function public.s2a_ops_mail_finish(p_id uuid,p_lease uuid,p_error text default null) returns boolean language plpgsql security definer set search_path='' as $$
declare d public.s2a_ops_mail_delivery;
begin
 if p_error is not null and p_error<>'delivery_failed' then raise exception 'invalid_delivery_error';end if;
 select * into d from public.s2a_ops_mail_delivery where id=p_id and lease_id=p_lease and lease_until>now() and status='sending' for update;
 if not found then return false;end if;
 if p_error is null then
  update public.s2a_ops_mail_delivery set status='sent',sent_at=now(),last_error=null,lease_id=null,lease_until=null where id=p_id;
  update public.s2a_ops_alert_events set email_sent=true where id in(select event_id from public.s2a_ops_mail_queue where delivery_id=p_id and kind='alert');
 else
  update public.s2a_ops_mail_delivery set status=case when attempts>=8 then 'failed' else 'pending' end,last_error=p_error,lease_id=null,lease_until=null,ready_at=now()+make_interval(secs=>least(21600,60*power(2,least(attempts-1,9))::integer)) where id=p_id;
 end if;
 return true;
end $$;
revoke all on function public.s2a_ops_mail_alert_allowed(bigint,text),public.s2a_ops_mail_alert_enqueue(),public.s2a_ops_mail_report_enqueue(text) from public,anon,authenticated,service_role;
revoke all on function public.s2a_ops_email_get(),public.s2a_ops_email_set(jsonb),public.s2a_ops_email_scheduler_configure(),public.s2a_ops_mail_claim(),public.s2a_ops_mail_finish(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.s2a_ops_email_get(),public.s2a_ops_email_set(jsonb),public.s2a_ops_email_scheduler_configure(),public.s2a_ops_mail_claim(),public.s2a_ops_mail_finish(uuid,uuid,text) to service_role;
notify pgrst,'reload schema';

create function public.s2a_ops_mail_dispatch() returns bigint language plpgsql security definer set search_path='' as $$
declare config public.s2a_privacy_scheduler;key text;ticket text;signature text;crypto_schema text;request_id bigint;
begin
 if not exists(select 1 from public.s2a_ops_mail_queue where delivery_id is null and ready_at<=now()) and not exists(select 1 from public.s2a_ops_mail_delivery where status in('pending','sending') and ready_at<=now() and (lease_until is null or lease_until<=now())) then return null;end if;
 select * into config from public.s2a_privacy_scheduler;if not found then return null;end if;
 execute 'select decrypted_secret from vault.decrypted_secrets where id=$1' into key using config.secret_id;if key is null then return null;end if;
 ticket:=(floor(extract(epoch from clock_timestamp()))::bigint+90)::text||':'||gen_random_uuid()::text;
 select n.nspname into crypto_schema from pg_catalog.pg_extension e join pg_catalog.pg_namespace n on n.oid=e.extnamespace where e.extname='pgcrypto';
 execute format('select encode(%I.hmac($1,$2,''sha256''),''hex'')',crypto_schema) into signature using 's2a-mail:'||ticket,key;
 execute 'select net.http_post(url:=$1,headers:=$2,body:=$3,timeout_milliseconds:=45000)' into request_id using regexp_replace(config.endpoint,'/privacy$','/mail'),jsonb_build_object('Content-Type','application/json','x-s2a-mail-job-token',ticket||':'||signature),'{}'::jsonb;
 return request_id;
end $$;
revoke all on function public.s2a_ops_mail_dispatch() from public,anon,authenticated,service_role;
notify pgrst,'reload schema';
