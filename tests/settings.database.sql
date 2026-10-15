begin;
insert into public.s2a_groups(id,name,subscription_type) values('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1','Signup plan','subscription');
insert into public.s2a_redeem_codes(code,type,value) values('invitation-one','invitation',0),('invitation-two','invitation',0),('invitation-three','invitation',0);
do $$ declare r jsonb; ticket text; managed uuid:='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee5'; begin
 r:=public.s2a_settings_update('{"registration_enabled":true,"invitation_code_enabled":true,"registration_email_suffix_whitelist":["@example.com","*.example.org"],"default_balance":1.25,"default_concurrency":5,"default_user_rpm_limit":10,"default_subscriptions":[{"group_id":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1","validity_days":15}]}');
 if r ? 'error' then raise exception 'settings failed: %',r;end if;
 begin
  insert into auth.users(id,email,raw_app_meta_data) values('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee2','a@example.com','{}');
  raise exception 'missing invitation accepted';exception when check_violation then if sqlerrm<>'invitation_code_required' then raise;end if;end;
 begin
  insert into auth.users(id,email,raw_app_meta_data,raw_user_meta_data) values('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee2','a@evil.test','{}','{"invitation_code":"invitation-one"}');
  raise exception 'invalid email suffix accepted';exception when check_violation then if sqlerrm<>'email_suffix_not_allowed' then raise;end if;end;
 insert into auth.users(id,email,raw_app_meta_data,raw_user_meta_data) values('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee2','a@example.com','{}','{"invitation_code":"invitation-one","username":"New"}');
 if (select balance from public.s2a_wallets where user_id='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee2')<>1.25
  or (select concurrency from public.s2a_user_limits where user_id='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee2')<>5
  or (select rpm_limit from public.s2a_user_limits where user_id='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee2')<>10
  or (select count(*) from public.s2a_subscriptions where user_id='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee2')<>1
  or (select raw_user_meta_data ? 'invitation_code' from auth.users where id='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee2') then raise exception 'signup defaults not atomic or private';end if;
 begin
  insert into auth.users(id,email,raw_app_meta_data,raw_user_meta_data) values('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee3','b@example.com','{}','{"invitation_code":"invitation-one"}');
  raise exception 'invitation reused';exception when check_violation then if sqlerrm<>'invitation_code_invalid' then raise;end if;end;
 if exists(select 1 from auth.users where id='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee3') then raise exception 'failed signup left account';end if;
 update auth.users set raw_user_meta_data=raw_user_meta_data||'{"username":"Changed"}' where id='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee2';
 if (select balance from public.s2a_wallets where user_id='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee2')<>1.25 then raise exception 'profile update granted twice';end if;
 insert into auth.users(id,email,raw_app_meta_data,raw_user_meta_data) values('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee3','b@sub.example.org','{}','{"invitation_code":"invitation-two"}');
 update public.s2a_groups set enabled=false where id='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1';
 begin
  insert into auth.users(id,email,raw_app_meta_data,raw_user_meta_data) values('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee4','c@example.com','{}','{"invitation_code":"invitation-three"}');
  raise exception 'broken subscription default accepted';exception when check_violation then if sqlerrm<>'signup_subscription_failed' then raise;end if;end;
 if (select status from public.s2a_redeem_codes where code='invitation-three')<>'unused' or exists(select 1 from auth.users where id='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee4') then raise exception 'failed default consumed invitation/account';end if;
 perform public.s2a_settings_update('{"registration_enabled":false,"default_subscriptions":[]}');
 begin insert into auth.users(id,email,raw_app_meta_data) values('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee4','c@example.com','{}');raise exception 'disabled signup accepted';
 exception when check_violation then if sqlerrm<>'registration_disabled' then raise;end if;end;
 insert into auth.users(id,email,raw_app_meta_data) values('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee4','managed@other.test','{"s2a_managed_user":true}');
 if exists(select 1 from public.s2a_wallets where user_id='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee4') then raise exception 'managed user received signup credit';end if;
 r:=public.s2a_registration_authorize('ticket@other.test');ticket:=r->>'token';
 if length(ticket)<>64 then raise exception 'invalid registration capability';end if;
 begin
  insert into auth.users(id,email,raw_app_meta_data,raw_user_meta_data) values(managed,'wrong@other.test','{}',jsonb_build_object('s2a_registration_ticket',ticket));
  raise exception 'ticket accepted for wrong email';exception when check_violation then if sqlerrm<>'registration_disabled' then raise;end if;end;
 insert into auth.users(id,email,raw_app_meta_data,raw_user_meta_data) values(managed,'ticket@other.test','{}',jsonb_build_object('s2a_registration_ticket',ticket));
 if exists(select 1 from public.s2a_user_limits where user_id=managed) or exists(select 1 from public.s2a_wallets where user_id=managed)
  or exists(select 1 from public.s2a_subscriptions where user_id=managed) then raise exception 'ticket user received public signup grants';end if;
 update auth.users set raw_user_meta_data=jsonb_build_object('s2a_registration_ticket',ticket,'invitation_code','private','username','Managed') where id=managed;
 if (select raw_user_meta_data from auth.users where id=managed)<>'{"username":"Managed"}'::jsonb then raise exception 'private registration metadata retained';end if;
 begin
  insert into auth.users(id,email,raw_app_meta_data,raw_user_meta_data) values(gen_random_uuid(),'ticket@other.test','{}',jsonb_build_object('s2a_registration_ticket',ticket));
  raise exception 'ticket reused';exception when check_violation then if sqlerrm<>'registration_disabled' then raise;end if;end;
 r:=public.s2a_registration_authorize('expired@other.test');ticket:=r->>'token';
 update public.s2a_registration_authorizations set expires_at=now()-interval '1 second' where email='expired@other.test';
 begin
  insert into auth.users(id,email,raw_app_meta_data,raw_user_meta_data) values(gen_random_uuid(),'expired@other.test','{}',jsonb_build_object('s2a_registration_ticket',ticket));
  raise exception 'expired ticket accepted';exception when check_violation then if sqlerrm<>'registration_disabled' then raise;end if;end;
 begin
  insert into auth.users(id,email,raw_app_meta_data,raw_user_meta_data) values(gen_random_uuid(),'forged@other.test','{}',jsonb_build_object('s2a_registration_ticket',repeat('a',64)));
  raise exception 'forged ticket accepted';exception when check_violation then if sqlerrm<>'registration_disabled' then raise;end if;end;
 for n in 1..30 loop r:=public.s2a_invitation_validate('wrong-code',repeat('a',64));end loop;
 r:=public.s2a_invitation_validate('invitation-three',repeat('a',64));
 if r->>'status'<>'429' then raise exception 'invitation guesses not limited';end if;
 r:=public.s2a_invitation_validate('invitation-three',repeat('b',64));if r->>'valid'<>'true' then raise exception 'valid invitation rejected';end if;
end $$;
set local role service_role;
do $$ begin
 if (public.s2a_registration_authorize('service@example.com')->>'token') is null then raise exception 'service capability unavailable';end if;
 begin perform token_hash from public.s2a_registration_authorizations;raise exception 'service raw ticket read accepted';exception when insufficient_privilege then null;end;
 begin update public.s2a_settings set data='{}';raise exception 'direct settings write accepted';exception when insufficient_privilege then null;end;
end $$;
set local role anon;
do $$ begin
 begin perform public.s2a_registration_authorize('anon@example.com');raise exception 'anonymous capability accepted';exception when insufficient_privilege then null;end;
 begin perform token_hash from public.s2a_registration_authorizations;raise exception 'anonymous raw ticket read accepted';exception when insufficient_privilege then null;end;
 begin perform public.s2a_settings_update('{}');raise exception 'anonymous settings update accepted';exception when insufficient_privilege then null;end;
 begin perform data from public.s2a_settings;raise exception 'anonymous private settings read accepted';exception when insufficient_privilege then null;end;
end $$;
rollback;
