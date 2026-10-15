begin;
insert into auth.users(id) values ('cccccccc-cccc-4ccc-8ccc-ccccccccccc1');
insert into public.s2a_groups(id,name) values ('cccccccc-cccc-4ccc-8ccc-ccccccccccc2','Rotation');
insert into public.s2a_accounts(id,group_id,name,type,account_fingerprint,ciphertext,iv)
 values ('cccccccc-cccc-4ccc-8ccc-ccccccccccc3','cccccccc-cccc-4ccc-8ccc-ccccccccccc2','Original','apikey',repeat('a',64),'original','iv'),
 ('cccccccc-cccc-4ccc-8ccc-ccccccccccc4','cccccccc-cccc-4ccc-8ccc-ccccccccccc2','Duplicate','apikey',repeat('b',64),'other','iv');
insert into public.s2a_keys(id,user_id,group_id,name,key_hash,key_prefix)
 values ('cccccccc-cccc-4ccc-8ccc-ccccccccccc5','cccccccc-cccc-4ccc-8ccc-ccccccccccc1','cccccccc-cccc-4ccc-8ccc-ccccccccccc2','Test',repeat('c',64),'prefix');
insert into public.s2a_leases(request_id,account_id,key_id,model)
 values (gen_random_uuid(),'cccccccc-cccc-4ccc-8ccc-ccccccccccc3','cccccccc-cccc-4ccc-8ccc-ccccccccccc5','test');
do $$ declare r jsonb; a uuid:='cccccccc-cccc-4ccc-8ccc-ccccccccccc3'; begin
 r:=public.s2a_apikey_account_update(a,'openai',1,repeat('d',64),'replacement','new-iv','{"name":"Renamed"}');
 if r->>'status'<>'409' then raise exception 'active lease rotation allowed'; end if;
 if not exists(select 1 from public.s2a_accounts where id=a and name='Original' and ciphertext='original') then raise exception 'failed rotation saved metadata'; end if;
 delete from public.s2a_leases where account_id=a;
 r:=public.s2a_apikey_account_update(a,'anthropic',1,repeat('d',64),'replacement','iv');
 if r->>'status'<>'400' then raise exception 'provider mismatch ignored'; end if;
 r:=public.s2a_apikey_account_update(a,'openai',1,repeat('b',64),'replacement','iv','{"name":"Renamed"}');
 if r->>'error'<>'account_credentials_already_registered' then raise exception 'duplicate fingerprint allowed'; end if;
 if (select name from public.s2a_accounts where id=a)<>'Original' then raise exception 'unique failure saved metadata'; end if;
 r:=public.s2a_apikey_account_update(a,'openai',1,repeat('d',64),'replacement','new-iv','{"name":"Renamed","schedulable":false}');
 if r->>'ok'<>'true' then raise exception 'idle active account refused'; end if;
 if not exists(select 1 from public.s2a_accounts where id=a and name='Renamed' and ciphertext='replacement' and iv='new-iv' and not schedulable and credential_version=2 and status='active') then raise exception 'atomic update incorrect'; end if;
 r:=public.s2a_apikey_account_update(a,'openai',1,repeat('e',64),'stale','iv');
 if r->>'error'<>'credential_version_conflict' then raise exception 'stale editor overwrote rotation'; end if;
 r:=public.s2a_apikey_account_update(a,'openai',2,repeat('d',64),'re-encrypted','iv','{"notes":"Retry"}');
 if r->>'ok'<>'true' or not exists(select 1 from public.s2a_accounts where id=a and credential_version=2 and ciphertext='replacement' and notes='Retry') then raise exception 'same key retry changed credentials'; end if;
 r:=public.s2a_apikey_account_update(a,'openai',2,repeat('d',64),'replacement','iv','{"user_id":"attacker"}');
 if r->>'status'<>'400' then raise exception 'unexpected patch field accepted'; end if;
end $$;
set local role authenticated;
do $$ begin
 begin
  perform public.s2a_apikey_account_update('cccccccc-cccc-4ccc-8ccc-ccccccccccc3','openai',2,repeat('d',64),'replacement','iv');
  raise exception 'authenticated direct rotation allowed';
 exception when insufficient_privilege then null; end;
end $$;
rollback;
