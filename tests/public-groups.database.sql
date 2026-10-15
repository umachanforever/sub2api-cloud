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
do $$ declare u uuid:='88888888-8888-4888-8888-888888888881';other uuid:='88888888-8888-4888-8888-888888888882';g uuid:='88888888-8888-4888-8888-888888888883';g2 uuid:='88888888-8888-4888-8888-888888888884';r jsonb;l uuid;begin
 if public.s2a_group_can_bind(u,g) then raise exception 'existing groups opened on upgrade';end if;
 update public.s2a_groups set is_exclusive=false where id=g;
 if not public.s2a_group_can_bind(u,g) or public.s2a_group_can_bind(u,g2) then raise exception 'public and exclusive access incorrect';end if;
 r:=public.s2a_acquire(repeat('8',64),'gpt-4.1',gen_random_uuid(),'{}',true,null,'{}');l:=(r->>'lease_id')::uuid;
 if l is null then raise exception 'public request failed %',r;end if;perform public.s2a_finish(l,200,'completed',1,1);
 r:=public.s2a_user_configure(u,null,null,null,null,null,null,true);
 if r ? 'error' or public.s2a_group_can_bind(u,g) then raise exception 'restriction-only edit ignored %',r;end if;
 r:=public.s2a_acquire(repeat('8',64),'gpt-4.1',gen_random_uuid(),'{}',true,null,'{}');
 if r->>'error'<>'group_access_denied' then raise exception 'existing key bypassed restriction';end if;
 r:=public.s2a_user_configure(u,array[g],null,null,null,null,null,true);
 if not public.s2a_group_can_bind(u,g) then raise exception 'restricted public allowlist ignored';end if;
 update public.s2a_groups set is_exclusive=true where id=g;
 if not public.s2a_group_can_bind(u,g) then raise exception 'exclusive allowlist ignored';end if;
 update public.s2a_groups set enabled=false where id=g;
 if public.s2a_group_can_bind(u,g) then raise exception 'disabled group bindable';end if;
 update public.s2a_groups set enabled=true,subscription_type='subscription' where id=g;
 if public.s2a_group_can_bind(u,g) then raise exception 'membership granted subscription access';end if;
 perform public.s2a_subscription_assign(u,g,30);
 delete from public.s2a_memberships where user_id=u and group_id=g;
 if not public.s2a_group_can_bind(u,g) then raise exception 'subscription depended on membership';end if;
 r:=public.s2a_groups_available(u);if not exists(select 1 from jsonb_array_elements(r) e where e->>'id'=g::text) then raise exception 'subscribed group missing';end if;
 r:=public.s2a_acquire(repeat('8',64),'gpt-4.1',gen_random_uuid(),'{}',true,null,'{}');l:=(r->>'lease_id')::uuid;
 if l is null then raise exception 'subscription request depended on membership %',r;end if;perform public.s2a_finish(l,200,'completed',1,1);
 update public.s2a_subscriptions set starts_at=now()+interval '1 hour' where user_id=u and group_id=g;
 if public.s2a_group_can_bind(u,g) then raise exception 'future subscription bindable';end if;
 update public.s2a_subscriptions set starts_at=now()-interval '2 days',expires_at=now()-interval '1 day' where user_id=u and group_id=g;
 if public.s2a_group_can_bind(u,g) then raise exception 'expired subscription bindable';end if;
 r:=public.s2a_acquire(repeat('8',64),'gpt-4.1',gen_random_uuid(),'{}',true,null,'{}');if r->>'error'<>'subscription_inactive' then raise exception 'expired subscription accepted %',r;end if;
 r:=public.s2a_user_configure(u,null,null,null,null,null,null,false);
 insert into public.s2a_groups(name,is_exclusive) select 'Public pagination '||n,false from generate_series(1,105) n;
 r:=public.s2a_groups_available(u);if (select count(*) from jsonb_array_elements(r) e where e->>'name' like 'Public pagination %')<>105 then raise exception 'available group list truncated';end if;
 r:=public.s2a_wallet_get(u);if r->>'restrict_public_groups'<>'false' then raise exception 'profile missing restriction flag';end if;
 r:=public.s2a_user_configure(u,null,null,null,null,null,null,true);
 r:=public.s2a_groups_available(u);if jsonb_array_length(r)<>0 then raise exception 'restriction leaked public groups %',r;end if;
 r:=public.s2a_group_create('New public group',other);if r->>'is_exclusive'<>'false' then raise exception 'new groups not public';end if;
 r:=public.s2a_group_create('New exclusive group',other,'openai',1,'{"is_exclusive":true}');if r->>'is_exclusive'<>'true' then raise exception 'creation ignored exclusive flag';end if;
 perform public.s2a_wallet_update(u,10,'set');update public.s2a_wallets set frozen_balance=5 where user_id=u;
 r:=public.s2a_user_configure(u,null,1,null,null,null,null,false);
 if not(r ? 'error') or (select restrict_public_groups from public.s2a_user_limits where user_id=u)<>true then raise exception 'failed balance update changed access restriction';end if;
end $$;
set local role service_role;
select public.s2a_groups_available('88888888-8888-4888-8888-888888888881');
set local role authenticated;
do $$ begin
 begin perform public.s2a_groups_available('88888888-8888-4888-8888-888888888881');raise exception 'direct user visibility lookup allowed';exception when insufficient_privilege then null;end;
 begin perform public.s2a_group_can_bind('88888888-8888-4888-8888-888888888881','88888888-8888-4888-8888-888888888883');raise exception 'direct user group lookup allowed';exception when insufficient_privilege then null;end;
end $$;
rollback;
