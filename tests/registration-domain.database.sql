begin;
select public.s2a_settings_update('{"registration_enabled":true,"registration_email_domain_quota_enabled":true,"registration_email_suffix_whitelist":["@allowed.example","*.wild.example"],"invitation_code_enabled":false,"default_balance":1.25,"default_subscriptions":[]}');
do $$ declare input text; expected text; uid uuid:='ffffffff-ffff-4fff-8fff-fffffffffff1';r jsonb;begin
 for input,expected in select * from(values
 ('a.example.com','example.com'),('x.a.example.co.uk','example.co.uk'),('www.ck','www.ck'),('a.www.ck','www.ck'),('a.b.ck','a.b.ck'),
 ('x.city.kawasaki.jp','city.kawasaki.jp'),('a.github.io','a.github.io'),('x.a.github.io','a.github.io'),(' EXAMPLE.CO.UK. ','example.co.uk'),('unknown','unknown')) t loop
  if public.s2a_registration_domain(input)<>expected then raise exception 'PSL mismatch for %: %',input,public.s2a_registration_domain(input);end if;
 end loop;
 insert into auth.users(id,email,raw_app_meta_data) values(uid,'first@one.quota-example.co.uk','{}');
 begin insert into auth.users(id,email,raw_app_meta_data) values(gen_random_uuid(),'second@two.quota-example.co.uk','{}');raise exception 'subdomain quota bypassed';
 exception when check_violation then if sqlerrm<>'email_domain_registration_limit' then raise;end if;end;
 if (select balance from public.s2a_wallets where user_id=uid)<>1.25 then raise exception 'first quota signup lost credit';end if;
 insert into auth.users(id,email,raw_app_meta_data) values(gen_random_uuid(),'different@other-quota-example.co.uk','{}');
 insert into auth.users(id,email,raw_app_meta_data) values(gen_random_uuid(),'one@allowed.example','{}'),(gen_random_uuid(),'two@allowed.example','{}');
 insert into auth.users(id,email,raw_app_meta_data) values(gen_random_uuid(),'root@wild.example','{}'),(gen_random_uuid(),'child@sub.wild.example','{}');
 insert into auth.users(id,email,raw_app_meta_data) values(gen_random_uuid(),'root-dot@allowed.example.','{}');
 perform public.s2a_settings_update('{"registration_email_domain_quota_enabled":false}');
 begin insert into auth.users(id,email,raw_app_meta_data) values(gen_random_uuid(),'new@different-denied.example','{}');raise exception 'disabled quota loosened whitelist';
 exception when check_violation then if sqlerrm<>'email_suffix_not_allowed' then raise;end if;end;
 perform public.s2a_settings_update('{"registration_email_domain_quota_enabled":true}');
 delete from auth.users where id=uid;
 insert into auth.users(id,email,raw_app_meta_data) values(uid,'reuse@two.quota-example.co.uk','{}');
 -- Deleted accounts do not occupy the domain quota, matching the upstream guard.
 insert into auth.users(id,email,deleted_at) values(gen_random_uuid(),'old@deleted-quota.example',now());
 insert into auth.users(id,email,raw_app_meta_data) values(gen_random_uuid(),'new@sub.deleted-quota.example','{}');
 perform public.s2a_settings_update('{"invitation_code_enabled":true}');
 begin insert into auth.users(id,email,raw_app_meta_data) values(gen_random_uuid(),'failed@rollback-quota.example','{}');raise exception 'missing invitation accepted';
 exception when check_violation then if sqlerrm<>'invitation_code_required' then raise;end if;end;
 perform public.s2a_settings_update('{"invitation_code_enabled":false}');
 insert into auth.users(id,email,raw_app_meta_data) values(gen_random_uuid(),'success@sub.rollback-quota.example','{}');
 perform public.s2a_settings_update('{"registration_email_suffix_whitelist":[]}');
 insert into auth.users(id,email,raw_app_meta_data) values(gen_random_uuid(),'third@quota-example.co.uk','{}'),(gen_random_uuid(),'fourth@quota-example.co.uk','{}');
end $$;
set local role anon;
do $$ begin
 begin perform public.s2a_registration_domain('one.example.com');raise exception 'anonymous private policy function allowed';exception when insufficient_privilege then null;end;
end $$;
rollback;
