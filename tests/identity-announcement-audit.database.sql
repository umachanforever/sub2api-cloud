begin;
-- Even spoofed application headers cannot attribute native Auth events to an administrator.
select set_config('request.headers','{"x-s2a-actor-id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1","x-s2a-actor-email":"spoof@example.com","x-s2a-actor-role":"admin"}',true);
insert into auth.users(id,email,encrypted_password,raw_user_meta_data)
 values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1','audit-target@example.com','private-password-hash','{"secret":"private-metadata"}');
update auth.users set encrypted_password='private-replacement-hash',banned_until=now()+interval '1 hour'
 where id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
do $$ declare event public.s2a_audit_logs; before_count bigint; begin
 select * into event from public.s2a_audit_logs where action='auth.users.update'
  and extra->>'resource_id'='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1' order by id desc limit 1;
 if event.id is null or event.actor_user_id is not null or event.actor_role<>'system' or event.auth_method<>'supabase-auth' then raise exception 'Auth actor attribution incorrect'; end if;
 if event.extra->'changed_fields' <> '["banned_until","password"]'::jsonb then raise exception 'Auth password/ban change missing'; end if;
 select count(*) into before_count from public.s2a_audit_logs;
 update auth.users set updated_at=clock_timestamp() where id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
 if (select count(*) from public.s2a_audit_logs)<>before_count then raise exception 'timestamp-only Auth update audited'; end if;
end $$;
do $$ declare announcement bigint; event public.s2a_audit_logs; before_count bigint; begin
 insert into public.s2a_announcements(title,content,status,created_by)
 values ('Private announcement title','Private announcement body','active','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1') returning id into announcement;
 update public.s2a_announcements set content='Private edited body' where id=announcement;
 select * into event from public.s2a_audit_logs where action='s2a_announcements.update'
  and extra->>'resource_id'=announcement::text order by id desc limit 1;
 if event.actor_user_id<>'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1' or event.extra->'changed_fields'<>'["content"]'::jsonb then raise exception 'announcement update audit missing'; end if;
 perform public.s2a_announcement_mark_read('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',announcement);
 select * into event from public.s2a_audit_logs where action='s2a_announcement_reads.insert' order by id desc limit 1;
 if event.extra->>'resource_id'<>announcement::text or event.extra->'resource_refs'->>'user_id'<>'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1' then raise exception 'receipt resource reference missing'; end if;
 select count(*) into before_count from public.s2a_audit_logs;
 perform public.s2a_announcement_mark_read('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',announcement);
 if (select count(*) from public.s2a_audit_logs)<>before_count then raise exception 'idempotent receipt double audited'; end if;
 delete from public.s2a_announcements where id=announcement;
 if not exists(select 1 from public.s2a_audit_logs where action='s2a_announcements.delete' and extra->>'resource_id'=announcement::text) then raise exception 'announcement deletion missing'; end if;
 if exists(select 1 from public.s2a_audit_logs where row_to_json(s2a_audit_logs)::text like '%Private announcement%' or row_to_json(s2a_audit_logs)::text like '%private-password%' or row_to_json(s2a_audit_logs)::text like '%private-metadata%' or row_to_json(s2a_audit_logs)::text like '%private-replacement%') then raise exception 'sensitive values leaked into audit'; end if;
end $$;
insert into auth.mfa_factors(id,user_id,factor_type,status,secret)
 values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1','totp','unverified','private-mfa-secret');
update auth.mfa_factors set status='verified' where id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
do $$ begin
 if not exists(select 1 from public.s2a_audit_logs where action='auth.mfa_factors.update'
  and extra->>'resource_id'='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2' and extra->'changed_fields'='["status"]'::jsonb
  and extra->'resource_refs'->>'user_id'='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1') then raise exception 'MFA verification audit missing'; end if;
 if exists(select 1 from public.s2a_audit_logs where extra::text like '%private-mfa-secret%') then raise exception 'MFA secret exposed'; end if;
end $$;
delete from auth.mfa_factors where id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
delete from auth.users where id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
do $$ begin
 if not exists(select 1 from public.s2a_audit_logs where action='auth.users.delete' and extra->>'resource_id'='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1') then raise exception 'Auth deletion audit missing'; end if;
end $$;
rollback;
