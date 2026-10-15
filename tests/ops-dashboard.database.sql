begin;
do $$
declare actor uuid:=gen_random_uuid();gid uuid:=gen_random_uuid();alien uuid:=gen_random_uuid();aid uuid:=gen_random_uuid();second uuid:=gen_random_uuid();kid uuid:=gen_random_uuid();
 good uuid:=gen_random_uuid();bad uuid:=gen_random_uuid();limited uuid:=gen_random_uuid();interrupted uuid:=gen_random_uuid();v jsonb;r jsonb;event jsonb;eid bigint;mark timestamptz:='2026-10-14T01:00:00Z';
begin
 insert into auth.users(id,email) values(actor,'dashboard@example.com');
 insert into public.s2a_groups(id,name) values(gid,'Dashboard group'),(alien,'Other group');
 insert into public.s2a_accounts(id,name,group_id,account_fingerprint,ciphertext,iv) values(aid,'First',gid,aid::text,'private-cipher','private-iv'),(second,'Second',gid,second::text,'private-cipher','private-iv');
 insert into public.s2a_keys(id,user_id,group_id,name,key_hash,key_prefix) values(kid,actor,gid,'Dashboard',repeat('b',64),'prefix');
 insert into public.s2a_usage(id,request_id,account_id,key_id,user_id,group_id,model,status,outcome,input_tokens,output_tokens,cache_read_tokens,duration_ms,first_token_ms,created_at) values
 (gen_random_uuid(),good,second,kid,actor,gid,'alias',200,'completed',10,5,8,100,0,mark+interval '10 seconds'),
 (gen_random_uuid(),good,aid,kid,actor,gid,'alias',429,'failed',null,null,null,20,null,mark+interval '5 seconds'),
 (gen_random_uuid(),interrupted,second,kid,actor,gid,'alias',200,'incomplete',4,2,3,600,80,mark+interval '30 seconds'),
 (gen_random_uuid(),gen_random_uuid(),aid,kid,actor,alien,'alias',200,'completed',1000,1000,0,0,null,mark+interval '1 second'),
 (gen_random_uuid(),gen_random_uuid(),aid,kid,actor,gid,'alias',200,'completed',1000,1000,0,0,null,mark+interval '2 minutes'),
 (gen_random_uuid(),gen_random_uuid(),aid,kid,actor,gid,'__models__',200,'completed',null,null,null,0,null,mark+interval '1 minute');
 event:=jsonb_build_object('event_id',gen_random_uuid(),'request_id',good,'kind','upstream','phase','upstream','type','upstream_error','owner','provider','source','upstream_http','code','upstream_request_failed','limited',false,'status_code',429,'key_hash',repeat('b',64),'account_id',aid,'platform','openai','duration_ms',20);
 eid:=public.s2a_ops_error_record(event);update public.s2a_ops_errors set created_at=mark+interval '5 seconds' where id=eid;
 eid:=public.s2a_ops_error_record(event||jsonb_build_object('event_id',bad,'request_id',bad,'kind','request','owner','platform','phase','routing','source','gateway','type','service_unavailable','code','no_available_account','status_code',503));
 update public.s2a_ops_errors set created_at=mark+interval '20 seconds' where id=eid;
 eid:=public.s2a_ops_error_record(event||jsonb_build_object('event_id',limited,'request_id',limited,'kind','request','owner','client','phase','request','source','client_request','type','rate_limit_error','code','request_limit_exceeded','limited',true));
 update public.s2a_ops_errors set created_at=mark+interval '25 seconds' where id=eid;
 eid:=public.s2a_ops_error_record(event||jsonb_build_object('event_id',interrupted,'request_id',interrupted,'kind','request','source','gateway','code','upstream_response_failed','account_id',second,'status_code',200));
 update public.s2a_ops_errors set created_at=mark+interval '30 seconds' where id=eid;
 eid:=public.s2a_ops_error_record(event||jsonb_build_object('event_id',gen_random_uuid(),'request_id',bad,'status_code',529));update public.s2a_ops_errors set created_at=mark+interval '19 seconds' where id=eid;
 eid:=public.s2a_ops_error_record(event||jsonb_build_object('event_id',gen_random_uuid(),'request_id',bad,'status_code',502));update public.s2a_ops_errors set created_at=mark+interval '18 seconds' where id=eid;
 set local role service_role;
 v:=public.s2a_ops_dashboard(mark,mark+interval '2 minutes','openai',gid,60);
 r:=v->'overview';
 assert (r->>'success_count')::int=1 and (r->>'error_count_total')::int=3 and (r->>'business_limited_count')::int=1;
 assert (r->>'request_count_total')::int=4 and (r->>'request_count_sla')::int=3 and (r->>'sla')::numeric=0.3333;
 assert (r->>'upstream_429_count')::int=1 and (r->>'upstream_529_count')::int=1 and (r->>'upstream_error_count_excl_429_529')::int=1;
 assert (r->>'token_consumed')::int=21,'cached input is counted once and interrupted output is included';
 assert (r->>'unknown_token_attempts')::int=1,'model discovery does not create missing-generation usage';
 assert (r->'duration'->>'p99_ms')::int=100 and (r->'ttft'->>'p99_ms')::int=0,'unknown timings are excluded and zero is a sample';
 assert (r->'output_tps'->>'sample_count')::int=1 and (r->'output_tps'->>'avg')::numeric=50;
 assert jsonb_array_length(v->'throughput_trend'->'points')=2 and (v->'throughput_trend'->'points'->1->>'request_count')::int=0,'empty buckets are filled';
 assert (v->'throughput_trend'->'points'->0->>'switch_count')::int=1,'recovered failover to the final account is counted';
 assert (v->'throughput_trend'->'top_groups'->0->>'group_id')::uuid=gid;
 assert (v->'error_trend'->'points'->0->>'error_count_total')::int=3;
 r:=public.s2a_ops_dashboard(mark,mark+interval '2 minutes','openai',gid,60,'error-distribution');assert (r->>'total')::int=3 and jsonb_array_length(r->'items')=3,'HTTP 200 interruptions appear in distribution';
 r:=public.s2a_ops_dashboard(mark,mark+interval '2 minutes','openai',gid,60,'latency-histogram');assert (r->>'total_requests')::int=1 and jsonb_array_length(r->'buckets')=6 and (r->'buckets'->1->>'count')::int=1,'histogram boundaries match drill-down';
 r:=public.s2a_ops_dashboard(mark,mark+interval '2 minutes','gemini',gid,60,'overview');assert (r->>'request_count_total')::int=0 and r->'duration'->'p50_ms'='null'::jsonb;
 r:=public.s2a_ops_dashboard(mark+interval '6 seconds',mark+interval '15 seconds','openai',gid,60,'throughput-trend');
 assert (r->'points'->0->>'switch_count')::int=1,'a prior attempt outside the window anchors the switch';
 assert (r->'points'->0->>'tps')::numeric=1.7 and (r->'points'->0->>'request_count')::int=1,'partial buckets use their observed duration';
 r:=public.s2a_ops_aggregate(mark,mark+interval '1 hour');assert (r->>'written_rows')::int=5;
 select to_jsonb(m) into r from public.s2a_ops_metrics m where bucket_start=mark and resolution=60 and group_id=gid;
 assert (r->>'success_count')::int=1 and (r->>'error_count')::int=3 and (r->>'business_limited_count')::int=1;
 assert (r->>'upstream_error_count')::int=1 and (r->>'upstream_429_count')::int=1 and (r->>'upstream_529_count')::int=1;
 assert (r->>'token_consumed')::int=21 and (r->>'unknown_token_attempts')::int=1 and (r->>'switch_count')::int=1,'rollups preserve usage, unknown samples and recovered switches';
 select to_jsonb(m) into r from public.s2a_ops_metrics m where bucket_start=mark and resolution=3600 and group_id=gid;
 assert (r->>'success_count')::int=2 and (r->>'token_consumed')::int=2021;
 r:=public.s2a_ops_aggregate(mark,mark+interval '1 hour');assert (r->>'written_rows')::int=5 and (r->>'replaced_rows')::int=5,'repeated aggregation cannot inflate counts';
 assert not has_function_privilege('authenticated','public.s2a_ops_aggregate(timestamptz,timestamptz)','execute');
 assert not has_function_privilege('anon','public.s2a_ops_aggregate(timestamptz,timestamptz)','execute');
 begin perform public.s2a_ops_aggregate(mark,mark+interval '32 days');raise exception 'unbounded aggregation accepted';exception when raise_exception then assert sqlerrm='invalid_aggregation_window';end;
 reset role;
 insert into public.s2a_usage(id,request_id,account_id,key_id,user_id,group_id,model,status,outcome,input_tokens,output_tokens,duration_ms,created_at) values
 (gen_random_uuid(),gen_random_uuid(),aid,kid,actor,gid,'alias',200,'completed',0,0,99,mark+interval '40 seconds'),
 (gen_random_uuid(),gen_random_uuid(),aid,kid,actor,gid,'alias',200,'completed',0,0,2000,mark+interval '50 seconds');
 r:=public.s2a_ops_dashboard(mark,mark+interval '2 minutes','openai',gid,60,'overview');assert (r->'duration'->>'p50_ms')::int=100 and (r->'duration'->>'p99_ms')::int=1962,'percentiles use individual samples';
 r:=public.s2a_ops_dashboard(mark,mark+interval '2 minutes','openai',gid,60,'latency-histogram');assert (r->'buckets'->0->>'count')::int=1 and (r->'buckets'->5->>'count')::int=1;
 begin perform public.s2a_ops_dashboard(mark,mark);raise exception 'zero window accepted';exception when raise_exception then assert sqlerrm='invalid_dashboard_filter';end;
 begin perform public.s2a_ops_dashboard(mark,mark+interval '32 days');raise exception 'long window accepted';exception when raise_exception then assert sqlerrm='invalid_dashboard_filter';end;
 assert not has_function_privilege('anon','public.s2a_ops_dashboard(timestamptz,timestamptz,text,uuid,integer,text,text)','execute');
 assert not has_function_privilege('authenticated','public.s2a_ops_dashboard(timestamptz,timestamptz,text,uuid,integer,text,text)','execute');
 assert not v::text like '%private-%';
 insert into public.s2a_usage(id,request_id,account_id,key_id,user_id,group_id,model,status,outcome,input_tokens,output_tokens,duration_ms,created_at) values
 (gen_random_uuid(),gen_random_uuid(),aid,kid,actor,gid,'alias',200,'completed',40,10,100,mark-interval '5 minutes'),
 (gen_random_uuid(),gen_random_uuid(),aid,kid,actor,gid,'alias',200,'completed',10,10,100,mark+interval '65 minutes');
 perform public.s2a_ops_aggregate(mark,mark+interval '1 hour');
 v:=public.s2a_ops_dashboard(mark-interval '30 minutes',mark+interval '90 minutes','openai',gid,60,'overview','raw');
 r:=public.s2a_ops_dashboard(mark-interval '30 minutes',mark+interval '90 minutes','openai',gid,60,'overview','preagg');
 assert (v-'query_mode'-'raw_samples_complete')=(r-'query_mode'-'raw_samples_complete'),'hybrid head, complete hours and tail match exact raw totals';
 assert r->>'query_mode'='preagg' and r->'raw_samples_complete'='true'::jsonb;
 delete from public.s2a_ops_aggregation_coverage where bucket_start=mark;
 r:=public.s2a_ops_dashboard(mark,mark+interval '1 hour','openai',gid,60,'overview','preagg');assert r->>'error'='ops_preaggregation_not_populated';
 r:=public.s2a_ops_dashboard(mark,mark+interval '1 hour','openai',gid,60,'overview','auto');assert r->>'query_mode'='raw';
 perform public.s2a_ops_aggregate(mark,mark+interval '1 hour');
 r:=public.s2a_ops_dashboard(mark,mark+interval '1 hour','gemini',gid,60,'overview','preagg');assert (r->>'request_count_total')::integer=0 and r->>'query_mode'='preagg','coverage distinguishes a genuinely empty provider from missing aggregation';
 delete from public.s2a_ops_errors where group_id=gid;
 r:=public.s2a_ops_dashboard(mark,mark+interval '1 hour','openai',gid,60,'overview','preagg');
 assert (r->>'error_count_total')::integer=3 and r->'qps'->'peak'='null'::jsonb and r->'tps'->'peak'<>'null'::jsonb,'archived errors survive raw cleanup; retained token peaks remain known';
 assert r->'raw_samples_complete'='false'::jsonb;
 delete from public.s2a_usage where group_id=gid;
 perform public.s2a_ops_aggregate(mark,mark+interval '1 hour');
 r:=public.s2a_ops_dashboard(mark,mark+interval '1 hour','openai',gid,60,'overview','preagg');
 assert (r->>'token_consumed')::integer=2021 and (r->>'unknown_token_attempts')::integer=1;
 assert r->'duration'->'p99_ms'='null'::jsonb and r->'ttft'->'p99_ms'='null'::jsonb and r->'output_tps'='null'::jsonb and r->'tps'->'peak'='null'::jsonb,'expired individual samples cannot fabricate exact timing or peak values';
 assert not has_function_privilege('service_role','public.s2a_ops_dashboard_raw(timestamptz,timestamptz,text,uuid,integer,text)','execute');
end $$;
rollback;
