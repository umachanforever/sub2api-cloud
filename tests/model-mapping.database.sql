begin;
insert into auth.users(id,email) values('aabbccdd-ffff-4fff-8fff-fffffffffff1','mapping@example.com');
do $$ declare actor uuid:='aabbccdd-ffff-4fff-8fff-fffffffffff1';g uuid;r jsonb;first_account uuid:=gen_random_uuid();mapped_account uuid:=gen_random_uuid();key uuid:=gen_random_uuid();lease uuid;bill jsonb;usage public.s2a_usage;version bigint;begin
 if public.s2a_account_mapped_model('{"*":"fallback","alias*":"broad","alias-long*":"specific","alias-long":"exact"}','alias-long','openai')<>'exact'
 or public.s2a_account_mapped_model('{"*":"fallback","alias*":"broad","alias-long*":"specific"}','alias-longer','openai')<>'specific'
 or public.s2a_account_mapped_model('{"literal_%*":"yes"}','literalXYZ','openai') is not null
 or public.s2a_account_mapped_model('{"alias":"target"}','Alias','openai') is not null
 or public.s2a_account_mapped_model('{"gemini-3.1-pro-preview":"target"}','gemini-3.1-pro-preview-customtools','gemini')<>'target'
 then raise exception 'mapping resolution mismatch';end if;
 r:=public.s2a_group_create('Account mappings',actor,'openai',1);g:=(r->>'id')::uuid;
 insert into public.s2a_accounts(id,group_id,name,type,account_fingerprint,ciphertext,iv,priority,model_mapping) values
 (first_account,g,'Incompatible','apikey','mapping-first','cipher','iv',0,'{"other":"gpt-4.1"}'),
 (mapped_account,g,'Compatible','apikey','mapping-second','cipher','iv',1,'{"alias":"gpt-4.1","family*":"gpt-4.1"}');
 insert into public.s2a_keys(id,user_id,group_id,name,key_hash,key_prefix) values(key,actor,g,'Mapped',repeat('8',64),'prefix');
 perform public.s2a_wallet_update(actor,10,'set');
 r:=public.s2a_acquire(repeat('8',64),'alias',gen_random_uuid(),'{}',true,null,'{}');
 if not r ? 'lease_id' or r->'account'->>'id'<>mapped_account::text or r->>'upstream_model'<>'gpt-4.1' then raise exception 'mapping did not select compatible account %',r;end if;
 lease:=(r->>'lease_id')::uuid;select billing into bill from public.s2a_leases where id=lease;
 if bill->>'billing_model'<>'gpt-4.1' or bill->>'model_mapping_chain'<>'alias → gpt-4.1' then raise exception 'mapping snapshot missing %',bill;end if;
 update public.s2a_accounts set model_mapping='{"alias":"different"}',rate_multiplier=4 where id=mapped_account;
 perform public.s2a_finish(lease,200,'completed',100,10,0,0);
 select * into usage from public.s2a_usage where id=lease;
 if usage.model<>'alias' or usage.billing_model<>'gpt-4.1' or usage.upstream_model<>'gpt-4.1' or usage.model_mapping_chain<>'alias → gpt-4.1'
 or usage.total_cost<>100*(bill->'rates'->>'input_cost_per_token')::numeric+10*(bill->'rates'->>'output_cost_per_token')::numeric
 or usage.actual_cost<>usage.total_cost then raise exception 'mapping edit changed reserved bill %',to_jsonb(usage);end if;
 update public.s2a_keys set window_count=0 where id=key;update public.s2a_accounts set last_used_at=null where id=mapped_account;
 r:=public.s2a_acquire(repeat('8',64),'alias',gen_random_uuid(),'{}',true,null,'{}');
 if r->>'error'<>'model_pricing_unavailable' or exists(select 1 from public.s2a_leases where key_id=key)
 or (select window_count from public.s2a_keys where id=key)<>0 or (select last_used_at from public.s2a_accounts where id=mapped_account) is not null then raise exception 'unpriced mapping consumed reservation %',r;end if;
 update public.s2a_accounts set model_mapping='{"alias":"gpt-4.1"}' where id=mapped_account;
 perform public.s2a_wallet_update(actor,0,'set');
 r:=public.s2a_acquire(repeat('8',64),'alias',gen_random_uuid(),'{}',true,null,'{}');
 if r->>'error'<>'insufficient_balance' or exists(select 1 from public.s2a_leases where key_id=key) or (select window_count from public.s2a_keys where id=key)<>0
 or (select last_used_at from public.s2a_accounts where id=mapped_account) is not null then raise exception 'unfunded mapping consumed reservation %',r;end if;
 update public.s2a_groups set model_allowlist='{"enabled":true,"models":["gpt-4.1"]}' where id=g;
 r:=public.s2a_acquire(repeat('8',64),'alias',gen_random_uuid(),'{}',true,null,'{}');if r->>'error'<>'model_not_allowed' then raise exception 'mapped target bypassed requested policy %',r;end if;
 update public.s2a_groups set model_allowlist='{"enabled":false,"models":[]}' where id=g;
 r:=public.s2a_acquire(repeat('8',64),'__models__',gen_random_uuid(),'{}',true,null,'{}');
 if r->'model_sources'->'mapping'<>'{"alias":"gpt-4.1","other":"gpt-4.1"}' or r->'model_sources'->>'include_upstream'<>'false' then raise exception 'group mapping sources incomplete %',r;end if;
 perform public.s2a_finish((r->>'lease_id')::uuid,200,'completed');
 select credential_version into version from public.s2a_accounts where id=mapped_account;
 r:=public.s2a_account_save(mapped_account,'{"model_mapping":{}}',array[g]);if r ? 'error' or (select model_mapping from public.s2a_accounts where id=mapped_account)<>'{}'
 or (select credential_version from public.s2a_accounts where id=mapped_account)<>version then raise exception 'metadata clear rotated credentials %',r;end if;
 r:=public.s2a_account_save(mapped_account,'{"model_mapping":{"alias":"gpt-4.1"}}',array[g]);
 r:=public.s2a_account_save(mapped_account,'{"notes":"Keep mapping"}',array[g]);if (select model_mapping from public.s2a_accounts where id=mapped_account)<>'{"alias":"gpt-4.1"}' then raise exception 'omitted mapping erased';end if;
 begin update public.s2a_accounts set model_mapping='{"x*bad":"target"}' where id=mapped_account;raise exception 'malformed mapping accepted';exception when raise_exception then if sqlerrm='malformed mapping accepted' then raise;end if;end;
end $$;
rollback;
