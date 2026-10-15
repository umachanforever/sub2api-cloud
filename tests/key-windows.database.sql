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
do $$ declare u uuid:='88888888-8888-4888-8888-888888888881';other uuid:='88888888-8888-4888-8888-888888888882';g uuid:='88888888-8888-4888-8888-888888888883';selected_key uuid:='88888888-8888-4888-8888-888888888886';r jsonb;l uuid; charged numeric;record jsonb;begin
 perform public.s2a_user_configure(u,array[g],10,0,0);update public.s2a_groups set rate_multiplier=1 where id=g;
 update public.s2a_keys set rate_limit_5h=0.00028,rate_limit_1d=1,rate_limit_7d=7 where id=selected_key;
 r:=public.s2a_acquire(repeat('8',64),'gpt-4.1',gen_random_uuid(),'{}',true,null,'{}');l:=(r->>'lease_id')::uuid;
 if l is null then raise exception 'initial window blocked %',r;end if;
 perform public.s2a_finish(l,200,'completed',100,10);perform public.s2a_finish(l,200,'completed',100,10);
 if not exists(select 1 from public.s2a_keys where id=selected_key and usage_5h=0.00028 and usage_1d=0.00028 and usage_7d=0.00028 and window_5h_start=now() and window_1d_start=date_trunc('day',now() at time zone 'UTC') at time zone 'UTC') then raise exception 'window usage not atomic or finish doubled';end if;
 r:=public.s2a_acquire(repeat('8',64),'gpt-4.1',gen_random_uuid(),'{}',true,null,'{}');if r->>'error'<>'api_key_rate_5h_exceeded' then raise exception '5h cap ignored %',r;end if;
 update public.s2a_keys set window_5h_start=now()-interval '6 hours' where id=selected_key;
 r:=public.s2a_acquire(repeat('8',64),'gpt-4.1',gen_random_uuid(),'{}',true,null,'{}');l:=(r->>'lease_id')::uuid;
 if l is null then raise exception 'expired 5h cap blocked %',r;end if;perform public.s2a_finish(l,200,'completed',100,10);
 if not exists(select 1 from public.s2a_keys where id=selected_key and usage_5h=0.00028 and usage_1d=0.00056 and usage_7d=0.00056) then raise exception 'expiration reset unrelated windows';end if;
 update public.s2a_keys set rate_limit_5h=0,rate_limit_1d=0.00056 where id=selected_key;
 r:=public.s2a_acquire(repeat('8',64),'gpt-4.1',gen_random_uuid(),'{}',true,null,'{}');if r->>'error'<>'api_key_rate_1d_exceeded' then raise exception '1d cap ignored';end if;
 update public.s2a_keys set rate_limit_1d=0,rate_limit_7d=0.00056 where id=selected_key;
 r:=public.s2a_acquire(repeat('8',64),'gpt-4.1',gen_random_uuid(),'{}',true,null,'{}');if r->>'error'<>'api_key_rate_7d_exceeded' then raise exception '7d cap ignored';end if;
 update public.s2a_keys set usage_5h=0,usage_1d=0,usage_7d=0,window_5h_start=null,window_1d_start=null,window_7d_start=null where id=selected_key;
 r:=public.s2a_acquire(repeat('8',64),'gpt-4.1',gen_random_uuid(),'{}',true,null,'{}');l:=(r->>'lease_id')::uuid;
 if l is null then raise exception 'manual reset did not release key';end if;perform public.s2a_finish(l,200,'completed',100,10);
 if not exists(select 1 from public.s2a_keys where id=selected_key and usage_7d=0.00028 and monetary_used=0.00084) or (select count(*) from public.s2a_usage where key_id='88888888-8888-4888-8888-888888888886')=0 then raise exception 'reset erased total monetary usage';end if;
 update public.s2a_keys set rate_limit_7d=0,window_1d_start=now()-interval '2 days',window_7d_start=now()-interval '8 days' where id=selected_key;
 perform public.s2a_group_rates_set(g,jsonb_build_array(jsonb_build_object('user_id',u,'rate_multiplier',0.5)));
 r:=public.s2a_acquire(repeat('8',64),'gpt-4.1',gen_random_uuid(),'{}',true,null,'{}');l:=(r->>'lease_id')::uuid;perform public.s2a_finish(l,200,'completed',100,10);
 if not exists(select 1 from public.s2a_keys where id=selected_key and usage_1d=0.00014 and usage_7d=0.00014) then raise exception 'expired windows not charged at effective rate';end if;
 charged:=(select usage_5h from public.s2a_keys where id=selected_key);
 r:=public.s2a_acquire(repeat('8',64),'gpt-4.1',gen_random_uuid(),'{}',true,null,'{}');l:=(r->>'lease_id')::uuid;perform public.s2a_finish(l,200,'completed');
 if (select usage_5h from public.s2a_keys where id=selected_key)<>charged then raise exception 'unknown usage charged window';end if;
 update public.s2a_groups set subscription_type='subscription' where id=g;perform public.s2a_subscription_assign(u,g,30);
 charged:=(select usage_7d from public.s2a_keys where id=selected_key);
 r:=public.s2a_acquire(repeat('8',64),'gpt-4.1',gen_random_uuid(),'{}',true,null,'{}');l:=(r->>'lease_id')::uuid;
 if l is null then raise exception 'subscription window scheduling failed %',r;end if;perform public.s2a_finish(l,200,'completed',100,10);
 if (select usage_7d from public.s2a_keys where id=selected_key)<>charged+0.00014 or (select daily_usage_usd from public.s2a_subscriptions where user_id=u and group_id=g)<>0.00014 then raise exception 'subscription charge did not consume key window';end if;
 record:=jsonb_build_object('user_id',u,'group_id',g,'name','Custom','key_hash',repeat('c',64),'key_prefix','cust','rate_limit_5h',1);
 r:=public.s2a_custom_key_create(u,true,record);if r ? 'error' or r->>'rate_limit_5h'<>'1.00000000' then raise exception 'custom create failed %',r;end if;
 r:=public.s2a_custom_key_create(u,true,record);if r->>'status'<>'409' then raise exception 'duplicate custom key not blocked';end if;
 if (select failures from public.s2a_key_create_attempts where user_id=u)<>1 then raise exception 'duplicate not counted';end if;
 for i in 1..19 loop r:=public.s2a_custom_key_create(u,false);if r->>'status'<>'400' then raise exception 'failed attempt not counted';end if;end loop;
 r:=public.s2a_custom_key_create(u,true,record||jsonb_build_object('key_hash',repeat('d',64)));if r->>'status'<>'429' then raise exception 'custom attempts not throttled';end if;
 update public.s2a_key_create_attempts set window_start=now()-interval '61 minutes' where user_id=u;
 r:=public.s2a_custom_key_create(u,true,record||jsonb_build_object('key_hash',repeat('d',64)));if r ? 'error' then raise exception 'custom throttle did not expire';end if;
 r:=public.s2a_custom_key_create(other,true,record);if r->>'error'<>'invalid_key_owner' then raise exception 'custom owner spoof allowed';end if;
 r:=public.s2a_custom_key_create(other,true,record||jsonb_build_object('user_id',other,'key_hash',repeat('e',64)));if r->>'error'<>'group_access_denied' then raise exception 'custom create bypassed group access';end if;
 r:=public.s2a_custom_key_create(u,true,record||'{"usage_5h":0}');if r->>'status'<>'400' then raise exception 'custom counters writable';end if;
end $$;
set local role service_role;
select public.s2a_custom_key_create('88888888-8888-4888-8888-888888888881',false);
set local role authenticated;
do $$ begin
 begin perform * from public.s2a_key_create_attempts;raise exception 'user can inspect custom attempts';exception when insufficient_privilege then null;end;
 begin perform public.s2a_custom_key_create('88888888-8888-4888-8888-888888888881',false);raise exception 'user can create raw custom keys';exception when insufficient_privilege then null;end;
end $$;
rollback;
