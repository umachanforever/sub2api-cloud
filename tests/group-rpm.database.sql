begin;
insert into auth.users(id,email,encrypted_password,raw_user_meta_data,raw_app_meta_data) values
 ('88888888-8888-4888-8888-888888888881','rates@example.com','private-password','{"username":"Rates user"}','{"s2a_notes":"Private admin note"}'),
 ('88888888-8888-4888-8888-888888888882','other-rates@example.com','private-password','{}','{}');
insert into public.s2a_groups(id,name,rate_multiplier) values
 ('88888888-8888-4888-8888-888888888883','Rate group',0),('88888888-8888-4888-8888-888888888884','Other rate group',2);
insert into public.s2a_accounts(id,group_id,name,account_fingerprint,ciphertext,iv) values
 ('88888888-8888-4888-8888-888888888885','88888888-8888-4888-8888-888888888883','Rate account','rate-fingerprint','encrypted','iv');
insert into public.s2a_keys(id,user_id,group_id,name,key_hash,key_prefix) values
 ('88888888-8888-4888-8888-888888888886','88888888-8888-4888-8888-888888888881','88888888-8888-4888-8888-888888888883','Rates',repeat('8',64),'prefix');
do $$ declare u uuid:='88888888-8888-4888-8888-888888888881';other uuid:='88888888-8888-4888-8888-888888888882';g uuid:='88888888-8888-4888-8888-888888888883';r jsonb;l uuid;begin
 perform public.s2a_user_configure(u,array[g],10,0,0);
 update public.s2a_groups set rpm_limit=1 where id=g;
 r:=public.s2a_acquire(repeat('8',64),'gpt-4.1',gen_random_uuid(),'{}',true,null,'{}');l:=(r->>'lease_id')::uuid;
 if l is null then raise exception 'first group request failed %',r;end if;perform public.s2a_finish(l,200,'completed',1,1);
 r:=public.s2a_acquire(repeat('8',64),'gpt-4.1',gen_random_uuid(),'{}',true,null,'{}');
 if r->>'error'<>'group_rate_limit_exceeded' then raise exception 'group default not enforced %',r;end if;
 perform public.s2a_group_rates_set(g,jsonb_build_array(jsonb_build_object('user_id',u,'rate_multiplier',0.5)));
 perform public.s2a_group_rpm_set(g,jsonb_build_array(jsonb_build_object('user_id',u,'rpm_override',2)));
 r:=public.s2a_acquire(repeat('8',64),'gpt-4.1',gen_random_uuid(),'{}',true,null,'{}');l:=(r->>'lease_id')::uuid;
 if l is null then raise exception 'override did not replace default %',r;end if;perform public.s2a_finish(l,200,'completed',1,1);
 r:=public.s2a_acquire(repeat('8',64),'gpt-4.1',gen_random_uuid(),'{}',true,null,'{}');
 if r->>'error'<>'group_rate_limit_exceeded' then raise exception 'override not enforced %',r;end if;
 r:=public.s2a_group_rpm_set(g,jsonb_build_array(jsonb_build_object('user_id',u,'rpm_override',0),jsonb_build_object('user_id',gen_random_uuid(),'rpm_override',0)));
 if r->>'status'<>'404' or (select rpm_override from public.s2a_user_group_rpm where user_id=u and group_id=g)<>2 then raise exception 'invalid batch mutated RPM';end if;
 r:=public.s2a_group_rpm_set(g,jsonb_build_array(jsonb_build_object('user_id',u,'rpm_override',0.5)));
 if r->>'status'<>'400' then raise exception 'fractional RPM rounded';end if;
 perform public.s2a_group_rpm_set(g,jsonb_build_array(jsonb_build_object('user_id',u,'rpm_override',0)));
 perform public.s2a_user_limits_set(array[u],false,null,2);
 r:=public.s2a_acquire(repeat('8',64),'gpt-4.1',gen_random_uuid(),'{}',true,null,'{}');
 if r->>'error'<>'user_rate_limit_exceeded' then raise exception 'zero override bypassed global cap %',r;end if;
 perform public.s2a_user_limits_set(array[u],false,null,0);
 r:=public.s2a_acquire(repeat('8',64),'gpt-4.1',gen_random_uuid(),'{}',true,null,'{}');l:=(r->>'lease_id')::uuid;
 if l is null then raise exception 'zero override did not disable group limit %',r;end if;perform public.s2a_finish(l,200,'completed',1,1);
 perform public.s2a_group_rates_set(g,'[]');
 if (select rpm_override from public.s2a_user_group_rpm where user_id=u and group_id=g)<>0 then raise exception 'rate clear removed RPM';end if;
 r:=public.s2a_group_rates_list(g);if jsonb_array_length(r)<>1 or r->0->>'rpm_override'<>'0' or r->0->'rate_multiplier'<>'null'::jsonb then raise exception 'RPM-only admin list missing %',r;end if;
 perform public.s2a_group_rates_set(g,jsonb_build_array(jsonb_build_object('user_id',u,'rate_multiplier',0.5)));
 perform public.s2a_group_rpm_set(g,'[]');
 if (select rate_multiplier from public.s2a_user_group_rates where user_id=u and group_id=g)<>0.5 then raise exception 'RPM clear removed rate';end if;
 update public.s2a_user_group_windows set window_start=now()-interval '61 seconds' where user_id=u and group_id=g;
 r:=public.s2a_acquire(repeat('8',64),'gpt-4.1',gen_random_uuid(),'{}',true,null,'{}');l:=(r->>'lease_id')::uuid;
 if l is null or (select window_count from public.s2a_user_group_windows where user_id=u and group_id=g)<>1 then raise exception 'window did not reset %',r;end if;perform public.s2a_finish(l,200,'completed',1,1);
 r:=public.s2a_acquire(repeat('8',64),'gpt-4.1',gen_random_uuid(),'{}',false,null,'{}');l:=(r->>'lease_id')::uuid;
 if l is null or (select window_count from public.s2a_user_group_windows where user_id=u and group_id=g)<>1 then raise exception 'retry consumed RPM %',r;end if;perform public.s2a_finish(l,200,'completed',1,1);
 r:=public.s2a_group_create('RPM created group',u,'openai',1,'{"rpm_limit":17}');if r->>'rpm_limit'<>'17' then raise exception 'create dropped RPM';end if;
end $$;
set local role service_role;
select public.s2a_group_rpm_set('88888888-8888-4888-8888-888888888883','[{"user_id":"88888888-8888-4888-8888-888888888882","rpm_override":0}]');
set local role authenticated;
do $$ begin
 begin perform * from public.s2a_user_group_rpm;raise exception 'user can read RPM table';exception when insufficient_privilege then null;end;
 begin perform public.s2a_group_rpm_set('88888888-8888-4888-8888-888888888883','[]');raise exception 'user can write RPM';exception when insufficient_privilege then null;end;
end $$;
rollback;
