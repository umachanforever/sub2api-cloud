begin;
do $$
declare cfg jsonb:=public.s2a_ops_advanced_get();v jsonb;event jsonb;eid bigint;
begin
 assert cfg->'ignore_invalid_api_key_errors'='true'::jsonb and (cfg->>'auto_refresh_interval_seconds')::integer=30;
 assert public.s2a_ops_valid_cleanup_schedule('0,15,30,45 0-23/2 1-31 1-12 0-7');
 assert not public.s2a_ops_valid_cleanup_schedule('99 * * * *') and not public.s2a_ops_valid_cleanup_schedule('*/0 * * * *') and not public.s2a_ops_valid_cleanup_schedule('* * 0 * *');
 cfg:=cfg||'{"data_retention":{"cleanup_enabled":false,"cleanup_schedule":"0 2 * * *","error_log_retention_days":0,"minute_metrics_retention_days":0,"hourly_metrics_retention_days":0},"ignore_no_available_accounts":true,"ignore_insufficient_balance_errors":true,"ignore_invalid_api_key_errors":false,"auto_refresh_enabled":true,"auto_refresh_interval_seconds":15,"openai_account_quota_auto_pause":{"default_threshold_5h":0.8,"default_threshold_7d":0.9}}';
 v:=public.s2a_ops_advanced_set(cfg);assert v->'ignore_invalid_api_key_errors'='true'::jsonb;
 assert (select data->'openai_account_quota_auto_pause' from public.s2a_settings)=cfg->'openai_account_quota_auto_pause','scheduler and console share quota thresholds';
 event:=jsonb_build_object('event_id',gen_random_uuid(),'request_id',gen_random_uuid(),'kind','request','phase','routing','type','service_unavailable','owner','platform','source','gateway','code','no_available_account','limited',false,'status_code',503);
 assert public.s2a_ops_error_record(event) is null;
 assert public.s2a_ops_error_record(event||'{"code":"context_canceled","phase":"request","type":"context_canceled","owner":"client","limited":true}') is null;
 assert public.s2a_ops_error_record(event||'{"code":"insufficient_balance","phase":"request","type":"billing_error","owner":"client","limited":true,"status_code":402}') is null;
 assert public.s2a_ops_error_record(event||'{"phase":"auth","code":"authentication_failed"}') is null,'invalid API key rejects never become request faults';
 assert public.s2a_ops_error_record(event||'{"status_code":404,"endpoint":"/v1/messages/count_tokens"}') is null;
 v:=public.s2a_ops_advanced_set(cfg||'{"ignore_context_canceled":false,"ignore_no_available_accounts":false}');
 eid:=public.s2a_ops_error_record(event);assert eid is not null;
 assert public.s2a_ops_error_record(event||jsonb_build_object('event_id',gen_random_uuid(),'request_id',gen_random_uuid(),'code','context_canceled','phase','request','type','context_canceled','owner','client','limited',true)) is not null;
 assert public.s2a_ops_cleanup()->'skipped'='true'::jsonb;
 assert public.s2a_ops_aggregation_tick()->'skipped'='true'::jsonb;
 begin perform public.s2a_ops_advanced_set(cfg||'{"auto_refresh_interval_seconds":14}');raise exception 'short interval accepted';exception when raise_exception then assert sqlerrm='invalid_advanced_settings';end;
 begin perform public.s2a_ops_advanced_set(cfg||'{"display_alert_events":"false"}');raise exception 'nonboolean accepted';exception when raise_exception then assert sqlerrm='invalid_advanced_settings';end;
 begin perform public.s2a_ops_advanced_set(jsonb_set(cfg,'{data_retention,cleanup_schedule}','"99 * * * *"'));raise exception 'bad disabled schedule accepted';exception when raise_exception then assert sqlerrm='invalid_advanced_settings';end;
 begin perform public.s2a_ops_advanced_set(cfg||'{"openai_account_quota_auto_pause":{"default_threshold_5h":1.1,"default_threshold_7d":0}}');raise exception 'bad quota threshold accepted';exception when raise_exception then assert sqlerrm='invalid_advanced_settings';end;
 if exists(select 1 from pg_catalog.pg_extension where extname='pg_cron') then
  cfg:=cfg||'{"aggregation":{"aggregation_enabled":true},"ignore_no_available_accounts":false}';
  cfg:=jsonb_set(cfg,'{data_retention,cleanup_enabled}','true');
  v:=public.s2a_ops_advanced_set(cfg);
  assert (select count(*) from cron.job where jobname in('s2a-ops-retention','s2a-ops-aggregation'))=2;
  assert (select schedule from cron.job where jobname='s2a-ops-retention')='0 2 * * *';
  assert (select command from cron.job where jobname='s2a-ops-aggregation')='select public.s2a_ops_aggregation_tick();';
  v:=public.s2a_ops_aggregation_tick();assert v?'backfill' and v->'backfill' is not null,'history is processed in bounded chunks';
  assert (select backfill_next>date_bin(interval '1 hour',now()-interval '31 days','1970-01-01'::timestamptz) from public.s2a_ops_aggregation_cursor where id);
  eid:=public.s2a_ops_error_record(event||jsonb_build_object('event_id',gen_random_uuid(),'request_id',gen_random_uuid()));assert eid is not null;
  insert into public.s2a_ops_metrics(bucket_start,resolution,platform,group_id,success_count,error_count,business_limited_count,upstream_error_count,upstream_429_count,upstream_529_count,token_consumed,unknown_token_attempts,switch_count)
  values('2000-01-01',60,'fixture',null,1,0,0,0,0,0,1,0,0),('2000-01-01',3600,'fixture',null,1,0,0,0,0,0,1,0,0);
  insert into public.s2a_ops_metrics(bucket_start,resolution,platform,group_id,success_count,error_count,business_limited_count,upstream_error_count,upstream_429_count,upstream_529_count,token_consumed,unknown_token_attempts,switch_count)
  select '2001-01-01'::timestamptz+n*interval '1 minute',60,'bulk',null,1,0,0,0,0,0,1,0,0 from generate_series(1,10001) n;
  v:=public.s2a_ops_cleanup();assert (v->>'errors_deleted')::integer>0 and (v->>'minute_metrics_deleted')::integer>0 and (v->>'hourly_metrics_deleted')::integer>0;
  assert not exists(select 1 from public.s2a_ops_errors where id=eid),'zero-day retention clears error history';
  assert (v->>'minute_metrics_deleted')::integer>=10002 and not exists(select 1 from public.s2a_ops_metrics where platform='bulk'),'cleanup finishes every batch in the same run';
  assert not exists(select 1 from public.s2a_ops_aggregation_coverage),'expired hourly metrics invalidate coverage';
  cfg:=jsonb_set(jsonb_set(cfg,'{data_retention,cleanup_enabled}','false'),'{aggregation,aggregation_enabled}','false');
  perform public.s2a_ops_advanced_set(cfg);
  assert not exists(select 1 from cron.job where jobname in('s2a-ops-retention','s2a-ops-aggregation'));
 end if;
 assert not has_function_privilege('authenticated','public.s2a_ops_advanced_set(jsonb)','execute');
 assert not has_function_privilege('service_role','public.s2a_ops_cleanup()','execute');
 assert not has_table_privilege('authenticated','public.s2a_ops_metrics','select');
 assert not has_table_privilege('service_role','public.s2a_ops_metrics','delete');
end $$;
rollback;
