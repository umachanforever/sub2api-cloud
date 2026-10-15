begin;
select public.s2a_settings_update('{"promo_code_enabled":true,"registration_enabled":true,"invitation_code_enabled":false,"registration_email_suffix_whitelist":[],"default_balance":1.25,"default_concurrency":3,"default_subscriptions":[]}');
insert into public.s2a_promo_codes(code,bonus_amount,max_uses) values('PROMO-ONE',2.5,1),('PROMO-TWO',3,2);
do $$ declare r jsonb; pid bigint; user1 uuid:='dddddddd-dddd-4ddd-8ddd-ddddddddddd1';user2 uuid:='dddddddd-dddd-4ddd-8ddd-ddddddddddd2'; begin
 r:=public.s2a_promo_validate('PROMO-ONE',repeat('c',64));if r->>'valid'<>'true' or (r->>'bonus_amount')::numeric<>2.5 or r ? 'notes' then raise exception 'invalid public promo result';end if;
 insert into auth.users(id,email,raw_app_meta_data,raw_user_meta_data) values(user1,'promo1@example.com','{}','{"promo_code":"PROMO-ONE"}');
 if (select balance from public.s2a_wallets where user_id=user1)<>3.75 then raise exception 'promo and default credit missing';end if;
 if (select raw_user_meta_data ? 'promo_code' from auth.users where id=user1) then raise exception 'promo metadata retained';end if;
 if (select used_count from public.s2a_promo_codes where code='PROMO-ONE')<>1 then raise exception 'promo consumption missing';end if;
 insert into auth.users(id,email,raw_app_meta_data,raw_user_meta_data) values(user2,'promo2@example.com','{}','{"promo_code":"PROMO-ONE"}');
 if (select balance from public.s2a_wallets where user_id=user2)<>1.25 then raise exception 'exhausted promo granted or blocked default signup';end if;
 r:=public.s2a_promo_apply(user1,'PROMO-TWO');if r->>'ok'<>'true' then raise exception 'promo apply failed';end if;
 r:=public.s2a_promo_apply(user1,'PROMO-TWO');if r->>'error'<>'PROMO_CODE_ALREADY_USED' then raise exception 'duplicate promo accepted';end if;
 if (select count(*) from public.s2a_wallet_ledger where user_id=user1 and reason='promo')<>2 then raise exception 'promo ledger not exactly once';end if;
 update auth.users set raw_user_meta_data='{"promo_code":"PROMO-TWO","username":"Changed"}' where id=user2;
 if (select balance from public.s2a_wallets where user_id=user2)<>1.25 or (select raw_user_meta_data ? 'promo_code' from auth.users where id=user2) then raise exception 'profile update granted credit or retained promo';end if;
 update public.s2a_promo_codes set status='disabled' where code='PROMO-TWO';r:=public.s2a_promo_apply(user2,'PROMO-TWO');if r->>'error'<>'PROMO_CODE_DISABLED' then raise exception 'disabled promo granted';end if;
 update public.s2a_promo_codes set status='active',expires_at=now()-interval '1 day' where code='PROMO-TWO';r:=public.s2a_promo_apply(user2,'PROMO-TWO');if r->>'error'<>'PROMO_CODE_EXPIRED' then raise exception 'expired promo granted';end if;
 select id into pid from public.s2a_promo_codes where code='PROMO-ONE';r:=public.s2a_promo_usages_list(pid,1,20);
 if (r->>'total')::integer<>1 or r->'items'->0->'user'->>'email'<>'promo1@example.com' or r->'items'->0->'user' ? 'raw_user_meta_data' then raise exception 'usage DTO unsafe or incomplete';end if;
 select public.s2a_settings_update('{"registration_enabled":false}') into r;
 begin
  insert into auth.users(id,email,raw_app_meta_data,raw_user_meta_data) values(gen_random_uuid(),'closed@example.com','{}','{"promo_code":"PROMO-TWO"}');raise exception 'closed signup accepted';
 exception when check_violation then if sqlerrm<>'registration_disabled' then raise;end if;end;
 for n in 1..30 loop r:=public.s2a_promo_validate('missing',repeat('d',64));end loop;
 r:=public.s2a_promo_validate('PROMO-ONE',repeat('d',64));if r->>'status'<>'429' then raise exception 'promo guesses unlimited';end if;
 perform public.s2a_settings_update('{"promo_code_enabled":false}');r:=public.s2a_promo_validate('PROMO-ONE',repeat('e',64));if r->>'error_code'<>'PROMO_CODE_DISABLED' then raise exception 'feature switch ignored';end if;
 delete from public.s2a_promo_codes where id=pid;
 if exists(select 1 from public.s2a_promo_usages where promo_code_id=pid) or (select count(*) from public.s2a_wallet_ledger where user_id=user1 and reason='promo')<>2 then raise exception 'promo delete broke usage cleanup or financial history';end if;
end $$;
set local role service_role;
do $$ begin
 begin update public.s2a_promo_codes set used_count=100 where code='PROMO-TWO';raise exception 'counter writable';exception when insufficient_privilege then null;end;
 begin perform public.s2a_promo_apply(gen_random_uuid(),'PROMO-TWO');raise exception 'direct service award allowed';exception when insufficient_privilege then null;end;
end $$;
set local role anon;
do $$ begin
 begin perform code from public.s2a_promo_codes;raise exception 'public code enumeration';exception when insufficient_privilege then null;end;
 begin perform public.s2a_promo_validate('PROMO-ONE',repeat('c',64));raise exception 'public RPC bypass';exception when insufficient_privilege then null;end;
end $$;
rollback;
