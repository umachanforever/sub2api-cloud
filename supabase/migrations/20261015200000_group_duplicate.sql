create table public.s2a_group_duplicate_operations (
 actor_id uuid not null references auth.users(id) on delete cascade,
 idempotency_key text not null check(length(idempotency_key) between 1 and 128),
 source_id uuid not null,
 result jsonb,
 created_at timestamptz not null default now(),
 primary key(actor_id,idempotency_key)
);
alter table public.s2a_group_duplicate_operations enable row level security;
revoke all on public.s2a_group_duplicate_operations from public,anon,authenticated;
grant select,insert,update,delete on public.s2a_group_duplicate_operations to service_role;

create function public.s2a_group_duplicate(p_source_id uuid,p_actor_id uuid,p_key text default null)
returns jsonb language plpgsql set search_path='' as $$
declare source public.s2a_groups; copy public.s2a_groups; operation public.s2a_group_duplicate_operations;
 suffix text; copy_number integer:=1; outcome jsonb;
begin
 if p_key is not null then
  p_key:=btrim(p_key);
  if length(p_key) not between 1 and 128 or p_key ~ '[[:cntrl:]]' then return jsonb_build_object('error','invalid_idempotency_key','status',400);end if;
  insert into public.s2a_group_duplicate_operations(actor_id,idempotency_key,source_id) values(p_actor_id,p_key,p_source_id) on conflict do nothing;
  select * into operation from public.s2a_group_duplicate_operations where actor_id=p_actor_id and idempotency_key=p_key for update;
  if operation.source_id is distinct from p_source_id then return jsonb_build_object('error','idempotency_conflict','status',409);end if;
  if operation.result is not null then return operation.result || jsonb_build_object('replayed',true);end if;
 end if;
 select * into source from public.s2a_groups where id=p_source_id for update;
 if not found then return jsonb_build_object('error','group_not_found','status',404);end if;
 copy:=source;copy.id:=gen_random_uuid();copy.enabled:=false;copy.created_at:=now();
 loop
  suffix:=case when copy_number=1 then ' (Copy)' else ' (Copy '||copy_number||')' end;
  copy.name:=left(btrim(source.name),100-length(suffix))||suffix;
  begin
   insert into public.s2a_groups select (copy).*;
   exit;
  exception when unique_violation then copy_number:=copy_number+1;
  end;
 end loop;
 insert into public.s2a_account_groups(account_id,group_id)
  select account_id,copy.id from public.s2a_account_groups where group_id=source.id;
 insert into public.s2a_memberships(user_id,group_id) values(p_actor_id,copy.id);
 outcome:=jsonb_build_object('group',to_jsonb(copy)||jsonb_build_object('account_count',public.s2a_group_account_count(copy)),'replayed',false);
 if p_key is not null then update public.s2a_group_duplicate_operations set result=outcome where actor_id=p_actor_id and idempotency_key=p_key;end if;
 return outcome;
end $$;
revoke all on function public.s2a_group_duplicate(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.s2a_group_duplicate(uuid,uuid,text) to service_role;
notify pgrst,'reload schema';
