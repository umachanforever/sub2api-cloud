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
do $$ declare u uuid:='88888888-8888-4888-8888-888888888881';other uuid:='88888888-8888-4888-8888-888888888882';g uuid:='88888888-8888-4888-8888-888888888883';g2 uuid:='88888888-8888-4888-8888-888888888884'; r jsonb;l uuid;begin
 r:=public.s2a_group_rates_set(g,jsonb_build_array(jsonb_build_object('user_id',u,'rate_multiplier',0.5)));
 if r->>'ok'<>'true' then raise exception 'rate replacement failed %',r;end if;
 r:=public.s2a_acquire(repeat('8',64),'gpt-4.1',gen_random_uuid(),'{}',true,null,'{}');if r->>'error'<>'group_access_denied' then raise exception 'rate override granted membership';end if;
 r:=public.s2a_user_configure(u,array[g],10,null,null,null,jsonb_build_object(g2,0.75));if r ? 'error' then raise exception 'user rates configuration failed %',r;end if;
 if (select count(*) from public.s2a_user_group_rates where user_id=u)<>2 then raise exception 'incremental user patch replaced unrelated rate';end if;
 r:=public.s2a_acquire(repeat('8',64),'gpt-4.1',gen_random_uuid(),'{}',true,null,'{}');l:=(r->>'lease_id')::uuid;
 if l is null or (select billing->>'rate_multiplier' from public.s2a_leases where id=l)<>'0.500000' then raise exception 'request did not capture dedicated multiplier %',r;end if;
 perform public.s2a_group_rates_set(g,jsonb_build_array(jsonb_build_object('user_id',u,'rate_multiplier',0.25)));
 perform public.s2a_finish(l,200,'completed',100,10);
 if not exists(select 1 from public.s2a_usage where id=l and total_cost=0.00028 and actual_cost=0.00014 and rate_multiplier=0.5) then raise exception 'in-flight request repriced';end if;
 r:=public.s2a_acquire(repeat('8',64),'gpt-4.1',gen_random_uuid(),'{}',true,null,'{}');l:=(r->>'lease_id')::uuid;perform public.s2a_finish(l,200,'completed',100,10);
 if not exists(select 1 from public.s2a_usage where id=l and actual_cost=0.00007 and rate_multiplier=0.25) or (select balance from public.s2a_wallets where user_id=u)<>9.99979 then raise exception 'updated multiplier did not settle correctly';end if;
 r:=public.s2a_group_rates_set(g,jsonb_build_array(jsonb_build_object('user_id',u,'rate_multiplier',0.5),jsonb_build_object('user_id',gen_random_uuid(),'rate_multiplier',1)));
 if r->>'status'<>'404' or (select rate_multiplier from public.s2a_user_group_rates where user_id=u and group_id=g)<>0.25 then raise exception 'failed batch left partial rates';end if;
 r:=public.s2a_user_configure(u,'{}',0,0,0,null,jsonb_build_object(gen_random_uuid(),0.1));
 if r->>'status'<>'404' or (select balance from public.s2a_wallets where user_id=u)<>9.99979 or not exists(select 1 from public.s2a_memberships where user_id=u and group_id=g) then raise exception 'invalid rate patch changed balance or grants';end if;
 perform public.s2a_user_configure(u,null,null,null,null,null,jsonb_build_object(g2,null));
 if (select count(*) from public.s2a_user_group_rates where user_id=u)<>1 then raise exception 'null rate did not delete exact override';end if;
 r:=public.s2a_wallet_get(u);if r->'group_rates'->>g::text<>'0.250000' then raise exception 'profile rates not returned';end if;
 r:=public.s2a_group_rates_list(g);if r->0->>'user_name'<>'Rates user' or r->0->>'user_notes'<>'Private admin note' or r::text like '%private-password%' then raise exception 'admin list metadata or credential isolation incorrect';end if;
 perform public.s2a_group_rates_set(g,jsonb_build_array(jsonb_build_object('user_id',other,'rate_multiplier',0.9)));
 if exists(select 1 from public.s2a_user_group_rates where user_id=u and group_id=g) then raise exception 'group replacement retained omitted user';end if;
 perform public.s2a_user_configure(u,null,null,null,null,null,jsonb_build_object(g,0.25));
 update public.s2a_groups set rate_multiplier=0 where id=g;perform public.s2a_wallet_update(u,0,'set');
 r:=public.s2a_acquire(repeat('8',64),'gpt-4.1',gen_random_uuid(),'{}',true,null,'{}');if r->>'error'<>'insufficient_balance' then raise exception 'positive override on free group bypassed wallet';end if;
 perform public.s2a_user_configure(u,null,null,null,null,null,'{}');
 r:=public.s2a_acquire(repeat('8',64),'gpt-4.1',gen_random_uuid(),'{}',true,null,'{}');l:=(r->>'lease_id')::uuid;
 if l is null then raise exception 'default free multiplier blocked %',r;end if;perform public.s2a_finish(l,200,'completed',100,10);
 if (select actual_cost from public.s2a_usage where id=l)<>0 or (select balance from public.s2a_wallets where user_id=u)<>0 then raise exception 'free fallback charged wallet';end if;
 perform public.s2a_group_rates_set(g,'[]');if exists(select 1 from public.s2a_user_group_rates where group_id=g) then raise exception 'clear group rates failed';end if;
 update public.s2a_groups set subscription_type='subscription',rate_multiplier=3,daily_limit_usd=1 where id=g;
 r:=public.s2a_subscription_assign(u,g,30);if r ? 'error' then raise exception 'subscription setup failed %',r;end if;
 perform public.s2a_user_configure(u,null,null,null,null,null,jsonb_build_object(g,0.5));
 r:=public.s2a_acquire(repeat('8',64),'gpt-4.1',gen_random_uuid(),'{}',true,null,'{}');l:=(r->>'lease_id')::uuid;
 if l is null then raise exception 'dedicated subscription rate required wallet credit %',r;end if;perform public.s2a_finish(l,200,'completed',100,10);
 if (select daily_usage_usd from public.s2a_subscriptions where user_id=u and group_id=g)<>0.00014 or (select balance from public.s2a_wallets where user_id=u)<>0 then raise exception 'dedicated subscription rate did not charge plan quota';end if;

end $$;
set local role service_role;
select public.s2a_group_rates_set('88888888-8888-4888-8888-888888888883','[{"user_id":"88888888-8888-4888-8888-888888888882","rate_multiplier":0.9}]');
select public.s2a_group_rates_list('88888888-8888-4888-8888-888888888883');
reset role;
set local role authenticated;
do $$ begin
 begin perform public.s2a_group_rates_list('88888888-8888-4888-8888-888888888883');raise exception 'user can read group rates';exception when insufficient_privilege then null;end;
 begin perform * from public.s2a_user_group_rates;raise exception 'user can read rates table';exception when insufficient_privilege then null;end;
end $$;
rollback;
