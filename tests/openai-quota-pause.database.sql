begin;
do $$
declare u uuid:=gen_random_uuid();g uuid;a uuid:=gen_random_uuid();b uuid:=gen_random_uuid();r jsonb;sample jsonb;before_settings jsonb;stamp bigint:=floor(extract(epoch from now()));
begin
 sample:=jsonb_build_object('codex_5h_used_percent',95,'codex_5h_reset_at',now()+interval '1 hour','codex_usage_updated_at',now(),'auto_pause_5h_threshold',0.9);
 if not public.s2a_openai_quota_paused(sample,'openai','oauth') then raise exception 'account threshold ignored';end if;
 if public.s2a_openai_quota_paused(sample||'{"auto_pause_5h_disabled":true}','openai','oauth') then raise exception 'explicit window disable ignored';end if;
 if public.s2a_openai_quota_paused(sample||jsonb_build_object('codex_5h_reset_at',now()-interval '1 second'),'openai','oauth') then raise exception 'rolled-over window remains paused';end if;
 if public.s2a_openai_quota_paused((sample-'codex_5h_reset_at')||jsonb_build_object('codex_usage_updated_at',now()-interval '3 hours'),'openai','oauth') then raise exception 'stale unknown window remains paused';end if;
 if not public.s2a_openai_quota_paused(sample||jsonb_build_object('codex_usage_updated_at',now()-interval '3 hours'),'openai','oauth') then raise exception 'known future reset ignored';end if;
 if not public.s2a_openai_quota_paused(sample-'codex_usage_updated_at'-'codex_5h_reset_at','openai','oauth') then raise exception 'missing sample time silently unpaused';end if;
 if public.s2a_openai_quota_paused(sample,'anthropic','apikey') then raise exception 'unrelated provider paused';end if;
 if public.s2a_openai_quota_paused((sample-'codex_5h_reset_at')||jsonb_build_object('codex_usage_updated_at',now()-interval '5 minutes','codex_5h_reset_after_seconds',120),'openai','oauth') then raise exception 'relative reset slid forward';end if;
 sample:=sample||'{"auto_reset_credit_enabled":true,"auto_reset_credit_5h_threshold":1,"auto_reset_credit_7d_threshold":1}';
 if not public.s2a_openai_quota_paused(sample,'openai','oauth') then raise exception 'unconfirmed credit bypassed ordinary pause';end if;
 sample:=sample||jsonb_build_object('codex_auto_reset_credit_state',jsonb_build_object('status','available','available_count',1,'checked_at',now()));
 if public.s2a_openai_quota_paused(sample,'openai','oauth') then raise exception 'fresh available credit did not defer ordinary pause';end if;
 if not public.s2a_openai_quota_paused(sample||'{"codex_5h_used_percent":100,"auto_pause_5h_disabled":true}','openai','oauth') then raise exception 'reset threshold did not pause dispatch';end if;

 select data into before_settings from public.s2a_settings;
 r:=public.s2a_settings_update('{"openai_account_quota_auto_pause":{"default_threshold_5h":0.8,"default_threshold_7d":0}}');
 if r?'error' or r->'openai_account_quota_auto_pause'->>'default_threshold_5h'<>'0.8' then raise exception 'global default not saved %',r;end if;
 if not public.s2a_openai_quota_paused('{"codex_5h_used_percent":85}','openai','oauth') then raise exception 'global default not used';end if;
 if public.s2a_openai_quota_paused('{"codex_5h_used_percent":85,"auto_pause_5h_threshold":0.9}','openai','oauth') then raise exception 'account threshold did not override global';end if;
 if public.s2a_openai_quota_paused('{"codex_5h_used_percent":85,"auto_pause_5h_disabled":true}','openai','oauth') then raise exception 'account disable did not override global';end if;
 r:=public.s2a_settings_update('{"site_name":"must-not-save","openai_account_quota_auto_pause":{"default_threshold_5h":2,"default_threshold_7d":0}}');
 if r->>'error'<>'invalid_quota_pause_settings' or (select data->>'site_name' from public.s2a_settings)='must-not-save' then raise exception 'invalid mixed settings mutated data';end if;

 insert into auth.users(id,email) values(u,'pause-db@example.com');
 r:=public.s2a_group_create('Pause selection',u,'openai',1);g:=(r->>'id')::uuid;
 insert into public.s2a_accounts(id,group_id,name,account_fingerprint,ciphertext,iv,priority,extra) values
 (a,g,'Paused priority','pause-first','cipher','iv',1,'{"privacy_mode":"training_off","codex_5h_used_percent":85}'),(b,g,'Healthy fallback','pause-second','cipher','iv',50,'{"privacy_mode":"training_off"}');
 insert into public.s2a_keys(user_id,group_id,name,key_hash,key_prefix) values(u,g,'Pause key',repeat('b',64),'key');perform public.s2a_wallet_update(u,10,'set');
 r:=public.s2a_acquire(repeat('b',64),'gpt-4.1',gen_random_uuid(),'{}',true,null,'{}');
 if r->'account'->>'id'<>b::text then raise exception 'scheduler selected paused account %',r;end if;
 delete from public.s2a_leases where id=(r->>'lease_id')::uuid;
 update public.s2a_accounts set extra=extra||jsonb_build_object('codex_5h_reset_at',now()-interval '1 second') where id=a;
 r:=public.s2a_acquire(repeat('b',64),'gpt-4.1',gen_random_uuid(),'{}',true,null,'{}');
 if r->'account'->>'id'<>a::text then raise exception 'scheduler did not resume after window reset %',r;end if;
 delete from public.s2a_leases where id=(r->>'lease_id')::uuid;
 update public.s2a_accounts set extra=extra||'{"codex_credits_snapshot":{"credits":{"balance":"123.45678"},"fetched_at":1},"auto_reset_credit_enabled":true}' where id=a;
 update public.s2a_openai_auto_reset_jobs set next_attempt_at=now()+interval '10 minutes' where account_id=a;
 if not public.s2a_openai_windows_save(a,1,stamp,jsonb_build_object('codex_5h_used_percent',100,'codex_5h_reset_at',now()+interval '1 hour')) then raise exception 'header window save rejected';end if;
 if (select extra->'codex_credits_snapshot'->'credits'->>'balance' from public.s2a_accounts where id=a)<>'123.45678' then raise exception 'header snapshot erased credits';end if;
 if not exists(select 1 from public.s2a_openai_auto_reset_jobs where account_id=a and next_attempt_at<=now()) then raise exception 'header threshold did not wake reset queue';end if;
 update public.s2a_openai_auto_reset_jobs set next_attempt_at=now()+interval '10 minutes' where account_id=a;
 perform public.s2a_openai_windows_save(a,1,stamp,'{"codex_5h_used_percent":101}');
 if not exists(select 1 from public.s2a_openai_auto_reset_jobs where account_id=a and next_attempt_at<=now()) then raise exception 'same-second threshold did not wake reset queue';end if;
 if public.s2a_openai_windows_save(a,1,stamp-1,'{"codex_5h_used_percent":0}') then raise exception 'older header overwrote newer snapshot';end if;
 if public.s2a_openai_quota_cache_save(a,1,stamp-1,null,null,'{"codex_5h_used_percent":0}') then raise exception 'older quota read overwrote header snapshot';end if;
 update public.s2a_accounts set credential_version=2 where id=a;
 if public.s2a_openai_windows_save(a,1,stamp+1,'{"codex_5h_used_percent":0}') then raise exception 'stale credential header accepted';end if;
 begin perform public.s2a_openai_windows_save(a,2,stamp+1,'{"privacy_mode":"training_off"}');raise exception 'accepted_unrelated_header';exception when others then if sqlerrm<>'invalid_quota_windows' then raise;end if;end;
 if has_function_privilege('anon','public.s2a_openai_windows_save(uuid,bigint,bigint,jsonb)','execute') or has_function_privilege('service_role','public.s2a_settings_update_without_quota_pause(jsonb)','execute') then raise exception 'private writer exposed';end if;
end $$;
rollback;
