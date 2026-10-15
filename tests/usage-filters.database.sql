begin;
insert into auth.users(id) values('dddddddd-dddd-4ddd-8ddd-ddddddddddd1'),('dddddddd-dddd-4ddd-8ddd-ddddddddddd2');
insert into public.s2a_groups(id,name) values('dddddddd-dddd-4ddd-8ddd-ddddddddddd3','Usage filters one'),('dddddddd-dddd-4ddd-8ddd-ddddddddddd4','Usage filters two');
insert into public.s2a_accounts(id,group_id,name,account_fingerprint,ciphertext,iv) values
 ('dddddddd-dddd-4ddd-8ddd-ddddddddddd5','dddddddd-dddd-4ddd-8ddd-ddddddddddd3','Usage one','usage-filters-one','ciphertext','iv'),
 ('dddddddd-dddd-4ddd-8ddd-ddddddddddd6','dddddddd-dddd-4ddd-8ddd-ddddddddddd4','Usage two','usage-filters-two','ciphertext','iv');
insert into public.s2a_keys(id,user_id,group_id,name,key_hash,key_prefix) values
 ('dddddddd-dddd-4ddd-8ddd-ddddddddddd7','dddddddd-dddd-4ddd-8ddd-ddddddddddd1','dddddddd-dddd-4ddd-8ddd-ddddddddddd3','Usage one',repeat('7',64),'fixture'),
 ('dddddddd-dddd-4ddd-8ddd-ddddddddddd8','dddddddd-dddd-4ddd-8ddd-ddddddddddd1','dddddddd-dddd-4ddd-8ddd-ddddddddddd4','Usage two',repeat('8',64),'fixture'),
 ('dddddddd-dddd-4ddd-8ddd-ddddddddddd9','dddddddd-dddd-4ddd-8ddd-ddddddddddd2','dddddddd-dddd-4ddd-8ddd-ddddddddddd3','Usage three',repeat('d',64),'fixture'),
 ('dddddddd-dddd-4ddd-8ddd-dddddddddda0','dddddddd-dddd-4ddd-8ddd-ddddddddddd2','dddddddd-dddd-4ddd-8ddd-ddddddddddd4','Usage four',repeat('e',64),'fixture');
insert into public.s2a_usage(id,request_id,user_id,group_id,account_id,key_id,model,status,outcome,duration_ms,input_tokens,output_tokens,total_cost,actual_cost,billing_type,stream,native_compaction_v2,request_type,created_at) values
 (gen_random_uuid(),gen_random_uuid(),'dddddddd-dddd-4ddd-8ddd-ddddddddddd1','dddddddd-dddd-4ddd-8ddd-ddddddddddd3','dddddddd-dddd-4ddd-8ddd-ddddddddddd5','dddddddd-dddd-4ddd-8ddd-ddddddddddd7','filter-model',200,'completed',10,10,1,.1,.1,0,false,false,'unknown','2026-10-13 12:00+08'),
 (gen_random_uuid(),gen_random_uuid(),'dddddddd-dddd-4ddd-8ddd-ddddddddddd1','dddddddd-dddd-4ddd-8ddd-ddddddddddd4','dddddddd-dddd-4ddd-8ddd-ddddddddddd6','dddddddd-dddd-4ddd-8ddd-ddddddddddd8','filter-model',200,'completed',20,20,2,.2,.2,1,true,false,'unknown','2026-10-13 13:00+08'),
 (gen_random_uuid(),gen_random_uuid(),'dddddddd-dddd-4ddd-8ddd-ddddddddddd2','dddddddd-dddd-4ddd-8ddd-ddddddddddd3','dddddddd-dddd-4ddd-8ddd-ddddddddddd5','dddddddd-dddd-4ddd-8ddd-ddddddddddd9','filter-model',200,'completed',30,30,3,.3,.3,0,false,false,'unknown','2026-10-13 14:00+08'),
 (gen_random_uuid(),gen_random_uuid(),'dddddddd-dddd-4ddd-8ddd-ddddddddddd2','dddddddd-dddd-4ddd-8ddd-ddddddddddd4','dddddddd-dddd-4ddd-8ddd-ddddddddddd6','dddddddd-dddd-4ddd-8ddd-dddddddddda0','filter-model',200,'completed',40,40,4,.4,.4,1,true,true,'ws_v2','2026-10-13 15:00+08');
set local role service_role;
do $$ declare r jsonb; begin
 r:=public.s2a_dashboard('dddddddd-dddd-4ddd-8ddd-ddddddddddd1','2026-10-13 00:00+08','2026-10-14 00:00+08','Asia/Shanghai',null,'filter-model','hour',true,'{"group_id":"dddddddd-dddd-4ddd-8ddd-ddddddddddd4","account_id":"dddddddd-dddd-4ddd-8ddd-ddddddddddd6","stream":true,"billing_type":1}');
 if r->'summary'->>'requests'<>'1' or (r->'summary'->>'actual_cost')::numeric<>.2 or jsonb_array_length(r->'daily')<>24 then raise exception 'ownership/filter aggregate mismatch: %',r;end if;
 if (select sum((value->>'requests')::int) from jsonb_array_elements(r->'daily'))<>1 or r->'models'->0->>'requests'<>'1' then raise exception 'chart filters disagree';end if;
 r:=public.s2a_dashboard(null,'2026-10-13 00:00+08','2026-10-14 00:00+08','Asia/Shanghai',null,'filter-model','day',true,'{"billing_type":0,"stream":false,"request_type":"sync","native_compaction_v2":false}');
 if r->'summary'->>'requests'<>'2' or (r->'summary'->>'actual_cost')::numeric<>.4 then raise exception 'false/zero filter mismatch: %',r;end if;
 r:=public.s2a_dashboard(null,'2026-10-13 00:00+08','2026-10-14 00:00+08','Asia/Shanghai',null,'filter-model','day',true,'{"request_type":"ws_v2","native_compaction_v2":true}');
 if r->'summary'->>'requests'<>'1' or (r->'summary'->>'input_tokens')::int<>40 then raise exception 'stored transport metadata ignored: %',r;end if;
 r:=public.s2a_dashboard(null,'2026-10-13 00:00+08','2026-10-14 00:00+08','Asia/Shanghai',null,'filter-model','day',true,'{"billing_mode":"image"}');
 if r->'summary'->>'requests'<>'0' then raise exception 'pricing unit confused with funding';end if;
end $$;
rollback;
