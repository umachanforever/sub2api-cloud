begin;
insert into auth.users(id) values('dddddddd-dddd-4ddd-8ddd-ddddddddddd1');
insert into public.s2a_groups(id,name,platform) values
 ('dddddddd-dddd-4ddd-8ddd-ddddddddddd2','Source','openai'),
 ('dddddddd-dddd-4ddd-8ddd-ddddddddddd3','Destination','openai'),
 ('dddddddd-dddd-4ddd-8ddd-ddddddddddd4','Other provider','anthropic');
do $$ declare r jsonb; begin
 r := public.s2a_user_configure('dddddddd-dddd-4ddd-8ddd-ddddddddddd1',array['dddddddd-dddd-4ddd-8ddd-ddddddddddd2']::uuid[],10.25,2,10);
 if r ? 'error' then raise exception 'user configuration rejected: %',r; end if;
 if not exists(select 1 from public.s2a_memberships where user_id='dddddddd-dddd-4ddd-8ddd-ddddddddddd1' and group_id='dddddddd-dddd-4ddd-8ddd-ddddddddddd2') then raise exception 'groups not configured'; end if;
 r := public.s2a_user_configure('dddddddd-dddd-4ddd-8ddd-ddddddddddd1',array[gen_random_uuid()],0,0,0);
 if r->>'error' is distinct from 'invalid_allowed_groups' then raise exception 'invalid group accepted'; end if;
 if (select balance from public.s2a_wallets where user_id='dddddddd-dddd-4ddd-8ddd-ddddddddddd1')<>10.25 then raise exception 'rejected update modified wallet'; end if;
 update public.s2a_wallets set frozen_balance=5 where user_id='dddddddd-dddd-4ddd-8ddd-ddddddddddd1';
 r := public.s2a_user_configure('dddddddd-dddd-4ddd-8ddd-ddddddddddd1','{}',0,0,0);
 if r->>'error' is distinct from 'insufficient_balance' then raise exception 'frozen balance ignored: %',r; end if;
 if (select concurrency from public.s2a_user_limits where user_id='dddddddd-dddd-4ddd-8ddd-ddddddddddd1')<>2 then raise exception 'rejected update modified limits'; end if;
 if not exists(select 1 from public.s2a_memberships where user_id='dddddddd-dddd-4ddd-8ddd-ddddddddddd1') then raise exception 'rejected update revoked groups'; end if;
end $$;
insert into public.s2a_keys(user_id,group_id,name,key_hash,key_prefix) values
 ('dddddddd-dddd-4ddd-8ddd-ddddddddddd1','dddddddd-dddd-4ddd-8ddd-ddddddddddd2','Key',repeat('d',64),'prefix');
do $$ declare r jsonb; begin
 r := public.s2a_user_replace_group('dddddddd-dddd-4ddd-8ddd-ddddddddddd1','dddddddd-dddd-4ddd-8ddd-ddddddddddd2','dddddddd-dddd-4ddd-8ddd-ddddddddddd4');
 if r->>'error' is distinct from 'group_platform_mismatch' then raise exception 'cross-platform replacement accepted'; end if;
 r := public.s2a_user_replace_group('dddddddd-dddd-4ddd-8ddd-ddddddddddd1','dddddddd-dddd-4ddd-8ddd-ddddddddddd2','dddddddd-dddd-4ddd-8ddd-ddddddddddd3');
 if (r->>'migrated_keys')::int<>1 then raise exception 'key not migrated: %',r; end if;
 if not exists(select 1 from public.s2a_keys where key_hash=repeat('d',64) and group_id='dddddddd-dddd-4ddd-8ddd-ddddddddddd3') then raise exception 'key group unchanged'; end if;
 if exists(select 1 from public.s2a_memberships where user_id='dddddddd-dddd-4ddd-8ddd-ddddddddddd1' and group_id='dddddddd-dddd-4ddd-8ddd-ddddddddddd2') then raise exception 'old membership retained'; end if;
 r := public.s2a_user_configure('dddddddd-dddd-4ddd-8ddd-ddddddddddd1','{}');
 if exists(select 1 from public.s2a_memberships where user_id='dddddddd-dddd-4ddd-8ddd-ddddddddddd1') then raise exception 'empty groups did not revoke access'; end if;
end $$;
rollback;
