begin;
insert into auth.users(id,email,encrypted_password,raw_user_meta_data,raw_app_meta_data) values
 ('88888888-8888-4888-8888-888888888881','rates@example.com','private-password','{"username":"Rates user"}','{"s2a_notes":"Private admin note"}'),
 ('88888888-8888-4888-8888-888888888882','other-rates@example.com','private-password','{}','{}');
insert into public.s2a_groups(id,name,rate_multiplier) values
 ('88888888-8888-4888-8888-888888888883','Rate group',3),('88888888-8888-4888-8888-888888888884','Other rate group',2);
insert into public.s2a_accounts(id,group_id,name,account_fingerprint,ciphertext,iv) values
 ('88888888-8888-4888-8888-888888888885','88888888-8888-4888-8888-888888888883','Rate account','rate-fingerprint','encrypted','iv');
insert into public.s2a_keys(id,user_id,group_id,name,key_hash,key_prefix) values
 ('88888888-8888-4888-8888-888888888886','88888888-8888-4888-8888-888888888881','88888888-8888-4888-8888-888888888883','Rates',repeat('8',64),'prefix');
do $$ declare u uuid:='88888888-8888-4888-8888-888888888881';other uuid:='88888888-8888-4888-8888-888888888882';g uuid:='88888888-8888-4888-8888-888888888883';g2 uuid:='88888888-8888-4888-8888-888888888884';r jsonb;l uuid;daily numeric;month_start timestamptz;before_month numeric;begin
 perform public.s2a_user_configure(u,array[g,g2],10,0,10);update public.s2a_groups set rate_multiplier=1,rpm_limit=7 where id in(g,g2);
 insert into public.s2a_account_groups(account_id,group_id) values('88888888-8888-4888-8888-888888888885',g2);
 insert into public.s2a_keys(user_id,group_id,name,key_hash,key_prefix) values(u,g2,'Second platform key',repeat('7',64),'second');
 r:=public.s2a_platform_quotas_set(u,'[{"platform":"openai","daily_limit_usd":0.00028,"weekly_limit_usd":1,"monthly_limit_usd":3},{"platform":"gemini","daily_limit_usd":0}]');
 if r ? 'error' or jsonb_array_length(r->'platform_quotas')<>2 then raise exception 'quota replacement failed %',r;end if;
 r:=public.s2a_acquire(repeat('8',64),'gpt-4.1',gen_random_uuid(),'{}',true,null,'{}');l:=(r->>'lease_id')::uuid;
 if l is null then raise exception 'platform scheduling failed %',r;end if;perform public.s2a_finish(l,200,'completed',100,10);perform public.s2a_finish(l,200,'completed',100,10);
 if not exists(select 1 from public.s2a_platform_quotas where user_id=u and platform='openai' and daily_usage_usd=0.00028 and weekly_usage_usd=0.00028 and monthly_usage_usd=0.00028) then raise exception 'platform counters missing or finish doubled';end if;
 r:=public.s2a_acquire(repeat('7',64),'gpt-4.1',gen_random_uuid(),'{}',true,null,'{}');if r->>'error'<>'user_platform_daily_quota_exhausted' or not(r ? 'window_resets_at') then raise exception 'second group bypassed same-platform cap %',r;end if;
 if public.s2a_platform_quota_check(other,'openai') ? 'error' then raise exception 'quota crossed users';end if;
 r:=public.s2a_platform_quota_check(u,'gemini');if r->>'error'<>'user_platform_daily_quota_exhausted' then raise exception 'zero platform cap did not prohibit spending';end if;
 month_start:=(select monthly_window_start from public.s2a_platform_quotas where user_id=u and platform='openai');
 r:=public.s2a_platform_quotas_set(u,'[{"platform":"openai","daily_limit_usd":1,"weekly_limit_usd":0.00028,"monthly_limit_usd":3}]');
 if (select daily_usage_usd from public.s2a_platform_quotas where user_id=u and platform='openai')<>0.00028 or (select monthly_window_start from public.s2a_platform_quotas where user_id=u and platform='openai')<>month_start or exists(select 1 from public.s2a_platform_quotas where user_id=u and platform='gemini') then raise exception 'replacement reset usage or retained omitted platform';end if;
 r:=public.s2a_platform_quota_check(u,'openai');if r->>'error'<>'user_platform_weekly_quota_exhausted' then raise exception 'weekly platform cap ignored';end if;
 r:=public.s2a_platform_quota_reset(u,'openai','daily');if r ? 'error' or (select weekly_usage_usd from public.s2a_platform_quotas where user_id=u and platform='openai')<>0.00028 or (select daily_usage_usd from public.s2a_platform_quotas where user_id=u and platform='openai')<>0 then raise exception 'reset changed other windows';end if;
 r:=public.s2a_platform_quota_reset(u,'openai','weekly');if r ? 'error' then raise exception 'weekly reset failed';end if;
 r:=public.s2a_platform_quotas_set(u,'[{"platform":"openai","daily_limit_usd":1,"weekly_limit_usd":1,"monthly_limit_usd":0.00028}]');
 r:=public.s2a_platform_quota_check(u,'openai');if r->>'error'<>'user_platform_monthly_quota_exhausted' then raise exception 'monthly platform cap ignored';end if;
 update public.s2a_platform_quotas set daily_window_start=now()-interval '2 days',daily_usage_usd=5,weekly_window_start=now()-interval '8 days',weekly_usage_usd=5,monthly_window_start=now()-interval '31 days',monthly_usage_usd=5 where user_id=u and platform='openai';
 r:=public.s2a_platform_quotas_get(u,false);if (r->'platform_quotas'->0->>'monthly_usage_usd')::numeric<>0 or r->'platform_quotas'->0 ? 'daily_window_start' then raise exception 'own view did not mask expired usage and admin starts';end if;
 if public.s2a_platform_quota_check(u,'openai') ? 'error' then raise exception 'expired windows blocked';end if;
 perform public.s2a_platform_quota_charge(u,'openai',0.0001);
 if (select monthly_usage_usd from public.s2a_platform_quotas where user_id=u and platform='openai')<>0.0001 or (select monthly_window_start from public.s2a_platform_quotas where user_id=u and platform='openai')<>now() then raise exception 'charge did not restart rolling month';end if;
 r:=public.s2a_platform_quotas_set(u,'[{"platform":"openai","daily_limit_usd":0}]');
 update public.s2a_groups set subscription_type='subscription' where id=g;perform public.s2a_subscription_assign(u,g,30);
 before_month:=(select monthly_usage_usd from public.s2a_platform_quotas where user_id=u and platform='openai');
 r:=public.s2a_acquire(repeat('8',64),'gpt-4.1',gen_random_uuid(),'{}',true,null,'{}');l:=(r->>'lease_id')::uuid;
 if l is null then raise exception 'subscription not exempt from platform cap %',r;end if;perform public.s2a_finish(l,200,'completed',100,10);
 if (select monthly_usage_usd from public.s2a_platform_quotas where user_id=u and platform='openai')<>before_month then raise exception 'subscription consumed platform cap';end if;
 r:=public.s2a_platform_quotas_set(u,'[{"platform":"openai","daily_limit_usd":1},{"platform":"bad","daily_limit_usd":1}]');if r->>'status'<>'400' or (select daily_limit_usd from public.s2a_platform_quotas where user_id=u and platform='openai')<>0 then raise exception 'invalid batch partially updated';end if;
 r:=public.s2a_platform_quotas_set(u,'[{"platform":"openai","daily_limit_usd":1},{"platform":"openai","daily_limit_usd":2}]');if r->>'status'<>'400' then raise exception 'duplicate platforms allowed';end if;
 r:=public.s2a_platform_quotas_set(u,'[{"platform":"openai","daily_limit_usd":null,"weekly_limit_usd":null,"monthly_limit_usd":null}]');if exists(select 1 from public.s2a_platform_quotas where user_id=u) then raise exception 'all-null row not removed';end if;
 r:=public.s2a_platform_quota_reset(u,'openai','daily');if r->>'error'<>'platform_quota_not_found' then raise exception 'missing reset not explicit';end if;
 r:=public.s2a_platform_quotas_get(gen_random_uuid(),true);if r->>'error'<>'user_not_found' then raise exception 'missing user returned empty';end if;
 r:=public.s2a_user_rpm_status(u);if (r->>'user_rpm_used')::integer<>2 or r->>'user_rpm_limit'<>'10' or jsonb_array_length(r->'per_group')<>2 then raise exception 'RPM aggregate incorrect %',r;end if;
 perform public.s2a_group_rpm_set(g,jsonb_build_array(jsonb_build_object('user_id',u,'rpm_override',0)));
 r:=public.s2a_user_rpm_status(u);if not exists(select 1 from jsonb_array_elements(r->'per_group') e where e->>'group_id'=g::text and e->>'limit'='0' and e->>'source'='override') then raise exception 'RPM override source missing';end if;
 update public.s2a_user_limits set window_start=now()-interval '61 seconds' where user_id=u;update public.s2a_user_group_windows set window_start=now()-interval '61 seconds' where user_id=u;
 r:=public.s2a_user_rpm_status(u);if r->>'user_rpm_used'<>'0' or exists(select 1 from jsonb_array_elements(r->'per_group') e where e->>'used'<>'0') then raise exception 'expired RPM counts retained';end if;
 if not exists(select 1 from public.s2a_audit_logs where action='s2a_platform_quotas.delete' and extra->'resource_refs'->>'user_id'=u::text and extra->'resource_refs'->>'platform'='openai' and extra->'changed_fields' ? 'daily_limit_usd') then raise exception 'quota audit lost target';end if;
 r:=public.s2a_settings_update('{"default_platform_quotas":{"openai":{"daily":3,"weekly":9,"monthly":30},"gemini":{"daily":null}}}');if r ? 'error' then raise exception 'default quotas rejected %',r;end if;
 insert into auth.users(id,email,raw_app_meta_data) values('88888888-8888-4888-8888-888888888887','quota-signup@example.com','{}');
 if not exists(select 1 from public.s2a_platform_quotas where user_id='88888888-8888-4888-8888-888888888887' and platform='openai' and daily_limit_usd=3) or exists(select 1 from public.s2a_platform_quotas where user_id='88888888-8888-4888-8888-888888888887' and platform='gemini') then raise exception 'registration defaults not snapshotted';end if;
 r:=public.s2a_settings_update('{"default_platform_quotas":{"openai":{"daily":4}}}');if r ? 'error' or (select daily_limit_usd from public.s2a_platform_quotas where user_id='88888888-8888-4888-8888-888888888887')<>3 then raise exception 'global default change modified existing user';end if;
 r:=public.s2a_settings_update('{"default_platform_quotas":{"openai":{"daily":-1}}}');if r->>'status'<>'400' or (select data->'default_platform_quotas'->'openai'->>'daily' from public.s2a_settings)<>'4' then raise exception 'invalid defaults saved';end if;
end $$;
set local role service_role;
select public.s2a_platform_quotas_set('88888888-8888-4888-8888-888888888881','[{"platform":"openai","daily_limit_usd":1}]');
select public.s2a_user_rpm_status('88888888-8888-4888-8888-888888888881');
set local role authenticated;
do $$ begin
 begin perform * from public.s2a_platform_quotas;raise exception 'user read quota table';exception when insufficient_privilege then null;end;
 begin perform public.s2a_platform_quotas_get('88888888-8888-4888-8888-888888888881');raise exception 'user read arbitrary quotas';exception when insufficient_privilege then null;end;
 begin perform public.s2a_platform_quotas_set('88888888-8888-4888-8888-888888888881','[]');raise exception 'user wrote quotas';exception when insufficient_privilege then null;end;
end $$;
rollback;
