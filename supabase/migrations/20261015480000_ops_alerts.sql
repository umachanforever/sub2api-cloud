create table public.s2a_ops_alert_rules (
 id bigint generated always as identity primary key,
 name text not null check(length(trim(name)) between 1 and 100),description text not null default '' check(length(description)<=10000),
 enabled boolean not null default true,severity text not null default 'P2' check(severity in('P0','P1','P2','P3')),
 metric_type text not null check(metric_type in('success_rate','error_rate','upstream_error_rate','cpu_usage_percent','memory_usage_percent','concurrency_queue_depth','group_available_accounts','group_available_ratio','group_rate_limit_ratio','account_rate_limited_count','account_error_count','account_error_ratio','account_temp_unscheduled_count','overload_account_count','proxy_expired_count','proxy_expiring_soon_count')),
 operator text not null check(operator in('>','>=','<','<=','==','!=')),threshold double precision not null check(threshold>=0 and threshold<'Infinity'::float8),
 window_minutes integer not null default 1 check(window_minutes in(1,5,60)),sustained_minutes integer not null default 1 check(sustained_minutes between 1 and 1440),
 cooldown_minutes integer not null default 0 check(cooldown_minutes between 0 and 1440),notify_email boolean not null default true,
 filters jsonb not null default '{}' check(jsonb_typeof(filters)='object'),last_triggered_at timestamptz,
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 check(metric_type not in('success_rate','error_rate','upstream_error_rate','cpu_usage_percent','memory_usage_percent','group_available_ratio','group_rate_limit_ratio','account_error_ratio') or threshold<=100)
);
create table public.s2a_ops_alert_events (
 id bigint generated always as identity primary key,rule_id bigint not null references public.s2a_ops_alert_rules(id) on delete cascade,
 severity text not null check(severity in('P0','P1','P2','P3')),status text not null default 'firing' check(status in('firing','resolved','manual_resolved')),
 title text not null,description text not null default '',metric_value double precision,threshold_value double precision,
 dimensions jsonb not null default '{}',fired_at timestamptz not null default now(),resolved_at timestamptz,
 email_sent boolean not null default false,created_at timestamptz not null default now()
);
create unique index s2a_ops_alert_one_firing on public.s2a_ops_alert_events(rule_id) where status='firing';
create index s2a_ops_alert_event_cursor on public.s2a_ops_alert_events(fired_at desc,id desc);
create table public.s2a_ops_alert_silences (
 id bigint generated always as identity primary key,rule_id bigint not null references public.s2a_ops_alert_rules(id) on delete cascade,
 platform text not null check(platform in('openai','anthropic','gemini')),group_id uuid,region text,
 until timestamptz not null check(isfinite(until)),reason text not null default '' check(length(reason)<=10000),created_by uuid,created_at timestamptz not null default now()
);
create table public.s2a_ops_alert_state (
 rule_id bigint primary key references public.s2a_ops_alert_rules(id) on delete cascade,
 last_evaluated_at timestamptz,consecutive_breaches integer not null default 0
);
alter table public.s2a_ops_alert_rules enable row level security;
alter table public.s2a_ops_alert_events enable row level security;
alter table public.s2a_ops_alert_silences enable row level security;
alter table public.s2a_ops_alert_state enable row level security;
revoke all on public.s2a_ops_alert_rules,public.s2a_ops_alert_events,public.s2a_ops_alert_silences,public.s2a_ops_alert_state from public,anon,authenticated,service_role;
create trigger s2a_ops_alert_rules_audit after insert or update or delete on public.s2a_ops_alert_rules for each row execute function public.s2a_audit_mutation();
create trigger s2a_ops_alert_silences_audit after insert on public.s2a_ops_alert_silences for each row execute function public.s2a_audit_mutation();
create trigger s2a_ops_alert_events_audit after update of status on public.s2a_ops_alert_events for each row execute function public.s2a_audit_mutation();

create function public.s2a_ops_alert_rules_list() returns jsonb language sql stable security definer set search_path='' as $$
 select coalesce(jsonb_agg(to_jsonb(r) order by r.id desc),'[]') from public.s2a_ops_alert_rules r;
