create function public.s2a_ops_advanced_get() returns jsonb language sql stable security definer set search_path='' as $$
 select '{"data_retention":{"cleanup_enabled":true,"cleanup_schedule":"0 2 * * *","error_log_retention_days":30,"minute_metrics_retention_days":30,"hourly_metrics_retention_days":30},"aggregation":{"aggregation_enabled":false},"ignore_count_tokens_errors":true,"ignore_context_canceled":true,"ignore_no_available_accounts":false,"ignore_invalid_api_key_errors":true,"ignore_insufficient_balance_errors":false,"display_openai_token_stats":false,"display_alert_events":true,"auto_refresh_enabled":false,"auto_refresh_interval_seconds":30}'::jsonb
 ||coalesce(data->'ops_advanced_settings','{}')||jsonb_build_object('ignore_invalid_api_key_errors',true,
 'openai_account_quota_auto_pause',coalesce(data->'openai_account_quota_auto_pause','{"default_threshold_5h":0,"default_threshold_7d":0}')) from public.s2a_settings;
$$;

create table public.s2a_ops_aggregation_cursor(id boolean primary key default true check(id),backfill_next timestamptz);
insert into public.s2a_ops_aggregation_cursor(id) values(true);
alter table public.s2a_ops_aggregation_cursor enable row level security;
revoke all on public.s2a_ops_aggregation_cursor from public,anon,authenticated,service_role;

create function public.s2a_ops_aggregation_tick() returns jsonb language plpgsql security definer set search_path='' as $$
declare cursor_at timestamptz;end_at timestamptz;live jsonb;backfill jsonb;
begin
 if not (public.s2a_ops_advanced_get()->'aggregation'->>'aggregation_enabled')::boolean then return jsonb_build_object('skipped',true);end if;
 if not pg_try_advisory_xact_lock(hashtextextended('s2a-ops-aggregation',0)) then return jsonb_build_object('skipped',true);end if;
 live:=public.s2a_ops_aggregate();
 select backfill_next into cursor_at from public.s2a_ops_aggregation_cursor where id for update;
 end_at:=date_bin(interval '1 hour',now()-interval '2 hours','1970-01-01'::timestamptz);
 if cursor_at is not null and cursor_at<end_at then
  cursor_at:=greatest(cursor_at,date_bin(interval '1 hour',now()-interval '31 days','1970-01-01'::timestamptz));
  backfill:=public.s2a_ops_aggregate(cursor_at,least(cursor_at+interval '1 day',end_at));
  update public.s2a_ops_aggregation_cursor set backfill_next=least(cursor_at+interval '1 day',end_at) where id;
 end if;
 return jsonb_build_object('live',live,'backfill',backfill);
end $$;

create function public.s2a_ops_cleanup() returns jsonb language plpgsql security definer set search_path='' as $$
declare cfg jsonb;errors bigint:=0;minutes bigint:=0;hours bigint:=0;removed bigint;cutoff timestamptz:=clock_timestamp();
begin
 cfg:=public.s2a_ops_advanced_get()->'data_retention';
 if not (cfg->>'cleanup_enabled')::boolean then return jsonb_build_object('skipped',true);end if;
 if not pg_try_advisory_xact_lock(hashtextextended('s2a-ops-aggregation',0)) then return jsonb_build_object('skipped',true);end if;
 loop
  delete from public.s2a_ops_errors where id in(select id from public.s2a_ops_errors where created_at<cutoff-make_interval(days=>(cfg->>'error_log_retention_days')::integer) order by created_at,id limit 10000);
  get diagnostics removed=row_count;errors:=errors+removed;exit when removed<10000;
 end loop;
 loop
 delete from public.s2a_ops_metrics where (bucket_start,resolution,platform,coalesce(group_id,'00000000-0000-0000-0000-000000000000')) in(
  select bucket_start,resolution,platform,coalesce(group_id,'00000000-0000-0000-0000-000000000000') from public.s2a_ops_metrics where resolution=60
  and bucket_start<cutoff-make_interval(days=>(cfg->>'minute_metrics_retention_days')::integer) order by bucket_start limit 10000);
 get diagnostics removed=row_count;minutes:=minutes+removed;exit when removed<10000;
 end loop;
 loop
 delete from public.s2a_ops_metrics where (bucket_start,resolution,platform,coalesce(group_id,'00000000-0000-0000-0000-000000000000')) in(
  select bucket_start,resolution,platform,coalesce(group_id,'00000000-0000-0000-0000-000000000000') from public.s2a_ops_metrics where resolution=3600
  and bucket_start<cutoff-make_interval(days=>(cfg->>'hourly_metrics_retention_days')::integer) order by bucket_start limit 10000);
 get diagnostics removed=row_count;hours:=hours+removed;exit when removed<10000;
 end loop;
 return jsonb_build_object('errors_deleted',errors,'minute_metrics_deleted',minutes,'hourly_metrics_deleted',hours);
