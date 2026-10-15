begin;
do $$
declare actor uuid:=gen_random_uuid();gid uuid:=gen_random_uuid();aid uuid:=gen_random_uuid();kid uuid:=gen_random_uuid();rid uuid:=gen_random_uuid();failed uuid:=gen_random_uuid();
begin
 insert into auth.users(id,email) values(actor,'ops-requests@example.com');
 insert into public.s2a_groups(id,name,platform) values(gid,'Request group','anthropic');
 insert into public.s2a_accounts(id,name,group_id,platform,type,account_fingerprint,ciphertext,iv) values(aid,'Request account',gid,'anthropic','apikey',aid::text,'private-cipher','private-iv');
 insert into public.s2a_keys(id,user_id,group_id,name,key_hash,key_prefix) values(kid,actor,gid,'Request key',repeat('d',64),'prefix');
 insert into public.s2a_usage(id,request_id,account_id,key_id,user_id,group_id,model,status,outcome,duration_ms) values
 (gen_random_uuid(),rid,aid,kid,actor,gid,'claude-alias',200,'completed',120),
 (gen_random_uuid(),rid,aid,kid,actor,gid,'claude-alias',429,'failed',40),
 (gen_random_uuid(),failed,aid,kid,actor,gid,'claude-alias',200,'incomplete',60);
 assert (select count(*)=1 from public.s2a_ops_requests where request_id=rid::text),'failed retries are not separate client successes';
 assert (select platform='anthropic' and account_name='Request account' and first_token_ms is null from public.s2a_ops_requests where request_id=rid::text),'original fields preserve unknown timing';
 perform public.s2a_ops_error_record(jsonb_build_object('event_id',failed,'request_id',failed,'kind','request','phase','upstream','type','upstream_error','owner','provider','source','gateway','code','upstream_response_failed','limited',false,'status_code',200,'key_hash',repeat('d',64),'account_id',aid,'stream',true,'duration_ms',60));
 assert (select count(*)=1 from public.s2a_ops_requests where request_id=failed::text),'incomplete HTTP 200 streams remain failed requests';
 assert (select kind='error' and error_id is not null and status_code=200 and account_name='Request account' from public.s2a_ops_requests where request_id=failed::text);
 assert not has_table_privilege('authenticated','public.s2a_ops_requests','select');
 assert not has_table_privilege('anon','public.s2a_ops_requests','select');
 assert has_table_privilege('service_role','public.s2a_ops_requests','select');
 assert not has_table_privilege('service_role','public.s2a_ops_requests','update');
 assert not (select to_jsonb(r)::text like '%private-%' from public.s2a_ops_requests r where request_id=rid::text);
end $$;
rollback;
