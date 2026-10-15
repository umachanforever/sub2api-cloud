begin;
do $$
declare actor uuid:=gen_random_uuid();gid uuid:=gen_random_uuid();other uuid:=gen_random_uuid();aid uuid:=gen_random_uuid();kid uuid:=gen_random_uuid();v jsonb;mark timestamptz:='2026-10-14T01:00:00Z';
begin
 insert into auth.users(id,email) values(actor,'model-stats@example.com');
 insert into public.s2a_groups(id,name,platform) values(gid,'Model stats','anthropic'),(other,'Other stats','anthropic');
 insert into public.s2a_accounts(id,name,group_id,platform,type,account_fingerprint,ciphertext,iv) values(aid,'Model stats',gid,'anthropic','apikey',aid::text,'private-cipher','private-iv');
 insert into public.s2a_keys(id,user_id,group_id,name,key_hash,key_prefix) values(kid,actor,gid,'Model stats',repeat('f',64),'prefix');
 insert into public.s2a_usage(id,request_id,account_id,key_id,user_id,group_id,model,status,outcome,input_tokens,output_tokens,duration_ms,first_token_ms,created_at) values
 (gen_random_uuid(),gen_random_uuid(),aid,kid,actor,gid,'alpha-alias',200,'completed',10,5,100,0,mark),
 (gen_random_uuid(),gen_random_uuid(),aid,kid,actor,gid,'alpha-alias',200,'completed',10,15,200,null,mark),
 (gen_random_uuid(),gen_random_uuid(),aid,kid,actor,gid,'beta-alias',200,'completed',null,null,0,null,mark),
 (gen_random_uuid(),gen_random_uuid(),aid,kid,actor,gid,'delta-alias',200,'completed',10,0,0,null,mark),
 (gen_random_uuid(),gen_random_uuid(),aid,kid,actor,gid,'alpha-alias',502,'failed',10,100,50,10,mark),
 (gen_random_uuid(),gen_random_uuid(),aid,kid,actor,gid,'alpha-alias',200,'incomplete',10,100,50,10,mark),
 (gen_random_uuid(),gen_random_uuid(),aid,kid,actor,gid,'__models__',200,'completed',null,null,0,null,mark),
 (gen_random_uuid(),gen_random_uuid(),aid,kid,actor,other,'alien-alias',200,'completed',10,100,50,10,mark),
 (gen_random_uuid(),gen_random_uuid(),aid,kid,actor,gid,'boundary-alias',200,'completed',10,100,50,10,mark+interval '1 hour');
 set local role service_role;
 v:=public.s2a_ops_model_stats(mark,mark+interval '1 hour','anthropic',gid,1);
 assert (v->>'total')::int=3 and (v->>'top_n')::int=1 and not v?'page','Top N counts the complete model set';
 assert v->'items'->0->>'model'='alpha-alias' and (v->'items'->0->>'request_count')::int=2;
 assert (v->'items'->0->>'avg_tokens_per_sec')::numeric=62.5,'average is per request, not total output divided by duration';
 assert (v->'items'->0->>'total_output_tokens')::int=20 and (v->'items'->0->>'avg_duration_ms')::int=150;
 assert (v->'items'->0->>'avg_first_token_ms')::numeric=0 and (v->'items'->0->>'requests_with_first_token')::int=1;
 v:=public.s2a_ops_model_stats(mark,mark+interval '1 hour','anthropic',gid,null,2,1);assert v->'items'->0->>'model'='beta-alias' and (v->>'total')::int=3;
 assert v->'items'->0->'avg_tokens_per_sec'='null'::jsonb and v->'items'->0->'avg_first_token_ms'='null'::jsonb,'unknown speed and timing remain unknown';
 assert v->'items'->0->'total_output_tokens'='null'::jsonb and (v->'items'->0->>'unknown_output_requests')::int=1,'missing output is not zero';
 v:=public.s2a_ops_model_stats(mark,mark+interval '1 hour','gemini',gid);assert (v->>'total')::int=0 and jsonb_array_length(v->'items')=0;
 begin perform public.s2a_ops_model_stats(mark,mark+interval '1 hour','',gid,101);raise exception 'invalid limit accepted';exception when raise_exception then assert sqlerrm='invalid_model_stats_filter';end;
 begin perform public.s2a_ops_model_stats(mark,mark+interval '1 hour','',gid,20,2,20);raise exception 'mixed pagination accepted';exception when raise_exception then assert sqlerrm='invalid_model_stats_filter';end;
 reset role;
 insert into public.s2a_usage(id,request_id,account_id,key_id,user_id,group_id,model,status,outcome,input_tokens,duration_ms,created_at)
 values(gen_random_uuid(),gen_random_uuid(),aid,kid,actor,gid,'alpha-alias',200,'completed',10,100,mark);
 v:=public.s2a_ops_model_stats(mark,mark+interval '1 hour','anthropic',gid,1);
 assert (v->'items'->0->>'total_output_tokens')::int=20 and (v->'items'->0->>'unknown_output_requests')::int=1,'mixed totals preserve known output with incompleteness metadata';
 assert not has_function_privilege('anon','public.s2a_ops_model_stats(timestamptz,timestamptz,text,uuid,integer,integer,integer)','execute');
 assert not has_function_privilege('authenticated','public.s2a_ops_model_stats(timestamptz,timestamptz,text,uuid,integer,integer,integer)','execute');
end $$;
rollback;
