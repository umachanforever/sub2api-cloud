begin;
do $$
declare actor uuid:=gen_random_uuid();gid uuid:=gen_random_uuid();aid uuid:=gen_random_uuid();kid uuid:=gen_random_uuid();lease uuid:=gen_random_uuid();rid uuid:=gen_random_uuid();eid bigint;
begin
 insert into auth.users(id,email) values(actor,'first-token@example.com');
 insert into public.s2a_groups(id,name) values(gid,'First token');
 insert into public.s2a_accounts(id,name,group_id,account_fingerprint,ciphertext,iv) values(aid,'First token',gid,aid::text,'encrypted','iv');
 insert into public.s2a_keys(id,user_id,group_id,name,key_hash,key_prefix) values(kid,actor,gid,'First token',repeat('a',64),'prefix');
 insert into public.s2a_leases(id,request_id,account_id,key_id,model,billing) values(lease,rid,aid,kid,'alias',jsonb_build_object('group_id',gid,'stream',true));
 begin perform public.s2a_finish(lease,200,'completed',p_first_token_ms=>-1);raise exception 'negative timing accepted';exception when raise_exception then assert sqlerrm='invalid_first_token_ms';end;
 assert exists(select 1 from public.s2a_leases where id=lease),'invalid timing leaves settlement untouched';
 set local role service_role;
 perform public.s2a_finish(lease,200,'completed',p_first_token_ms=>0);
 perform public.s2a_finish(lease,200,'completed',p_first_token_ms=>999);
 reset role;
 assert (select first_token_ms=0 from public.s2a_usage where id=lease),'zero latency is known and retries never rewrite it';
 assert (select count(*)=1 from public.s2a_usage where id=lease),'timing retries preserve settlement identity';
 assert (select first_token_ms=0 from public.s2a_ops_requests where request_id=rid::text),'request drill-down exposes measured timing';
 lease:=gen_random_uuid();rid:=gen_random_uuid();
 insert into public.s2a_leases(id,request_id,account_id,key_id,model,billing) values(lease,rid,aid,kid,'alias',jsonb_build_object('group_id',gid,'stream',true));
 perform public.s2a_finish(lease,200,'incomplete',p_first_token_ms=>40);
 eid:=public.s2a_ops_error_record(jsonb_build_object('event_id',rid,'request_id',rid,'kind','request','phase','upstream','type','upstream_error','owner','provider','source','gateway','code','upstream_response_failed','limited',false,'status_code',200,'key_hash',repeat('a',64),'account_id',aid));
 assert (select time_to_first_token_ms=40 from public.s2a_ops_error_details where id=eid),'interrupted streams preserve measured first-token latency';
 assert not has_function_privilege('service_role','public.s2a_finish_without_timing(uuid,integer,text,bigint,bigint,bigint,bigint,integer,bigint)','execute');
 assert not has_function_privilege('authenticated','public.s2a_finish(uuid,integer,text,bigint,bigint,bigint,bigint,integer,bigint,integer)','execute');
end $$;
rollback;