end $$;

create or replace function public.s2a_log_retention() returns jsonb language sql security definer set search_path='' as $$
 select public.s2a_log_retention_without_ops_errors();
$$;

create function public.s2a_ops_scheduler_configure() returns jsonb language plpgsql security definer set search_path='' as $$
declare cfg jsonb;job bigint;enabled boolean;name text;
begin
 cfg:=public.s2a_ops_advanced_get();
 if not exists(select 1 from pg_catalog.pg_extension where extname='pg_cron') then
  if (cfg->'data_retention'->>'cleanup_enabled')::boolean or (cfg->'aggregation'->>'aggregation_enabled')::boolean then raise exception 'scheduler_extensions_unavailable';end if;
  return jsonb_build_object('cleanup_enabled',false,'aggregation_enabled',false);
 end if;
 foreach name in array array['s2a-ops-retention','s2a-ops-aggregation'] loop
  enabled:=case name when 's2a-ops-retention' then (cfg->'data_retention'->>'cleanup_enabled')::boolean else (cfg->'aggregation'->>'aggregation_enabled')::boolean end;
  if enabled then
   execute 'select cron.schedule($1,$2,$3)' into job using name,
    case name when 's2a-ops-retention' then cfg->'data_retention'->>'cleanup_schedule' else '*/5 * * * *' end,
    case name when 's2a-ops-retention' then 'select public.s2a_ops_cleanup();' else 'select public.s2a_ops_aggregation_tick();' end;
  else
   execute 'select jobid from cron.job where jobname=$1' into job using name;
   if job is not null then execute 'select cron.unschedule($1)' using job;end if;
  end if;
 end loop;
 return jsonb_build_object('cleanup_enabled',(cfg->'data_retention'->>'cleanup_enabled')::boolean,'aggregation_enabled',(cfg->'aggregation'->>'aggregation_enabled')::boolean);
end $$;

create function public.s2a_ops_valid_cleanup_schedule(p_schedule text) returns boolean language plpgsql immutable set search_path='' as $$
declare fields text[];segment text;base text;numbers text[];i integer;maxima integer[]:=array[59,23,31,12,7];minimum integer;
begin
 if p_schedule is null or length(p_schedule)>100 then return false;end if;
 fields:=regexp_split_to_array(trim(p_schedule),'[[:space:]]+');if array_length(fields,1)<>5 then return false;end if;
 for i in 1..5 loop
  minimum:=case when i in(3,4) then 1 else 0 end;
  foreach segment in array string_to_array(fields[i],',') loop
   if segment !~ '^(\*|[0-9]+(-[0-9]+)?)(/[0-9]+)?$' then return false;end if;
   base:=split_part(segment,'/',1);
   if base<>'*' then
    numbers:=string_to_array(base,'-');
    if numbers[1]::numeric not between minimum and maxima[i] or (array_length(numbers,1)=2 and (numbers[2]::numeric not between minimum and maxima[i] or numbers[1]::numeric>numbers[2]::numeric)) then return false;end if;
   end if;
   if strpos(segment,'/')>0 and split_part(segment,'/',2)::numeric not between 1 and maxima[i]+1 then return false;end if;
  end loop;
 end loop;
 return true;
end $$;

