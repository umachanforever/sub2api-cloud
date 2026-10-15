begin;
insert into auth.users(id) values ('dddddddd-dddd-4ddd-8ddd-ddddddddddd1');
insert into public.s2a_groups(id,name) values ('dddddddd-dddd-4ddd-8ddd-ddddddddddd2','Lifecycle');
insert into public.s2a_memberships(user_id,group_id) values ('dddddddd-dddd-4ddd-8ddd-ddddddddddd1','dddddddd-dddd-4ddd-8ddd-ddddddddddd2');
insert into public.s2a_accounts(id,group_id,name,account_fingerprint,ciphertext,iv)
 values ('dddddddd-dddd-4ddd-8ddd-ddddddddddd3','dddddddd-dddd-4ddd-8ddd-ddddddddddd2','Lifecycle','lifecycle-fingerprint','encrypted','iv');
insert into public.s2a_keys(user_id,group_id,name,key_hash,key_prefix)
 values ('dddddddd-dddd-4ddd-8ddd-ddddddddddd1','dddddddd-dddd-4ddd-8ddd-ddddddddddd2','Lifecycle',repeat('d',64),'prefix');
do $$ declare r jsonb; lease uuid; begin
 update public.s2a_accounts set schedulable=false where id='dddddddd-dddd-4ddd-8ddd-ddddddddddd3';
 r:=public.s2a_acquire(repeat('d',64),'model',gen_random_uuid());
 if r->>'error'<>'no_available_account' then raise exception 'unschedulable account acquired'; end if;
 update public.s2a_accounts set schedulable=true,expires_at=now()-interval '1 second' where id='dddddddd-dddd-4ddd-8ddd-ddddddddddd3';
 r:=public.s2a_acquire(repeat('d',64),'model',gen_random_uuid());
 if r->>'error'<>'no_available_account' then raise exception 'expired account acquired'; end if;
 update public.s2a_accounts set auto_pause_on_expired=false where id='dddddddd-dddd-4ddd-8ddd-ddddddddddd3';
 r:=public.s2a_acquire(repeat('d',64),'model',gen_random_uuid());
 lease:=(r->>'lease_id')::uuid;
 if lease is null then raise exception 'expiry opt-out ignored'; end if;
 update public.s2a_accounts set schedulable=false where id='dddddddd-dddd-4ddd-8ddd-ddddddddddd3';
 if not exists(select 1 from public.s2a_leases where id=lease) then raise exception 'active lease destroyed'; end if;
 delete from public.s2a_leases where id=lease;
 update public.s2a_accounts set schedulable=true,status='disabled' where id='dddddddd-dddd-4ddd-8ddd-ddddddddddd3';
 r:=public.s2a_acquire(repeat('d',64),'model',gen_random_uuid());
 if r->>'error'<>'no_available_account' then raise exception 'disabled account acquired'; end if;
 update public.s2a_accounts set status='active',auto_pause_on_expired=true,expires_at=now()+interval '1 minute' where id='dddddddd-dddd-4ddd-8ddd-ddddddddddd3';
 r:=public.s2a_acquire(repeat('d',64),'model',gen_random_uuid());
 if r->>'lease_id' is null then raise exception 'valid future expiry rejected'; end if;
end $$;
rollback;