$$;
create function public.s2a_ops_alert_rule_save(p_id bigint,p_rule jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.s2a_ops_alert_rules;cfg jsonb;field text;
begin
 if p_rule is null or jsonb_typeof(p_rule)<>'object' or octet_length(p_rule::text)>20000 or exists(select 1 from jsonb_object_keys(p_rule) k where k not in('name','description','enabled','severity','metric_type','operator','threshold','window_minutes','sustained_minutes','cooldown_minutes','notify_email','filters')) then raise exception 'invalid_alert_rule';end if;
 foreach field in array array['name','metric_type','operator'] loop
  if jsonb_typeof(p_rule->field) is distinct from 'string' then raise exception 'invalid_alert_rule';end if;
 end loop;
 if jsonb_typeof(p_rule->'threshold') is distinct from 'number' then raise exception 'invalid_alert_rule';end if;
 foreach field in array array['enabled','notify_email'] loop
  if p_rule?field and jsonb_typeof(p_rule->field) is distinct from 'boolean' then raise exception 'invalid_alert_rule';end if;
 end loop;
 foreach field in array array['description','severity'] loop
  if p_rule?field and jsonb_typeof(p_rule->field) is distinct from 'string' then raise exception 'invalid_alert_rule';end if;
 end loop;
 foreach field in array array['window_minutes','sustained_minutes','cooldown_minutes'] loop
  if p_rule?field and (jsonb_typeof(p_rule->field) is distinct from 'number' or (p_rule->>field)::numeric<>trunc((p_rule->>field)::numeric)) then raise exception 'invalid_alert_rule';end if;
 end loop;
 if p_rule?'filters' then
  cfg:=p_rule->'filters';
  if jsonb_typeof(cfg) is distinct from 'object' or cfg-'platform'-'group_id'-'region'<>'{}' then raise exception 'invalid_alert_scope';end if;
  if cfg?'platform' and (jsonb_typeof(cfg->'platform') is distinct from 'string' or cfg->>'platform' not in('','openai','anthropic','gemini')) then raise exception 'invalid_alert_scope';end if;
  if cfg?'group_id' then perform (cfg->>'group_id')::uuid;if jsonb_typeof(cfg->'group_id') is distinct from 'string' then raise exception 'invalid_alert_scope';end if;end if;
  if cfg?'region' and (jsonb_typeof(cfg->'region') is distinct from 'string' or length(cfg->>'region')>100) then raise exception 'invalid_alert_scope';end if;
 end if;
 if p_id is not null then
  select * into r from public.s2a_ops_alert_rules where id=p_id for update;
  if not found then return jsonb_build_object('error','alert_rule_not_found','status',404);end if;
  cfg:=to_jsonb(r)||p_rule;
 else
  cfg:='{"description":"","enabled":true,"severity":"P2","window_minutes":1,"sustained_minutes":1,"cooldown_minutes":0,"notify_email":true,"filters":{}}'::jsonb||p_rule;
 end if;
 if p_id is null then
  insert into public.s2a_ops_alert_rules(name,description,enabled,severity,metric_type,operator,threshold,window_minutes,sustained_minutes,cooldown_minutes,notify_email,filters)
  values(trim(cfg->>'name'),cfg->>'description',(cfg->>'enabled')::boolean,cfg->>'severity',cfg->>'metric_type',cfg->>'operator',(cfg->>'threshold')::float8,
   (cfg->>'window_minutes')::integer,(cfg->>'sustained_minutes')::integer,(cfg->>'cooldown_minutes')::integer,(cfg->>'notify_email')::boolean,cfg->'filters') returning * into r;
 else
  update public.s2a_ops_alert_rules set name=trim(cfg->>'name'),description=cfg->>'description',enabled=(cfg->>'enabled')::boolean,severity=cfg->>'severity',metric_type=cfg->>'metric_type',operator=cfg->>'operator',threshold=(cfg->>'threshold')::float8,
   window_minutes=(cfg->>'window_minutes')::integer,sustained_minutes=(cfg->>'sustained_minutes')::integer,cooldown_minutes=(cfg->>'cooldown_minutes')::integer,notify_email=(cfg->>'notify_email')::boolean,filters=cfg->'filters',updated_at=now() where id=p_id returning * into r;
  delete from public.s2a_ops_alert_state where rule_id=p_id;
 end if;
 return to_jsonb(r);
end $$;
create function public.s2a_ops_alert_rule_delete(p_id bigint) returns jsonb language plpgsql security definer set search_path='' as $$
begin
 delete from public.s2a_ops_alert_rules where id=p_id;
 if not found then return jsonb_build_object('error','alert_rule_not_found','status',404);end if;
 return '{"deleted":true}';
end $$;
create function public.s2a_ops_alert_event_get(p_id bigint) returns jsonb language sql stable security definer set search_path='' as $$
 select coalesce((select to_jsonb(e) from public.s2a_ops_alert_events e where id=p_id),'{"error":"alert_event_not_found","status":404}');
$$;
create function public.s2a_ops_alert_event_status(p_id bigint,p_status text) returns jsonb language plpgsql security definer set search_path='' as $$
begin
 if p_status is null or p_status not in('resolved','manual_resolved') then raise exception 'invalid_alert_status';end if;
 perform 1 from public.s2a_ops_alert_rules where id=(select rule_id from public.s2a_ops_alert_events where id=p_id) for update;
 update public.s2a_ops_alert_events set status=p_status,resolved_at=coalesce(resolved_at,now()) where id=p_id;
 if not found then return jsonb_build_object('error','alert_event_not_found','status',404);end if;
 return '{"updated":true}';
end $$;
create function public.s2a_ops_alert_events_list(p_filters jsonb default '{}') returns jsonb language plpgsql stable security definer set search_path='' as $$
declare lim integer:=coalesce((p_filters->>'limit')::integer,100);
begin
 if p_filters is null or jsonb_typeof(p_filters)<>'object' or lim not between 1 and 1000 or p_filters-'limit'-'status'-'severity'-'email_sent'-'start_time'-'end_time'-'before_fired_at'-'before_id'-'platform'-'group_id'<>'{}'
 or (p_filters?'before_fired_at')<>(p_filters?'before_id') then raise exception 'invalid_alert_filter';end if;
 if p_filters?'limit' and (jsonb_typeof(p_filters->'limit') is distinct from 'number' or (p_filters->>'limit')::numeric<>trunc((p_filters->>'limit')::numeric)) then raise exception 'invalid_alert_filter';end if;
 if p_filters?'status' and (jsonb_typeof(p_filters->'status') is distinct from 'string' or p_filters->>'status' not in('firing','resolved','manual_resolved'))
 or p_filters?'severity' and (jsonb_typeof(p_filters->'severity') is distinct from 'string' or p_filters->>'severity' not in('P0','P1','P2','P3'))
 or p_filters?'email_sent' and jsonb_typeof(p_filters->'email_sent') is distinct from 'boolean'
 or p_filters?'platform' and (jsonb_typeof(p_filters->'platform') is distinct from 'string' or p_filters->>'platform' not in('','openai','anthropic','gemini')) then raise exception 'invalid_alert_filter';end if;
 if p_filters?'group_id' then perform (p_filters->>'group_id')::uuid;end if;
 if p_filters?'before_id' and (jsonb_typeof(p_filters->'before_id') is distinct from 'number' or (p_filters->>'before_id')::numeric<>trunc((p_filters->>'before_id')::numeric) or (p_filters->>'before_id')::numeric<=0) then raise exception 'invalid_alert_filter';end if;
 if p_filters?'start_time' and not isfinite((p_filters->>'start_time')::timestamptz) or p_filters?'end_time' and not isfinite((p_filters->>'end_time')::timestamptz) or p_filters?'before_fired_at' and not isfinite((p_filters->>'before_fired_at')::timestamptz) then raise exception 'invalid_alert_filter';end if;
 return (select coalesce(jsonb_agg(to_jsonb(e) order by fired_at desc,id desc),'[]') from(
  select * from public.s2a_ops_alert_events where
   (not p_filters?'status' or status=p_filters->>'status') and (not p_filters?'severity' or severity=p_filters->>'severity')
   and (not p_filters?'email_sent' or email_sent=(p_filters->>'email_sent')::boolean)
   and (not p_filters?'start_time' or fired_at>=(p_filters->>'start_time')::timestamptz)
   and (not p_filters?'end_time' or fired_at<(p_filters->>'end_time')::timestamptz)
   and (not p_filters?'before_fired_at' or (fired_at,id)<((p_filters->>'before_fired_at')::timestamptz,(p_filters->>'before_id')::bigint))
   and (coalesce(p_filters->>'platform','')='' or dimensions->>'platform'=p_filters->>'platform')
   and (not p_filters?'group_id' or dimensions->>'group_id'=p_filters->>'group_id')
   order by fired_at desc,id desc limit lim
 ) e);
end $$;
create function public.s2a_ops_alert_silence_create(p_silence jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare s public.s2a_ops_alert_silences;headers jsonb;
begin
 if p_silence is null or jsonb_typeof(p_silence)<>'object' or p_silence-'rule_id'-'platform'-'group_id'-'region'-'until'-'reason'<>'{}'
 or jsonb_typeof(p_silence->'rule_id') is distinct from 'number' or (p_silence->>'rule_id')::numeric<>trunc((p_silence->>'rule_id')::numeric)
 or jsonb_typeof(p_silence->'platform') is distinct from 'string' or jsonb_typeof(p_silence->'until') is distinct from 'string'
 or not isfinite((p_silence->>'until')::timestamptz) or (p_silence->>'until')::timestamptz<=now() then raise exception 'invalid_alert_silence';end if;
 if p_silence?'reason' and jsonb_typeof(p_silence->'reason') is distinct from 'string' or p_silence?'region' and (jsonb_typeof(p_silence->'region') is distinct from 'string' or length(p_silence->>'region')>100) then raise exception 'invalid_alert_silence';end if;
 perform 1 from public.s2a_ops_alert_rules where id=(p_silence->>'rule_id')::bigint for update;
 if not found then return jsonb_build_object('error','alert_rule_not_found','status',404);end if;
 headers:=coalesce(nullif(current_setting('request.headers',true),''),'{}')::jsonb;
 insert into public.s2a_ops_alert_silences(rule_id,platform,group_id,region,until,reason,created_by) values
 ((p_silence->>'rule_id')::bigint,p_silence->>'platform',nullif(p_silence->>'group_id','')::uuid,nullif(p_silence->>'region',''),(p_silence->>'until')::timestamptz,coalesce(p_silence->>'reason',''),nullif(headers->>'x-s2a-actor-id','')::uuid) returning * into s;
 return to_jsonb(s);
end $$;

create function public.s2a_ops_alert_metric(p_rule public.s2a_ops_alert_rules,p_now timestamptz) returns double precision
language plpgsql stable security definer set search_path='' as $$
declare platform text:=coalesce(p_rule.filters->>'platform','');g uuid:=(p_rule.filters->>'group_id')::uuid;data jsonb;total numeric;matched numeric;metric text:=p_rule.metric_type;
begin
 if metric in('cpu_usage_percent','memory_usage_percent','proxy_expired_count','proxy_expiring_soon_count') then
  -- shortcut: system samples and proxy inventory are not connected, evaluate these metrics after their collectors are installed.
  return null;
 end if;
 if metric='concurrency_queue_depth' then return 0;end if;
 if metric in('success_rate','error_rate','upstream_error_rate') then
  data:=public.s2a_ops_dashboard_raw(date_trunc('minute',p_now)-make_interval(mins=>p_rule.window_minutes),date_trunc('minute',p_now),platform,g,60,'overview');
  if (data->>'request_count_sla')::bigint=0 then return null;end if;
  return (data->>case metric when 'success_rate' then 'sla' else metric end)::float8*100;
 end if;
 if metric like 'group_%' and g is null then return null;end if;
 data:=public.s2a_ops_capacity('account-availability',platform,g);
 if metric like 'group_%' then
  data:=coalesce(data->'group'->g::text,'{}');total:=coalesce((data->>'total_accounts')::numeric,0);
  matched:=coalesce((data->>case metric when 'group_rate_limit_ratio' then 'rate_limit_count' else 'available_count' end)::numeric,0);
  return case when metric='group_available_accounts' then matched when total=0 then 0 else matched/total*100 end;
 end if;
 select count(*),count(*) filter(where case metric
  when 'account_rate_limited_count' then (value->>'is_rate_limited')::boolean
  when 'account_error_count' then (value->>'has_error')::boolean and not value?'temp_unschedulable_until'
  when 'account_error_ratio' then (value->>'has_error')::boolean and not value?'temp_unschedulable_until'
  when 'account_temp_unscheduled_count' then (value->>'temp_unschedulable_until')::timestamptz>p_now
  when 'overload_account_count' then (value->>'is_overloaded')::boolean else false end)
 into total,matched from jsonb_each(data->'account');
 return case when metric<>'account_error_ratio' then matched when total=0 then 0 else matched/total*100 end;
end $$;

create function public.s2a_ops_alert_evaluate(p_now timestamptz default now(),p_interval integer default 60) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r public.s2a_ops_alert_rules;s public.s2a_ops_alert_state;v float8;breached boolean;active bigint;fired timestamptz;created integer:=0;resolved integer:=0;evaluated integer:=0;runtime jsonb;deadline timestamptz;
begin
 if p_now is null or not isfinite(p_now) or p_interval is null or p_interval not between 1 and 86400 then raise exception 'invalid_alert_evaluation';end if;
 if not coalesce((select (data->>'ops_monitoring_enabled')::boolean from public.s2a_settings),true) then return '{"skipped":true}';end if;
 runtime:=public.s2a_ops_alert_runtime_get();
 if (runtime->'distributed_lock'->>'enabled')::boolean then
  if not pg_try_advisory_xact_lock(hashtextextended(runtime->'distributed_lock'->>'key',0)) then return '{"skipped":true}';end if;
  deadline:=clock_timestamp()+make_interval(secs=>(runtime->'distributed_lock'->>'ttl_seconds')::integer);
 end if;
 for r in select * from public.s2a_ops_alert_rules where enabled order by id for update loop
  if deadline is not null and clock_timestamp()>=deadline then raise exception 'alert_evaluation_lock_expired';end if;
  insert into public.s2a_ops_alert_state(rule_id) values(r.id) on conflict do nothing;
  select * into s from public.s2a_ops_alert_state where rule_id=r.id for update;
  if s.last_evaluated_at is not null and p_now<s.last_evaluated_at+make_interval(secs=>p_interval) then continue;end if;
  v:=public.s2a_ops_alert_metric(r,p_now);
  if v is null then
   update public.s2a_ops_alert_state set consecutive_breaches=0,last_evaluated_at=p_now where rule_id=r.id;continue;
  end if;
  evaluated:=evaluated+1;
  breached:=case r.operator when '>' then v>r.threshold when '>=' then v>=r.threshold when '<' then v<r.threshold when '<=' then v<=r.threshold when '==' then v=r.threshold else v<>r.threshold end;
  if s.last_evaluated_at is null or p_now-s.last_evaluated_at>make_interval(secs=>p_interval*2) then s.consecutive_breaches:=0;end if;
  s.consecutive_breaches:=case when breached then s.consecutive_breaches+1 else 0 end;
  update public.s2a_ops_alert_state set consecutive_breaches=s.consecutive_breaches,last_evaluated_at=p_now where rule_id=r.id;
  select id into active from public.s2a_ops_alert_events where rule_id=r.id and status='firing';
  if not breached then
   if active is not null then update public.s2a_ops_alert_events set status='resolved',resolved_at=p_now where id=active;resolved:=resolved+1;end if;
   continue;
  end if;
  if active is not null or s.consecutive_breaches<ceil(r.sustained_minutes*60.0/p_interval) then continue;end if;
  if exists(select 1 from public.s2a_ops_alert_silences where rule_id=r.id and until>p_now and platform=coalesce(r.filters->>'platform','')
   and group_id is not distinct from (r.filters->>'group_id')::uuid and region is not distinct from nullif(r.filters->>'region','')) then continue;end if;
  select max(fired_at) into fired from public.s2a_ops_alert_events where rule_id=r.id;
  if fired is not null and p_now<fired+make_interval(mins=>r.cooldown_minutes) then continue;end if;
  insert into public.s2a_ops_alert_events(rule_id,severity,title,description,metric_value,threshold_value,dimensions,fired_at,created_at)
  values(r.id,r.severity,r.severity||': '||r.name,r.metric_type||' '||r.operator||' '||r.threshold::text||' over '||r.window_minutes::text||' minute(s)',v,r.threshold,r.filters,p_now,p_now);
  update public.s2a_ops_alert_rules set last_triggered_at=p_now where id=r.id;created:=created+1;
 end loop;
 if deadline is not null and clock_timestamp()>=deadline then raise exception 'alert_evaluation_lock_expired';end if;
 return jsonb_build_object('evaluated',evaluated,'created',created,'resolved',resolved);
end $$;
revoke all on function public.s2a_ops_alert_metric(public.s2a_ops_alert_rules,timestamptz),public.s2a_ops_alert_evaluate(timestamptz,integer) from public,anon,authenticated,service_role;
revoke all on function public.s2a_ops_alert_rules_list(),public.s2a_ops_alert_rule_save(bigint,jsonb),public.s2a_ops_alert_rule_delete(bigint),public.s2a_ops_alert_event_get(bigint),public.s2a_ops_alert_event_status(bigint,text),public.s2a_ops_alert_events_list(jsonb),public.s2a_ops_alert_silence_create(jsonb) from public,anon,authenticated;
grant execute on function public.s2a_ops_alert_rules_list(),public.s2a_ops_alert_rule_save(bigint,jsonb),public.s2a_ops_alert_rule_delete(bigint),public.s2a_ops_alert_event_get(bigint),public.s2a_ops_alert_event_status(bigint,text),public.s2a_ops_alert_events_list(jsonb),public.s2a_ops_alert_silence_create(jsonb) to service_role;
notify pgrst,'reload schema';

create function public.s2a_ops_alert_runtime_get() returns jsonb language sql stable security definer set search_path='' as $$
 select '{"evaluation_interval_seconds":60,"distributed_lock":{"enabled":true,"key":"ops:alert:evaluator:leader","ttl_seconds":30},"silencing":{"enabled":false,"global_until_rfc3339":"","global_reason":"","entries":[]}}'::jsonb
 ||coalesce(data->'ops_alert_runtime','{}')||jsonb_build_object('thresholds',public.s2a_ops_metric_thresholds_get()) from public.s2a_settings;
$$;
create function public.s2a_ops_alert_scheduler_configure() returns jsonb language plpgsql security definer set search_path='' as $$
declare seconds integer:=(public.s2a_ops_alert_runtime_get()->>'evaluation_interval_seconds')::integer;job bigint;
begin
 if not exists(select 1 from pg_catalog.pg_extension where extname='pg_cron') then raise exception 'scheduler_extensions_unavailable';end if;
 -- shortcut: intervals above one minute run on minute ticks, use an external scheduler when sub-minute precision is required for long intervals.
 execute 'select cron.schedule($1,$2,$3)' into job using 's2a-ops-alert-evaluation',case when seconds<60 then seconds::text||' seconds' else '* * * * *' end,'select public.s2a_ops_alert_tick();';
 return jsonb_build_object('enabled',true,'evaluation_interval_seconds',seconds);
end $$;
create function public.s2a_ops_alert_runtime_set(p_config jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare lock_cfg jsonb;silence jsonb;entry jsonb;field text;n numeric;v text;
begin
 if p_config is null or jsonb_typeof(p_config)<>'object' or octet_length(p_config::text)>100000 or p_config-'evaluation_interval_seconds'-'distributed_lock'-'silencing'-'thresholds'<>'{}' then raise exception 'invalid_alert_runtime';end if;
 lock_cfg:=p_config->'distributed_lock';silence:=p_config->'silencing';
 if jsonb_typeof(lock_cfg) is distinct from 'object' or lock_cfg-'enabled'-'key'-'ttl_seconds'<>'{}' or jsonb_typeof(lock_cfg->'enabled') is distinct from 'boolean'
 or jsonb_typeof(lock_cfg->'key') is distinct from 'string' or length(trim(lock_cfg->>'key')) not between 1 and 200
 or jsonb_typeof(silence) is distinct from 'object' or silence-'enabled'-'global_until_rfc3339'-'global_reason'-'entries'<>'{}' or jsonb_typeof(silence->'enabled') is distinct from 'boolean'
 or jsonb_typeof(silence->'global_reason') is distinct from 'string' or length(silence->>'global_reason')>10000 or jsonb_typeof(silence->'entries') is distinct from 'array' or jsonb_array_length(silence->'entries')>1000 then raise exception 'invalid_alert_runtime';end if;
 foreach field in array array['evaluation_interval_seconds','ttl_seconds'] loop
  if jsonb_typeof(case field when 'ttl_seconds' then lock_cfg->field else p_config->field end) is distinct from 'number' then raise exception 'invalid_alert_runtime';end if;
  n:=(case field when 'ttl_seconds' then lock_cfg->>field else p_config->>field end)::numeric;
  if n<>trunc(n) or n not between 1 and 86400 then raise exception 'invalid_alert_runtime';end if;
 end loop;
 v:=silence->>'global_until_rfc3339';
 if jsonb_typeof(silence->'global_until_rfc3339') is distinct from 'string' or (v<>'' and (v !~ '^\d{4}-\d{2}-\d{2}T' or not isfinite(v::timestamptz))) then raise exception 'invalid_alert_runtime';end if;
 for entry in select value from jsonb_array_elements(silence->'entries') loop
  if jsonb_typeof(entry)<>'object' or entry-'rule_id'-'severities'-'until_rfc3339'-'reason'<>'{}'
  or jsonb_typeof(entry->'until_rfc3339') is distinct from 'string' or coalesce(entry->>'until_rfc3339','') !~ '^\d{4}-\d{2}-\d{2}T' or not isfinite((entry->>'until_rfc3339')::timestamptz)
  or jsonb_typeof(entry->'reason') is distinct from 'string' or length(entry->>'reason')>10000
  or jsonb_typeof(entry->'severities') is distinct from 'array' then raise exception 'invalid_alert_runtime';end if;
  if entry?'rule_id' and (jsonb_typeof(entry->'rule_id') is distinct from 'number' or (entry->>'rule_id')::numeric<=0 or (entry->>'rule_id')::numeric<>trunc((entry->>'rule_id')::numeric)) then raise exception 'invalid_alert_runtime';end if;
  if exists(select 1 from jsonb_array_elements(entry->'severities') x where jsonb_typeof(x)<>'string' or x#>>'{}' not in('P0','P1','P2','P3')) then raise exception 'invalid_alert_runtime';end if;
 end loop;
 update public.s2a_settings set data=data||jsonb_build_object('ops_alert_runtime',p_config-'thresholds'),updated_at=now() where id='11111111-0000-4000-8000-000000000001';
 -- Thresholds are saved through their dedicated route; the console sends a stale snapshot with runtime settings.
 if exists(select 1 from pg_catalog.pg_extension where extname='pg_cron') then perform public.s2a_ops_alert_scheduler_configure();end if;
 return public.s2a_ops_alert_runtime_get();
end $$;
create function public.s2a_ops_alert_tick() returns jsonb language sql security definer set search_path='' as $$
 select public.s2a_ops_alert_evaluate(now(),(public.s2a_ops_alert_runtime_get()->>'evaluation_interval_seconds')::integer);
$$;
revoke all on function public.s2a_ops_alert_runtime_get(),public.s2a_ops_alert_runtime_set(jsonb),public.s2a_ops_alert_scheduler_configure(),public.s2a_ops_alert_tick() from public,anon,authenticated,service_role;
grant execute on function public.s2a_ops_alert_runtime_get(),public.s2a_ops_alert_runtime_set(jsonb),public.s2a_ops_alert_scheduler_configure() to service_role;
notify pgrst,'reload schema';
