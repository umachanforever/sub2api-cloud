begin;
select public.s2a_settings_update('{"registration_enabled":true,"invitation_code_enabled":false,"registration_email_suffix_whitelist":[],"default_balance":1.25,"default_subscriptions":[]}');
do $$ declare uid uuid:='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeea1';alias text;begin
 if public.s2a_email_identity(' U.s.e.r+tag@GoogleMail.COM. ')<>'user@gmail.com' or public.s2a_email_identity('a.b+tag@example.com')<>'a.b@example.com' or public.s2a_email_identity('+tag@example.com')<>'+tag@example.com' then raise exception 'email identity differs from upstream';end if;
 insert into auth.users(id,email,raw_app_meta_data) values(uid,'alias.test@gmail.com','{}');
 foreach alias in array array['aliastest+tag@gmail.com','a.l.i.a.s.t.e.s.t@googlemail.com','aliastest@gmail.com.'] loop
  begin insert into auth.users(id,email,raw_app_meta_data) values(gen_random_uuid(),alias,'{}');raise exception 'alias duplicate accepted';
  exception when unique_violation then if sqlerrm<>'email_alias_already_registered' then raise;end if;end;
 end loop;
 if (select count(*) from public.s2a_wallet_ledger where user_id=uid and reason='signup')<>1 then raise exception 'alias granted duplicate credits';end if;
 insert into auth.users(id,email,raw_app_meta_data) values(gen_random_uuid(),'a.b@example.com','{}'),(gen_random_uuid(),'ab@example.com','{}');
 begin insert into auth.users(id,email,raw_app_meta_data) values(gen_random_uuid(),'a.b+tag@example.com','{}');raise exception 'non-Gmail plus duplicate accepted';
 exception when unique_violation then if sqlerrm<>'email_alias_already_registered' then raise;end if;end;
 delete from auth.users where id=uid;
 insert into auth.users(id,email,raw_app_meta_data) values(uid,'aliastest@gmail.com','{}');
end $$;
rollback;
