begin;
insert into auth.users(id,email,raw_user_meta_data,raw_app_meta_data,created_at,updated_at,banned_until) values
  ('cccccccc-cccc-4ccc-8ccc-cccccccccccc','users-a@example.com','{"username":"Alpha","role":"admin","secret":"never-return"}','{"s2a_notes":"private","secret":"never-return"}',now(),now(),null),
  ('dddddddd-dddd-4ddd-8ddd-dddddddddddd','users-b@example.com','{"username":"Beta","role":"user"}','{}',now(),now(),now()+interval '1 day');
set role service_role;
do $$
declare result jsonb;
begin
  result := public.s2a_users_list(1,10,'users-','','','{dddddddd-dddd-4ddd-8ddd-dddddddddddd}'::uuid[],'email','asc');
  assert result->>'total'='2' and result->>'pages'='1';
  assert result->'items'->0->>'email'='users-a@example.com';
  assert result->'items'->0->'user_metadata'->>'username'='Alpha';
  assert not result->'items'->0->'user_metadata' ? 'role';
  assert not result->'items'->0->'user_metadata' ? 'secret';
  assert not result->'items'->0 ? 'encrypted_password';
  assert result->'items'->0->'app_metadata'->>'s2a_notes'='private';
  result := public.s2a_users_list(1,10,'users-','','admin','{dddddddd-dddd-4ddd-8ddd-dddddddddddd}'::uuid[],'email','asc');
  assert result->>'total'='1' and result->'items'->0->>'id'='dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'allowlist ignores metadata roles';
  result := public.s2a_users_list(1,10,'users-','disabled','','{}'::uuid[],'email','asc');
  assert result->>'total'='1' and result->'items'->0->>'id'='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  result := public.s2a_users_list(2,1,'users-','','','{}'::uuid[],'email','asc');
  assert result->>'total'='2' and result->>'pages'='2' and result->'items'->0->>'email'='users-b@example.com';
end $$;
reset role;
do $$ begin
  assert not has_function_privilege('authenticated','public.s2a_users_list(integer,integer,text,text,text,uuid[],text,text,text,uuid,jsonb)','execute');
  assert not has_function_privilege('anon','public.s2a_users_list(integer,integer,text,text,text,uuid[],text,text,text,uuid,jsonb)','execute');
  assert not has_column_privilege('service_role','auth.users','encrypted_password','select');
end $$;
rollback;
