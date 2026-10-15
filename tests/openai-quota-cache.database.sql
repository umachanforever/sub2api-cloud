begin;
do $$
declare a uuid:=gen_random_uuid();epoch bigint:=extract(epoch from now())::bigint;
 credits jsonb:='{"has_credits":true,"unlimited":false,"balance":"12345678901234567890.12345678"}';reset jsonb:='{"available_count":1,"credits":[{"expires_at":"2030-01-01T00:00:00Z"}]}';
begin
 insert into public.s2a_accounts(id,name,account_fingerprint,ciphertext,iv,extra) values(a,'Quota CAS','quota-cas','cipher','iv','{"email":"keep@example.com","privacy_mode":"training_off"}');
 if not public.s2a_openai_quota_cache_save(a,1,epoch,credits,reset) then raise exception 'cache rejected';end if;
 if (select extra->'codex_credits_snapshot'->'credits'->>'balance' from public.s2a_accounts where id=a)<>credits->>'balance' then raise exception 'balance precision lost';end if;
 if not public.s2a_openai_quota_cache_save(a,1,epoch+1,null,null) then raise exception 'unknown balance rejected';end if;
 if (select extra->'codex_credits_snapshot'->'credits' from public.s2a_accounts where id=a)<>'null'::jsonb then raise exception 'unknown balance became zero';end if;
 if (select extra->'codex_reset_credit_snapshot' from public.s2a_accounts where id=a)<>reset then raise exception 'optional details failure erased cache';end if;
 if public.s2a_openai_quota_cache_save(a,1,epoch,credits,reset) then raise exception 'older result overwrote cache';end if;
 update public.s2a_accounts set credential_version=2 where id=a;
 if public.s2a_openai_quota_cache_save(a,1,epoch+2,credits,reset) then raise exception 'stale credentials overwrote cache';end if;
 if (select extra->>'email' from public.s2a_accounts where id=a)<>'keep@example.com' then raise exception 'unrelated metadata lost';end if;
 begin perform public.s2a_openai_quota_cache_save(a,2,epoch+2,credits,'{"available_count":2,"credits":[{"expires_at":"2030-01-01"}]}');raise exception 'accepted_incomplete';exception when others then if sqlerrm<>'incomplete_reset_credit_snapshot' then raise;end if;end;
 begin perform public.s2a_openai_quota_cache_save(a,2,epoch+2,'{"has_credits":true,"unlimited":false,"balance":0}',null);raise exception 'accepted_number';exception when others then if sqlerrm<>'invalid_quota_snapshot' then raise;end if;end;
 begin perform public.s2a_openai_quota_cache_save(a,2,epoch+2,credits,'{"available_count":1,"credits":[{"expires_at":"invalid"}]}');raise exception 'accepted_expiration';exception when others then if sqlerrm<>'invalid_quota_snapshot' then raise;end if;end;
 if not public.s2a_openai_quota_cache_save(a,2,epoch+2,credits,null,'{"codex_5h_used_percent":1.5,"codex_5h_reset_after_seconds":60,"codex_5h_window_minutes":300,"codex_5h_reset_at":"2030-01-01T00:00:00Z","codex_usage_updated_at":"2026-10-15T00:00:00Z"}') then raise exception 'window snapshot not saved';end if;
 if (select extra->>'codex_5h_used_percent' from public.s2a_accounts where id=a)<>'1.5' then raise exception 'window usage lost';end if;
 begin perform public.s2a_openai_quota_cache_save(a,2,epoch+3,credits,null,'{"privacy_mode":"training_off"}');raise exception 'accepted_unrelated_window';exception when others then if sqlerrm<>'invalid_quota_windows' then raise;end if;end;
 if has_function_privilege('service_role','public.s2a_openai_quota_cache_write(uuid,bigint,bigint,jsonb,jsonb)','execute') then raise exception 'private cache writer exposed';end if;
 if has_function_privilege('anon','public.s2a_openai_quota_cache_save(uuid,bigint,bigint,jsonb,jsonb,jsonb)','execute') or has_function_privilege('authenticated','public.s2a_openai_quota_cache_save(uuid,bigint,bigint,jsonb,jsonb,jsonb)','execute') then raise exception 'private cache exposed';end if;
end $$;
rollback;
