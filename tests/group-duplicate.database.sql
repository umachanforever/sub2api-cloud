begin;
insert into auth.users(id,email) values('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1','duplicate1@example.com'),('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee2','duplicate2@example.com');
do $$ declare actor uuid:='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1';other_actor uuid:='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee2';g uuid;a uuid:=gen_random_uuid();b uuid:=gen_random_uuid();r jsonb;again jsonb;copied uuid;long_group uuid;begin
 r:=public.s2a_group_create('Duplicate pool',actor,'openai',0.375,'{"description":"Keep details","sort_order":4,"is_exclusive":true,"require_privacy_set":true,"rpm_limit":17,"subscription_type":"subscription","daily_limit_usd":3.25,"weekly_limit_usd":18,"monthly_limit_usd":55}');g:=(r->>'id')::uuid;
 insert into public.s2a_accounts(id,group_id,name,account_fingerprint,ciphertext,iv,priority,status) values(a,g,'Active','duplicate-active','cipher','iv',4,'active'),(b,g,'Disabled','duplicate-disabled','cipher','iv',90,'disabled');
 insert into public.s2a_memberships(user_id,group_id) values(other_actor,g);
 r:=public.s2a_group_duplicate(g,actor,'same-key');copied:=(r->'group'->>'id')::uuid;
 if copied is null or r->>'replayed'<>'false' or r->'group'->>'account_count'<>'2' then raise exception 'duplicate failed %',r;end if;
 if (select to_jsonb(x)-'id'-'name'-'enabled'-'created_at' from public.s2a_groups x where id=copied) is distinct from (select to_jsonb(x)-'id'-'name'-'enabled'-'created_at' from public.s2a_groups x where id=g) then raise exception 'configuration not copied';end if;
 if (select enabled from public.s2a_groups where id=copied) or (select name from public.s2a_groups where id=copied)<>'Duplicate pool (Copy)' then raise exception 'unsafe copy status or name';end if;
 if (select array_agg(account_id order by account_id) from public.s2a_account_groups where group_id=copied) is distinct from (select array_agg(account_id order by account_id) from public.s2a_account_groups where group_id=g) then raise exception 'bindings lost';end if;
 if (select group_id from public.s2a_accounts where id=a)<>g or (select priority from public.s2a_accounts where id=b)<>90 or (select count(*) from public.s2a_accounts where id in(a,b))<>2 then raise exception 'account state changed or duplicated';end if;
 if exists(select 1 from public.s2a_memberships where group_id=copied and user_id=other_actor) or exists(select 1 from public.s2a_keys where group_id=copied) or exists(select 1 from public.s2a_subscriptions where group_id=copied) then raise exception 'customer access or billing copied';end if;
 again:=public.s2a_group_duplicate(g,actor,'same-key');if again->'group' is distinct from r->'group' or again->>'replayed'<>'true' then raise exception 'retry not replayed';end if;
 again:=public.s2a_group_duplicate(copied,actor,'same-key');if again->>'error'<>'idempotency_conflict' then raise exception 'different source accepted with same key';end if;
 again:=public.s2a_group_duplicate(g,other_actor,'same-key');if again->'group'->>'name'<>'Duplicate pool (Copy 2)' or again->'group'->>'id'=copied::text then raise exception 'actor scope or collision name failed';end if;
 r:=public.s2a_group_create(repeat('组',100),actor);long_group:=(r->>'id')::uuid;
 r:=public.s2a_group_duplicate(long_group,actor,null);if length(r->'group'->>'name')<>100 or r->'group'->>'name'<>repeat('组',93)||' (Copy)' then raise exception 'Unicode truncation failed';end if;
 r:=public.s2a_group_duplicate(long_group,actor,null);if length(r->'group'->>'name')<>100 or r->'group'->>'name'<>repeat('组',91)||' (Copy 2)' then raise exception 'Unicode collision failed';end if;
 r:=public.s2a_group_duplicate(gen_random_uuid(),actor,null);if r->>'status'<>'404' then raise exception 'missing group accepted';end if;
 r:=public.s2a_group_duplicate(g,actor,repeat('x',129));if r->>'status'<>'400' then raise exception 'invalid key accepted';end if;
 if has_function_privilege('authenticated','public.s2a_group_duplicate(uuid,uuid,text)','execute') or has_table_privilege('anon','public.s2a_group_duplicate_operations','select') then raise exception 'duplicate state exposed';end if;
end $$;
create function pg_temp.reject_duplicate_binding() returns trigger language plpgsql as $$ begin
 if exists(select 1 from public.s2a_groups where id=new.group_id and name like 'Atomic duplicate (Copy)%') then raise exception 'acceptance binding failure';end if;return new;
end $$;
create trigger reject_duplicate_binding before insert on public.s2a_account_groups for each row execute function pg_temp.reject_duplicate_binding();
do $$ declare actor uuid:='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1';g uuid;r jsonb;begin
 r:=public.s2a_group_create('Atomic duplicate',actor);g:=(r->>'id')::uuid;
 insert into public.s2a_accounts(group_id,name,account_fingerprint,ciphertext,iv) values(g,'Atomic binding','atomic-duplicate','cipher','iv');
 begin perform public.s2a_group_duplicate(g,actor,'atomic-key');raise exception 'binding failure did not propagate';exception when raise_exception then if sqlerrm<>'acceptance binding failure' then raise;end if;end;
 if exists(select 1 from public.s2a_groups where name like 'Atomic duplicate (Copy)%') or exists(select 1 from public.s2a_group_duplicate_operations where actor_id=actor and idempotency_key='atomic-key') then raise exception 'failed binding left orphan state';end if;
end $$;
rollback;
