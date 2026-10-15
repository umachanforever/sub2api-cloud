create table public.s2a_admin_roles (
 user_id uuid primary key references auth.users(id) on delete cascade,
 created_at timestamptz not null default now()
);
create table public.s2a_admin_bootstrap (
 singleton boolean primary key default true check(singleton),initialized boolean not null default false
);
insert into public.s2a_admin_bootstrap(singleton) values(true);
alter table public.s2a_admin_roles enable row level security;
alter table public.s2a_admin_bootstrap enable row level security;
revoke all on public.s2a_admin_roles,public.s2a_admin_bootstrap from public,anon,authenticated,service_role;
create trigger s2a_admin_role_audit after insert or delete on public.s2a_admin_roles for each row execute function public.s2a_audit_mutation();

create function public.s2a_active_admin_ids() returns uuid[] language sql stable security definer set search_path='' as $$
 select coalesce(array_agg(r.user_id order by r.user_id),'{}'::uuid[]) from public.s2a_admin_roles r
 join auth.users u on u.id=r.user_id where u.deleted_at is null and (u.banned_until is null or u.banned_until<=now());
$$;
create function public.s2a_admin_context(p_seed_ids uuid[]) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
 if not (select initialized from public.s2a_admin_bootstrap) then
  -- Lock Auth rows before the administration lock, matching account lifecycle triggers.
  perform id from auth.users where id=any(p_seed_ids) order by id for no key update;
  perform pg_advisory_xact_lock(hashtextextended('s2a-admin-roles',0));
  if not (select initialized from public.s2a_admin_bootstrap) then
   insert into public.s2a_admin_roles(user_id) select id from auth.users where id=any(p_seed_ids) and deleted_at is null and (banned_until is null or banned_until<=now()) on conflict do nothing;
   if exists(select 1 from public.s2a_admin_roles) then update public.s2a_admin_bootstrap set initialized=true;end if;
  end if;
 end if;
 return jsonb_build_object('admin_ids',public.s2a_active_admin_ids());
end $$;
create function public.s2a_admin_role_set(p_actor_id uuid,p_user_id uuid,p_role text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare active_ids uuid[];target auth.users;
begin
 if p_role is null or p_role not in ('admin','user') then return jsonb_build_object('error','invalid_role','status',400);end if;
 select * into target from auth.users where id=p_user_id and deleted_at is null for no key update;
 if not found then return jsonb_build_object('error','user_not_found','status',404);end if;
 perform pg_advisory_xact_lock(hashtextextended('s2a-admin-roles',0));
 active_ids:=public.s2a_active_admin_ids();
 if p_actor_id is null or not(p_actor_id=any(active_ids)) then return jsonb_build_object('error','admin_required','status',403);end if;
 if p_role='admin' then
  if target.banned_until>now() then return jsonb_build_object('error','cannot_promote_disabled_user','status',400);end if;
  insert into public.s2a_admin_roles(user_id) values(p_user_id) on conflict do nothing;
 else
  if p_actor_id=p_user_id then return jsonb_build_object('error','cannot_demote_yourself','status',400);end if;
  if p_user_id=any(active_ids) and cardinality(active_ids)=1 then return jsonb_build_object('error','cannot_demote_sole_admin','status',400);end if;
  delete from public.s2a_admin_roles where user_id=p_user_id;
 end if;
 return jsonb_build_object('admin_ids',public.s2a_active_admin_ids());
end $$;
create function public.s2a_protect_admin_lifecycle() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if tg_op='UPDATE' and new.deleted_at is null and (new.banned_until is null or new.banned_until<=now()) then return new;end if;
 if exists(select 1 from public.s2a_admin_roles where user_id=old.id) then
  perform pg_advisory_xact_lock(hashtextextended('s2a-admin-roles',0));
  if old.id=any(public.s2a_active_admin_ids()) and cardinality(public.s2a_active_admin_ids())=1 then
   raise exception 'cannot_disable_or_delete_sole_admin' using errcode='23514';
  end if;
 end if;
 return case when tg_op='DELETE' then old else new end;
end $$;
create trigger s2a_protect_admin_lifecycle before update of banned_until,deleted_at or delete on auth.users
 for each row execute function public.s2a_protect_admin_lifecycle();
revoke all on function public.s2a_active_admin_ids(),public.s2a_protect_admin_lifecycle() from public,anon,authenticated,service_role;
revoke all on function public.s2a_admin_context(uuid[]),public.s2a_admin_role_set(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.s2a_admin_context(uuid[]),public.s2a_admin_role_set(uuid,uuid,text) to service_role;
notify pgrst,'reload schema';
