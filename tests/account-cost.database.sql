begin;
insert into auth.users(id,email) values('cccccccc-cccc-4ccc-8ccc-ccccccccccc1','account-cost@example.com');
insert into public.s2a_groups(id,name,rate_multiplier) values('cccccccc-cccc-4ccc-8ccc-ccccccccccc2','Account cost',2);
insert into public.s2a_memberships(user_id,group_id) values('cccccccc-cccc-4ccc-8ccc-ccccccccccc1','cccccccc-cccc-4ccc-8ccc-ccccccccccc2');
insert into public.s2a_accounts(id,group_id,name,account_fingerprint,ciphertext,iv,rate_multiplier,load_factor,concurrency) values
 ('cccccccc-cccc-4ccc-8ccc-ccccccccccc3','cccccccc-cccc-4ccc-8ccc-ccccccccccc2','Account first','account-cost-first','encrypted','iv',0.25,1,3),
 ('cccccccc-cccc-4ccc-8ccc-ccccccccccc4','cccccccc-cccc-4ccc-8ccc-ccccccccccc2','Account second','account-cost-second','encrypted','iv',1,3,3);
insert into public.s2a_keys(id,user_id,group_id,name,key_hash,key_prefix,concurrency) values('cccccccc-cccc-4ccc-8ccc-ccccccccccc5','cccccccc-cccc-4ccc-8ccc-ccccccccccc1','cccccccc-cccc-4ccc-8ccc-ccccccccccc2','Costs',repeat('c',64),'prefix',20);
do $$ declare u uuid:='cccccccc-cccc-4ccc-8ccc-ccccccccccc1';g uuid:='cccccccc-cccc-4ccc-8ccc-ccccccccccc2';a uuid:='cccccccc-cccc-4ccc-8ccc-ccccccccccc3';b uuid:='cccccccc-cccc-4ccc-8ccc-ccccccccccc4';k uuid:='cccccccc-cccc-4ccc-8ccc-ccccccccccc5';r jsonb;l uuid;first uuid;cost numeric;begin
 perform public.s2a_wallet_update(u,10,'set');perform public.s2a_user_limits_set(array[u],false,100,0);
 update public.s2a_accounts set status='disabled' where id=b;
 r:=public.s2a_acquire(repeat('c',64),'gpt-4.1',gen_random_uuid(),'{}',true,null,'{}');l:=(r->>'lease_id')::uuid;first:=l;
 if l is null or (select (billing->>'account_rate_multiplier')::numeric from public.s2a_leases where id=l)<>0.25 then raise exception 'account snapshot absent %',r;end if;
 update public.s2a_accounts set rate_multiplier=10 where id=a;
 perform public.s2a_finish(l,200,'completed',100,10,0,0);perform public.s2a_finish(l,200,'completed',100,10,0,0);
 if not exists(select 1 from public.s2a_usage where id=l and total_cost=0.00028 and actual_cost=0.00056 and account_rate_multiplier=0.25 and account_stats_cost=0.00028) then raise exception 'account rate altered user billing or snapshot';end if;
 if (select balance from public.s2a_wallets where user_id=u)<>9.99944 then raise exception 'wallet used account multiplier';end if;
 r:=public.s2a_account_today_stats(array[a,b,a]);if r->'stats'->a::text->>'requests'<>'1' or (r->'stats'->a::text->>'cost')::numeric<>0.00007 or (r->'stats'->a::text->>'user_cost')::numeric<>0.00056 or r->'stats'->b::text->>'requests'<>'0' then raise exception 'today stats incorrect %',r;end if;
 r:=public.s2a_dashboard(u,now()-interval '1 day',now()+interval '1 second','Asia/Shanghai',null,null,'day',true,'{}');if r->'summary' ? 'account_cost' or r->'models'->0 ? 'account_cost' or r->'daily'->0 ? 'account_cost' then raise exception 'user dashboard exposed account cost';end if;
 r:=public.s2a_dashboard(null,now()-interval '1 day',now()+interval '1 second','Asia/Shanghai',null,null,'day',true,jsonb_build_object('account_id',a,'include_account_cost',true));if (r->'summary'->>'account_cost')::numeric<>0.00007 or (r->'models'->0->>'account_cost')::numeric<>0.00007 then raise exception 'admin costs missing %',r;end if;
 update public.s2a_accounts set rate_multiplier=0 where id=a;
 r:=public.s2a_acquire(repeat('c',64),'gpt-4.1',gen_random_uuid(),'{}',true,null,'{}');l:=(r->>'lease_id')::uuid;perform public.s2a_finish(l,200,'completed',100,10,0,0);
 if not exists(select 1 from public.s2a_usage where id=l and account_rate_multiplier=0 and actual_cost=0.00056 and account_stats_cost=0.00028) then raise exception 'zero multiplier changed user cost';end if;
 r:=public.s2a_acquire(repeat('c',64),'gpt-4.1',gen_random_uuid(),'{}',true,null,'{}');l:=(r->>'lease_id')::uuid;perform public.s2a_finish(l,200,'incomplete');
 if not exists(select 1 from public.s2a_usage where id=l and total_cost is null and account_stats_cost is null) then raise exception 'unknown account cost fabricated';end if;
 r:=public.s2a_account_today_stats(array[a]);if (r->'stats'->a::text->>'cost')::numeric<>0.00007 or r->'stats'->a::text->>'unknown_cost_attempts'<>'1' then raise exception 'unknown cost stats incorrect';end if;
 insert into public.s2a_usage(id,request_id,account_id,key_id,user_id,model,status,outcome,duration_ms,total_cost,actual_cost) values(gen_random_uuid(),gen_random_uuid(),a,k,u,'legacy',200,'completed',1,0.0001,0.0002);
 r:=public.s2a_account_today_stats(array[a]);if (r->'stats'->a::text->>'cost')::numeric<>0.00017 then raise exception 'legacy multiplier did not default to one';end if;
 update public.s2a_accounts set status='active',priority=50,last_used_at=null where id in(a,b);
 insert into public.s2a_leases(request_id,account_id,key_id,model) values(gen_random_uuid(),a,k,'load'),(gen_random_uuid(),b,k,'load');
 r:=public.s2a_acquire(repeat('c',64),'gpt-4.1',gen_random_uuid(),'{}',true,null,'{}');if r->'account'->>'id'<>b::text then raise exception 'load ratio not used %',r;end if;
 insert into public.s2a_leases(request_id,account_id,key_id,model) values(gen_random_uuid(),b,k,'load');
 r:=public.s2a_acquire(repeat('c',64),'gpt-4.1',gen_random_uuid(),'{}',true,null,'{}');if r->'account'->>'id'<>a::text then raise exception 'load factor bypassed hard concurrency %',r;end if;
 delete from public.s2a_leases where key_id=k;
 r:=public.s2a_account_save(a,'{"rate_multiplier":3,"load_factor":null}',array[g]);if r ? 'error' or not exists(select 1 from public.s2a_accounts where id=a and rate_multiplier=3 and load_factor is null) then raise exception 'metadata update failed %',r;end if;
 r:=public.s2a_apikey_account_update(a,'openai',1,repeat('f',64),'new','iv','{"rate_multiplier":2,"load_factor":5}');if r->>'error'<>'account_provider_type_mismatch' then raise exception 'OAuth credentials were rotated as API key';end if;
 update public.s2a_accounts set type='apikey' where id=a;
 r:=public.s2a_apikey_account_update(a,'openai',1,repeat('f',64),'new','iv','{"rate_multiplier":2,"load_factor":5}');if r ? 'error' or not exists(select 1 from public.s2a_accounts where id=a and rate_multiplier=2 and load_factor=5 and ciphertext='new') then raise exception 'rotation dropped factors %',r;end if;
 begin update public.s2a_accounts set load_factor=0 where id=a;raise exception 'zero load factor stored';exception when check_violation then null;end;
 begin update public.s2a_accounts set rate_multiplier=-1 where id=a;raise exception 'negative rate stored';exception when check_violation then null;end;
 r:=public.s2a_account_today_stats('{}');if r<>'{"stats":{}}'::jsonb then raise exception 'empty batch failed';end if;
end $$;
set local role service_role;
select public.s2a_account_today_stats(array['cccccccc-cccc-4ccc-8ccc-ccccccccccc3'::uuid]);
set local role authenticated;
do $$ begin
 begin perform public.s2a_account_today_stats('{}');raise exception 'user read private stats';exception when insufficient_privilege then null;end;
end $$;
rollback;
