begin;
insert into auth.users(id,email) values('aabbccdd-ffff-4fff-8fff-fffffffffff3','import@example.com'),('aabbccdd-ffff-4fff-8fff-fffffffffff4','import-other@example.com');
do $$ declare actor uuid:='aabbccdd-ffff-4fff-8fff-fffffffffff3';other_actor uuid:='aabbccdd-ffff-4fff-8fff-fffffffffff4';g uuid:=gen_random_uuid();r jsonb;replay jsonb;a uuid;
 patch jsonb:='{"name":"Restored","platform":"openai","type":"apikey","status":"active","priority":7,"concurrency":3,"notes":"Keep","extra":{},"model_mapping":{"alias":"gpt-4.1"},"rate_multiplier":0.5,"load_factor":9,"schedulable":true,"expires_at":null,"auto_pause_on_expired":true,"account_fingerprint":"import-fingerprint","ciphertext":"encrypted","iv":"iv"}';rows jsonb;
 begin
 insert into public.s2a_groups(id,name,platform) values(g,'openai-default','openai');
 rows:=jsonb_build_array(jsonb_build_object('name','Restored','patch',patch),jsonb_build_object('name','Invalid','error','invalid_credentials'),jsonb_build_object('name','Duplicate','patch',patch));
 r:=public.s2a_account_data_import(actor,'import',repeat('a',64),rows,'[{"kind":"proxy","name":"Unsupported","message":"proxy_import_not_supported"}]');
 if r->'data'->>'account_created'<>'1' or r->'data'->>'account_failed'<>'2' or r->'data'->>'proxy_failed'<>'1' or jsonb_array_length(r->'data'->'errors')<>3 then raise exception 'import counts mismatch %',r;end if;
 a:=(r->'account_ids'->>0)::uuid;
 if not exists(select 1 from public.s2a_accounts where id=a and group_id is null and model_mapping=patch->'model_mapping' and rate_multiplier=0.5 and load_factor=9)
 or exists(select 1 from public.s2a_account_groups where account_id=a) then raise exception 'restore metadata or default skip lost';end if;
 replay:=public.s2a_account_data_import(actor,'import',repeat('a',64),rows,'[]');
 if replay->>'replayed'<>'true' or replay->'data'<>r->'data' or replay->'account_ids'<>r->'account_ids' or (select count(*) from public.s2a_accounts where account_fingerprint='import-fingerprint')<>1 then raise exception 'retry duplicated or changed import %',replay;end if;
 replay:=public.s2a_account_data_import(actor,'import',repeat('b',64),rows);if replay->>'status'<>'409' then raise exception 'changed payload reused key';end if;
 r:=public.s2a_account_data_import(other_actor,'import',repeat('a',64),jsonb_build_array(jsonb_build_object('name','Other','patch',patch||'{"account_fingerprint":"import-other"}')),'[]',false);
 a:=(r->'account_ids'->>0)::uuid;if r->>'replayed'<>'false' or (select group_id from public.s2a_accounts where id=a) is distinct from g or (select count(*) from public.s2a_account_groups where account_id=a)<>1 then raise exception 'actor isolation/default binding failed %',r;end if;
 update public.s2a_groups set enabled=false where id=g;
 r:=public.s2a_account_data_import(actor,'inactive-default',repeat('c',64),jsonb_build_array(jsonb_build_object('name','Inactive','patch',patch||'{"account_fingerprint":"import-inactive"}')),'[]',false);
 a:=(r->'account_ids'->>0)::uuid;if a is null or (select group_id from public.s2a_accounts where id=a) is not null then raise exception 'inactive default bound';end if;
 update public.s2a_account_import_operations set created_at=now()-interval '3 hours' where actor_id=actor and idempotency_key='import';
 r:=public.s2a_account_data_import(actor,'import',repeat('d',64),jsonb_build_array(jsonb_build_object('name','Expired','patch',patch||'{"account_fingerprint":"import-expired"}')));
 if r->>'replayed'<>'false' or r->'data'->>'account_created'<>'1' then raise exception 'expired operation not replaced %',r;end if;
 r:=public.s2a_account_data_import(actor,'malformed',repeat('e',64),'[{}]');if r->'data'->>'account_failed'<>'1' or r->'data'->>'account_created'<>'0' then raise exception 'malformed row accepted';end if;
 if exists(select 1 from public.s2a_account_import_operations where result::text like '%encrypted%' or result::text like '%ciphertext%') then raise exception 'operation stored credentials';end if;
 if not has_function_privilege('service_role','public.s2a_account_data_import(uuid,text,text,jsonb,jsonb,boolean)','execute') then raise exception 'service grant missing';end if;
end $$;
create function public.s2a_import_failure_probe() returns trigger language plpgsql as $$ begin if new.account_fingerprint='import-rollback-second' then raise exception 'import_storage_probe';end if;return new;end $$;
create trigger s2a_import_failure_probe before insert on public.s2a_accounts for each row execute function public.s2a_import_failure_probe();
do $$ declare patch jsonb:='{"name":"Rollback","platform":"openai","type":"apikey","status":"active","priority":50,"concurrency":3,"notes":"","extra":{},"schedulable":true,"auto_pause_on_expired":true,"ciphertext":"encrypted","iv":"iv"}';begin
 begin
 perform public.s2a_account_data_import('aabbccdd-ffff-4fff-8fff-fffffffffff3','rollback',repeat('f',64),jsonb_build_array(jsonb_build_object('patch',patch||'{"account_fingerprint":"import-rollback-first"}'),jsonb_build_object('patch',patch||'{"account_fingerprint":"import-rollback-second"}')));
 raise exception 'storage failure hidden';exception when raise_exception then if sqlerrm<>'import_storage_probe' then raise;end if;end;
 if exists(select 1 from public.s2a_accounts where account_fingerprint like 'import-rollback-%') or exists(select 1 from public.s2a_account_import_operations where idempotency_key='rollback') then raise exception 'storage failure left partial import';end if;
end $$;
set local role anon;
do $$ begin
 begin perform public.s2a_account_data_import('aabbccdd-ffff-4fff-8fff-fffffffffff3','anon',repeat('a',64),'[]');raise exception 'anonymous import allowed';exception when insufficient_privilege then null;end;
 begin perform 1 from public.s2a_account_import_operations;raise exception 'anonymous operation read allowed';exception when insufficient_privilege then null;end;
end $$;
rollback;
