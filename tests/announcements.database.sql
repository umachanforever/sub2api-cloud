-- Executed against the isolated PostgreSQL fixture after migrations; no production credentials.
begin;
insert into auth.users(id,email,raw_user_meta_data) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','announcements-a@example.com','{"username":"Alpha"}'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','announcements-b@example.com','{"username":"Beta"}');
set role service_role;
insert into public.s2a_announcements(title,content,status,starts_at,ends_at) values
  ('visible','text','active',null,null),
  ('future','text','active',now()+interval '1 hour',null),
  ('expired','text','active',null,now()),
  ('draft','text','draft',null,null),
  ('archived','text','archived',null,null);
do $$
declare a bigint; initial_read timestamptz; result jsonb;
begin
  select id into a from public.s2a_announcements where title='visible';
  result := public.s2a_announcements_for_user('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  assert jsonb_array_length(result)=1 and result->0->>'title'='visible', 'only active scheduled announcements are visible';
  assert public.s2a_announcement_mark_read('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',a);
  select read_at into initial_read from public.s2a_announcement_reads where announcement_id=a;
  assert public.s2a_announcement_mark_read('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',a);
  assert (select count(*)=1 and min(read_at)=initial_read from public.s2a_announcement_reads where announcement_id=a), 'read timestamp is idempotent';
  assert jsonb_array_length(public.s2a_announcements_for_user('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true))=0;
  assert jsonb_array_length(public.s2a_announcements_for_user('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',true))=1, 'receipts are owner isolated';
  assert not public.s2a_announcement_mark_read('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',(select id from public.s2a_announcements where title='future'));
  assert not public.s2a_announcement_mark_read('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',(select id from public.s2a_announcements where title='expired'));
  insert into public.s2a_announcements(title,content,status) values ('second-visible','text','active');
  result := public.s2a_announcements_for_user('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  assert result->0->>'title'='second-visible' and result->1->>'title'='visible', 'unread announcements sort first';
  delete from public.s2a_announcements where title='second-visible';
  result := public.s2a_announcement_read_status(a,1,20,'announcements-','email','asc');
  assert result->>'total'='2';
  assert result->'items'->0->>'email'='announcements-a@example.com';
  assert result->'items'->0 ? 'read_at';
  assert not result->'items'->1 ? 'read_at';
  assert result->'items'->0->'balance'='0'::jsonb, 'new user wallet balance is zero';
  begin
    insert into public.s2a_announcements(title,content,targeting) values ('targeted','text','{"any_of":[{"all_of":[{"type":"balance","operator":"bogus","value":1}]}]}');
    raise exception 'invalid targeting must fail closed';
  exception when check_violation then null; end;
  begin
    insert into public.s2a_announcements(title,content,targeting) values ('unknown-target','text','{"foo":"restricted"}');
    raise exception 'unknown targeting keys must fail closed';
  exception when check_violation then null; end;
  begin
    insert into public.s2a_announcements(title,content,starts_at,ends_at) values ('invalid','text',now(),now());
    raise exception 'invalid schedules must fail';
  exception when check_violation then null; end;
  delete from public.s2a_announcements where id=a;
  assert not exists(select 1 from public.s2a_announcement_reads where announcement_id=a), 'upstream hard delete cascades receipts';
end $$;
reset role;
do $$ begin
  assert not has_table_privilege('authenticated','public.s2a_announcements','select');
  assert not has_table_privilege('anon','public.s2a_announcement_reads','insert');
  assert not has_function_privilege('authenticated','public.s2a_announcements_for_user(uuid,boolean)','execute');
  assert not has_function_privilege('anon','public.s2a_announcement_mark_read(uuid,bigint)','execute');
  assert not has_column_privilege('service_role','auth.users','encrypted_password','select');
end $$;
rollback;
