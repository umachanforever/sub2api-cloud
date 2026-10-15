begin;
do $$ declare g uuid:=gen_random_uuid();a uuid:=gen_random_uuid();begin
 insert into public.s2a_groups(id,name) values(g,'Privacy CAS');
 insert into public.s2a_accounts(id,group_id,name,account_fingerprint,ciphertext,iv,extra) values(a,g,'Privacy CAS','privacy-cas','cipher','iv','{"email":"keep"}');
 if not public.s2a_account_privacy_save(a,1,null,'training_off') then raise exception 'initial privacy write rejected';end if;
 if (select extra->>'email' from public.s2a_accounts where id=a)<>'keep' then raise exception 'unrelated metadata lost';end if;
 if public.s2a_account_privacy_save(a,1,null,'training_set_failed') then raise exception 'stale metadata overwrote success';end if;
 update public.s2a_accounts set credential_version=2 where id=a;
 if public.s2a_account_privacy_save(a,1,'"training_off"','training_set_failed') then raise exception 'stale credentials overwrote privacy';end if;
 if not public.s2a_account_privacy_save(a,2,'"training_off"','training_set_failed') then raise exception 'force retry rejected';end if;
 update public.s2a_accounts set type='apikey' where id=a;
 if public.s2a_account_privacy_save(a,2,'"training_set_failed"','training_off') then raise exception 'apikey accepted';end if;
 if has_function_privilege('authenticated','public.s2a_account_privacy_save(uuid,bigint,jsonb,text)','execute') or has_function_privilege('anon','public.s2a_account_privacy_save(uuid,bigint,jsonb,text)','execute') then raise exception 'privacy RPC exposed';end if;
end $$;
rollback;
