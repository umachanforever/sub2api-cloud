begin;
do $$
declare a uuid:=gen_random_uuid(); b uuid:=gen_random_uuid(); c jsonb; j public.s2a_privacy_jobs; key text;
begin
 insert into public.s2a_accounts(id,name,account_fingerprint,ciphertext,iv,extra) values(a,'Privacy queue','privacy-queue','cipher','iv','{"privacy_mode":"training_set_failed"}');
 if not exists(select 1 from public.s2a_privacy_jobs where account_id=a) then raise exception 'creation not enqueued';end if;
 c:=public.s2a_privacy_jobs_claim();select * into j from public.s2a_privacy_jobs where account_id=a;
 if j.lease_id is null or j.attempts<>1 then raise exception 'claim failed %',c;end if;
 update public.s2a_accounts set extra=extra||'{"privacy_mode":"training_set_cf_blocked"}' where id=a;
 if (select lease_id from public.s2a_privacy_jobs where account_id=a)<>j.lease_id then raise exception 'failure reset lease';end if;
 if not public.s2a_privacy_jobs_finish(a,j.revision,j.lease_id) then raise exception 'finish failed';end if;
 if (select next_attempt_at from public.s2a_privacy_jobs where account_id=a)<now()+interval '15 minutes' then raise exception 'challenge retry too early';end if;
 update public.s2a_privacy_jobs set next_attempt_at=now() where account_id=a;
 c:=public.s2a_privacy_jobs_claim();select * into j from public.s2a_privacy_jobs where account_id=a;
 update public.s2a_accounts set credential_version=credential_version+1 where id=a;
 if public.s2a_privacy_jobs_finish(a,j.revision,j.lease_id) then raise exception 'stale lease finished newer work';end if;
 if (select attempts from public.s2a_privacy_jobs where account_id=a)<>0 then raise exception 'new credentials not reset';end if;
 c:=public.s2a_privacy_jobs_claim();select * into j from public.s2a_privacy_jobs where account_id=a;
 update public.s2a_privacy_jobs set lease_until=now()-interval '1 second' where account_id=a;
 c:=public.s2a_privacy_jobs_claim();
 if (select lease_id from public.s2a_privacy_jobs where account_id=a)=j.lease_id then raise exception 'expired job not reclaimed';end if;
 select * into j from public.s2a_privacy_jobs where account_id=a;
 update public.s2a_accounts set extra=extra||'{"privacy_mode":"training_off"}' where id=a;
 if not public.s2a_privacy_jobs_finish(a,j.revision,j.lease_id) then raise exception 'success finish rejected';end if;
 if exists(select 1 from public.s2a_privacy_jobs where account_id=a) then raise exception 'success not removed';end if;
 update public.s2a_accounts set extra=extra||'{"privacy_mode":""}' where id=a;
 if not exists(select 1 from public.s2a_privacy_jobs where account_id=a) then raise exception 'blank privacy not enqueued';end if;
 update public.s2a_accounts set type='apikey' where id=a;
 if exists(select 1 from public.s2a_privacy_jobs where account_id=a) then raise exception 'unsupported job not cancelled';end if;
 update public.s2a_accounts set type='oauth' where id=a;
 delete from public.s2a_accounts where id=a;
 if exists(select 1 from public.s2a_privacy_jobs where account_id=a) then raise exception 'deleted job survived';end if;
 begin
  insert into public.s2a_accounts(id,name,account_fingerprint,ciphertext,iv) values(b,'Rollback privacy','privacy-rollback','cipher','iv');
  raise exception 'rollback';
 exception when raise_exception then null;end;
 if exists(select 1 from public.s2a_privacy_jobs where account_id=b) then raise exception 'rollback job survived';end if;
 if has_table_privilege('anon','public.s2a_privacy_jobs','select') or has_table_privilege('authenticated','public.s2a_privacy_scheduler','select')
 or has_function_privilege('anon','public.s2a_privacy_jobs_claim()','execute') or has_function_privilege('authenticated','public.s2a_privacy_jobs_finish(uuid,bigint,uuid,text)','execute')
 or has_function_privilege('authenticated','public.s2a_privacy_scheduler_configure(text,text,boolean)','execute') then raise exception 'private queue exposed';end if;
 begin perform public.s2a_privacy_scheduler_configure('http://evil.invalid','key');raise exception 'accepted_bad_url';exception when others then if sqlerrm<>'invalid_scheduler_url' then raise;end if;end;
 begin perform public.s2a_privacy_scheduler_configure('https://project.supabase.co','key');raise exception 'accepted_bad_key';exception when others then if sqlerrm<>'invalid_scheduler_service_key' then raise;end if;end;
 key:='header.'||rtrim(translate(encode(convert_to('{"role":"service_role"}','UTF8'),'base64'),'+/','-_'),'=')||'.signature';
 if not exists(select 1 from pg_available_extensions where name='pg_cron') then
  if public.s2a_privacy_scheduler_configure('https://project.supabase.co',key)->>'error'<>'scheduler_extensions_unavailable' then raise exception 'missing extensions not reported';end if;
 end if;
 if public.s2a_privacy_scheduler_configure(null,null,false)->>'enabled'<>'false' then raise exception 'disable failed';end if;
end $$;
rollback;
