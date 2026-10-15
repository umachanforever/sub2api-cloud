begin;
do $$
declare actor uuid:=gen_random_uuid();gid uuid:=gen_random_uuid();aid uuid:=gen_random_uuid();kid uuid:=gen_random_uuid();request uuid:=gen_random_uuid();
 mark timestamptz:='2026-10-14T01:00:00Z';v jsonb;eid bigint;
begin
 insert into auth.users(id,email) values(actor,'traffic@example.com');
 insert into public.s2a_groups(id,name) values(gid,'Traffic group');
 insert into public.s2a_accounts(id,name,group_id,account_fingerprint,ciphertext,iv,status) values(aid,'Traffic fixture',gid,aid::text,'private-cipher','private-iv','disabled');
 insert into public.s2a_keys(id,user_id,group_id,name,key_hash,key_prefix) values(kid,actor,gid,'Traffic fixture',repeat('f',64),'fixture');
 insert into public.s2a_usage(id,request_id,account_id,key_id,user_id,group_id,model,status,outcome,input_tokens,output_tokens,cache_read_tokens,duration_ms,created_at) values
 (gen_random_uuid(),gen_random_uuid(),aid,kid,actor,gid,'alias',200,'completed',600,120,200,100,mark+interval '10 seconds'),
 (gen_random_uuid(),request,aid,kid,actor,gid,'alias',200,'incomplete',30,30,0,100,mark+interval '4 minutes 30 seconds'),
 (gen_random_uuid(),gen_random_uuid(),aid,kid,actor,gid,'alias',200,'completed',null,null,null,100,mark+interval '4 minutes 40 seconds'),
 (gen_random_uuid(),gen_random_uuid(),aid,kid,actor,gid,'__models__',200,'completed',10000,10000,0,100,mark+interval '4 minutes 50 seconds'),
 (gen_random_uuid(),gen_random_uuid(),aid,kid,actor,gid,'alias',200,'completed',10000,10000,0,100,mark+interval '5 minutes');
 insert into public.s2a_usage(id,request_id,account_id,key_id,user_id,group_id,model,status,outcome,input_tokens,output_tokens,duration_ms,created_at)
 select gen_random_uuid(),gen_random_uuid(),aid,kid,actor,gid,'alias',200,'completed',0,0,100,mark+interval '4 minutes 45 seconds' from generate_series(1,60);
 eid:=public.s2a_ops_error_record(jsonb_build_object('event_id',gen_random_uuid(),'kind','request','request_id',request,'platform','openai','key_hash',repeat('f',64),'account_id',aid,'status_code',200,'phase','upstream','type','upstream_error','owner','provider','source','gateway','code','upstream_response_failed','limited',false));
 update public.s2a_ops_errors set created_at=mark+interval '4 minutes 30 seconds' where id=eid;
 perform public.s2a_ops_error_record(jsonb_build_object('event_id',gen_random_uuid(),'kind','upstream','request_id',request,'platform','openai','key_hash',repeat('f',64),'account_id',aid,'status_code',503,'phase','upstream','type','upstream_error','owner','provider','source','upstream_http','code','upstream_request_failed','limited',false));
 set local role service_role;
 v:=public.s2a_ops_realtime_traffic(mark,mark+interval '5 minutes','openai',gid);
 assert v->'qps'='{"current":1.0,"peak":1.0,"avg":0.2}'::jsonb,'interrupted usage is counted once and upstream retries are excluded';
 assert (v->'tps'->>'avg')::numeric=2.6 and (v->'tps'->>'peak')::numeric=12 and (v->'tps'->>'current')::numeric=1,'cache is not double counted; final boundary excluded';
 assert (v->>'unknown_token_attempts')::int=1;
 v:=public.s2a_ops_realtime_traffic(mark,mark+interval '5 minutes','gemini',gid);assert (v->'tps'->>'avg')::numeric=0;
 begin perform public.s2a_ops_realtime_traffic(mark,mark+interval '2 hours');raise exception 'long range accepted';exception when raise_exception then assert sqlerrm='invalid_traffic_filter';end;
 reset role;
 assert not has_function_privilege('anon','public.s2a_ops_realtime_traffic(timestamptz,timestamptz,text,uuid)','execute');
 assert not has_function_privilege('authenticated','public.s2a_ops_realtime_traffic(timestamptz,timestamptz,text,uuid)','execute');
end $$;
rollback;