create function public.s2a_ops_advanced_set(p_config jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare field text;old jsonb;cfg jsonb;retention jsonb;quota jsonb;v numeric;
begin
 if p_config is null or jsonb_typeof(p_config)<>'object' or exists(select 1 from jsonb_object_keys(p_config) k where k not in
 ('data_retention','aggregation','openai_account_quota_auto_pause','ignore_count_tokens_errors','ignore_context_canceled','ignore_no_available_accounts','ignore_invalid_api_key_errors','ignore_insufficient_balance_errors','display_openai_token_stats','display_alert_events','auto_refresh_enabled','auto_refresh_interval_seconds')) then raise exception 'invalid_advanced_settings';end if;
 foreach field in array array['ignore_count_tokens_errors','ignore_context_canceled','ignore_no_available_accounts','ignore_invalid_api_key_errors','ignore_insufficient_balance_errors','display_openai_token_stats','display_alert_events','auto_refresh_enabled'] loop
  if jsonb_typeof(p_config->field) is distinct from 'boolean' then raise exception 'invalid_advanced_settings';end if;
 end loop;
 retention:=p_config->'data_retention';quota:=p_config->'openai_account_quota_auto_pause';
 if jsonb_typeof(retention) is distinct from 'object' or exists(select 1 from jsonb_object_keys(retention) k where k not in('cleanup_enabled','cleanup_schedule','error_log_retention_days','minute_metrics_retention_days','hourly_metrics_retention_days'))
 or jsonb_typeof(retention->'cleanup_enabled') is distinct from 'boolean' or jsonb_typeof(retention->'cleanup_schedule') is distinct from 'string'
 or not public.s2a_ops_valid_cleanup_schedule(retention->>'cleanup_schedule')
 or jsonb_typeof(p_config->'aggregation') is distinct from 'object' or (p_config->'aggregation')-'aggregation_enabled'<>'{}'
 or jsonb_typeof(p_config->'aggregation'->'aggregation_enabled') is distinct from 'boolean'
 or jsonb_typeof(quota) is distinct from 'object' or quota-'default_threshold_5h'-'default_threshold_7d'<>'{}' then raise exception 'invalid_advanced_settings';end if;
 foreach field in array array['error_log_retention_days','minute_metrics_retention_days','hourly_metrics_retention_days'] loop
  if jsonb_typeof(retention->field) is distinct from 'number' then raise exception 'invalid_advanced_settings';end if;
  v:=(retention->>field)::numeric;if v<0 or v>365 or v<>trunc(v) then raise exception 'invalid_advanced_settings';end if;
 end loop;
 foreach field in array array['default_threshold_5h','default_threshold_7d'] loop
  if jsonb_typeof(quota->field) is distinct from 'number' or (quota->>field)::numeric not between 0 and 1 then raise exception 'invalid_advanced_settings';end if;
 end loop;
 if jsonb_typeof(p_config->'auto_refresh_interval_seconds') is distinct from 'number' then raise exception 'invalid_advanced_settings';end if;
 v:=(p_config->>'auto_refresh_interval_seconds')::numeric;if v<15 or v>300 or v<>trunc(v) then raise exception 'invalid_advanced_settings';end if;
 select data into old from public.s2a_settings where id='11111111-0000-4000-8000-000000000001' for update;
 cfg:=p_config||jsonb_build_object('ignore_invalid_api_key_errors',true);
 update public.s2a_settings set data=data||jsonb_build_object('ops_advanced_settings',cfg-'openai_account_quota_auto_pause','openai_account_quota_auto_pause',quota),updated_at=now()
 where id='11111111-0000-4000-8000-000000000001';
 if (cfg->'aggregation'->>'aggregation_enabled')::boolean and not coalesce((old->'ops_advanced_settings'->'aggregation'->>'aggregation_enabled')::boolean,false) then
  update public.s2a_ops_aggregation_cursor set backfill_next=date_bin(interval '1 hour',now()-interval '31 days','1970-01-01'::timestamptz) where id;
 end if;
 perform public.s2a_ops_scheduler_configure();
 return public.s2a_ops_advanced_get();
end $$;

create function public.s2a_ops_error_ignored(p_event jsonb) returns boolean language sql stable security definer set search_path='' as $$
 select p_event->>'kind'='request' and (
  p_event->>'phase'='auth' or
  p_event->>'code'='context_canceled' and (cfg->>'ignore_context_canceled')::boolean or
  p_event->>'code'='no_available_account' and (cfg->>'ignore_no_available_accounts')::boolean or
  p_event->>'code'='insufficient_balance' and (cfg->>'ignore_insufficient_balance_errors')::boolean or
  p_event->>'status_code'='404' and p_event->>'endpoint' like '%/count_tokens' and (cfg->>'ignore_count_tokens_errors')::boolean
 ) from (select public.s2a_ops_advanced_get() cfg) c;
$$;
do $$
declare definition text;needle text:=' if p_event->>''key_hash'' is not null then';
begin
 definition:=pg_get_functiondef('public.s2a_ops_error_record(jsonb)'::regprocedure);
 if strpos(definition,needle)=0 then raise exception 'error journal definition changed';end if;
 execute replace(definition,needle,' if public.s2a_ops_error_ignored(p_event) then return null;end if;'||chr(10)||needle);
end $$;

revoke all on function public.s2a_ops_advanced_get(),public.s2a_ops_advanced_set(jsonb),public.s2a_ops_scheduler_configure(),public.s2a_ops_aggregation_tick(),public.s2a_ops_cleanup(),public.s2a_ops_error_ignored(jsonb),public.s2a_ops_valid_cleanup_schedule(text) from public,anon,authenticated,service_role;
grant execute on function public.s2a_ops_advanced_get(),public.s2a_ops_advanced_set(jsonb),public.s2a_ops_scheduler_configure() to service_role;
notify pgrst,'reload schema';
