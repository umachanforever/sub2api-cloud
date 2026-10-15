begin;
insert into auth.users(id,email) values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1','atomic@example.com');
insert into public.s2a_groups(id,name,platform) values
 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2','Atomic primary','openai'),
 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3','Atomic shared','openai'),
 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb4','Other provider','anthropic');
do $$ declare a uuid; r jsonb; g1 uuid:='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2'; g2 uuid:='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3'; wrong uuid:='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb4';
 patch jsonb:='{"name":"Atomic","platform":"openai","type":"apikey","status":"active","priority":50,"concurrency":3,"notes":"","extra":{},"schedulable":true,"expires_at":null,"auto_pause_on_expired":true,"account_fingerprint":"atomic-fingerprint","ciphertext":"encrypted","iv":"iv"}';
 rotation jsonb:='{"expected_version":1,"fingerprint":"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee","ciphertext":"rotated","iv":"new-iv"}';
 k uuid; ticket uuid:='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb5'; owner uuid:='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';
 begin
 r:=public.s2a_account_save(null,patch,array[g1,wrong]);
 if r->>'status'<>'400' or exists(select 1 from public.s2a_accounts where account_fingerprint='atomic-fingerprint') then raise exception 'invalid create wrote an account';end if;
 r:=public.s2a_account_save(null,patch,array[g1,g2]);a:=(r->>'id')::uuid;
 if a is null or (select count(*) from public.s2a_account_groups where account_id=a)<>2 then raise exception 'shared create failed %',r;end if;
 if (select public.s2a_group_account_count(g) from public.s2a_groups g where id=g1)<>1 or (select public.s2a_group_account_count(g) from public.s2a_groups g where id=g2)<>1 or (select public.s2a_group_account_count(g) from public.s2a_groups g where id=wrong)<>0 then raise exception 'shared group counts incorrect';end if;
 r:=public.s2a_account_save(a,'{"name":"Rejected"}',array[g1,wrong]);
 if r->>'status'<>'400' or (select name from public.s2a_accounts where id=a)<>'Atomic' or (select count(*) from public.s2a_account_groups where account_id=a)<>2 then raise exception 'rejected edit changed state';end if;
 r:=public.s2a_account_save(a,'{"name":"Single"}',array[g2]);
 if r ? 'error' or not exists(select 1 from public.s2a_accounts where id=a and name='Single' and group_id=g2) or (select count(*) from public.s2a_account_groups where account_id=a)<>1 then raise exception 'shrink left secondary memberships';end if;
 if (select public.s2a_group_account_count(g) from public.s2a_groups g where id=g1)<>0 or (select public.s2a_group_account_count(g) from public.s2a_groups g where id=g2)<>1 then raise exception 'shrink counts stale';end if;
 insert into public.s2a_keys(user_id,group_id,name,key_hash,key_prefix) values(owner,g2,'Atomic',repeat('b',64),'prefix') returning id into k;
 insert into public.s2a_leases(request_id,account_id,key_id,model) values(gen_random_uuid(),a,k,'test');
 r:=public.s2a_account_save(a,'{"name":"Busy"}',array[g1,g2],null,null,rotation);
 if r->>'status'<>'409' or not exists(select 1 from public.s2a_accounts where id=a and name='Single' and ciphertext='encrypted' and group_id=g2) or (select count(*) from public.s2a_account_groups where account_id=a)<>1 then raise exception 'busy rotation changed state';end if;
 delete from public.s2a_leases where account_id=a;
 r:=public.s2a_account_save(a,'{"name":"Rotated"}',array[g1,g2],null,null,rotation);
 if r ? 'error' or not exists(select 1 from public.s2a_accounts where id=a and name='Rotated' and ciphertext='rotated' and credential_version=2 and group_id=g1) or (select count(*) from public.s2a_account_groups where account_id=a)<>2 then raise exception 'rotation and groups did not commit together %',r;end if;
 r:=public.s2a_account_save(a,'{"name":"Stale"}',array[g2],null,null,rotation);
 if r->>'error'<>'credential_version_conflict' or (select name from public.s2a_accounts where id=a)<>'Rotated' or (select count(*) from public.s2a_account_groups where account_id=a)<>2 then raise exception 'stale rotation changed state';end if;
 insert into public.s2a_oauth_tickets(id,user_id,account_fingerprint,ciphertext,iv,metadata) values(ticket,owner,'atomic-oauth','oauth-encrypted','iv','{}');
 patch:=patch||'{"name":"OAuth","type":"oauth","rate_multiplier":0.2,"load_factor":7}'::jsonb;
 r:=public.s2a_account_save(null,patch,array[g1,g2],ticket,owner);a:=(r->>'id')::uuid;
 if a is null or (select count(*) from public.s2a_account_groups where account_id=a)<>2 or not exists(select 1 from public.s2a_accounts where id=a and rate_multiplier=0.2 and load_factor=7) then raise exception 'OAuth shared create failed %',r;end if;
 r:=public.s2a_account_save(null,patch||'{"name":"Retry","rate_multiplier":10,"load_factor":1}',array[g2],ticket,owner);
 if r->>'id'<>a::text or not exists(select 1 from public.s2a_accounts where id=a and name='OAuth' and rate_multiplier=0.2 and load_factor=7) or (select count(*) from public.s2a_account_groups where account_id=a)<>2 then raise exception 'OAuth replay changed metadata or groups';end if;
 if not has_function_privilege('service_role','public.s2a_account_save(uuid,jsonb,uuid[],uuid,uuid,jsonb)','execute') then raise exception 'service grant missing';end if;
end $$;
set local role anon;
do $$ begin
 begin perform public.s2a_account_save(null,'{}','{}');raise exception 'anonymous account save allowed';exception when insufficient_privilege then null;end;
end $$;
rollback;
