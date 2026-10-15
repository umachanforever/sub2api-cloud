create function public.s2a_user_configure(p_user_id uuid, p_groups uuid[] default null,
 p_balance numeric default null, p_concurrency integer default null,
 p_rpm_limit integer default null, p_actor_id uuid default null)
returns jsonb language plpgsql set search_path='' as $$
declare result jsonb;
begin
 if not exists(select 1 from auth.users where id=p_user_id) then
  return jsonb_build_object('error','user_not_found','status',404);
 end if;
 if p_groups is not null and (cardinality(p_groups)>500 or exists(
  select 1 from unnest(p_groups) requested(group_id) where requested.group_id is null or not exists(select 1 from public.s2a_groups g where g.id=requested.group_id))) then
  return jsonb_build_object('error','invalid_allowed_groups','status',400);
 end if;
 if p_concurrency<0 or p_concurrency>1000000 or p_rpm_limit<0 or p_rpm_limit>1000000 then
  return jsonb_build_object('error','invalid_user_limits','status',400);
 end if;
 if p_balance is not null and (p_balance<0 or p_balance>1000000000 or p_balance<>round(p_balance,8)) then
  return jsonb_build_object('error','invalid_balance','status',400);
 end if;
 insert into public.s2a_user_limits(user_id) values(p_user_id) on conflict do nothing;
 perform 1 from public.s2a_user_limits where user_id=p_user_id for update;
 if p_balance is not null then
  result := public.s2a_wallet_update(p_user_id,p_balance,'set','',p_actor_id);
  if result ? 'error' then return result; end if;
 end if;
 if p_concurrency is not null or p_rpm_limit is not null then
  perform public.s2a_user_limits_set(array[p_user_id],false,p_concurrency,p_rpm_limit);
 end if;
 if p_groups is not null then
  delete from public.s2a_memberships where user_id=p_user_id and not(group_id=any(p_groups));
  insert into public.s2a_memberships(user_id,group_id)
   select p_user_id,id from unnest(p_groups) id on conflict do nothing;
 end if;
 return jsonb_build_object('ok',true);
end $$;

create function public.s2a_user_replace_group(p_user_id uuid,p_old_group_id uuid,p_new_group_id uuid)
returns jsonb language plpgsql set search_path='' as $$
declare source_platform text; target_platform text; migrated integer;
begin
 if not exists(select 1 from auth.users where id=p_user_id) then return jsonb_build_object('error','user_not_found','status',404); end if;
 insert into public.s2a_user_limits(user_id) values(p_user_id) on conflict do nothing;
 perform 1 from public.s2a_user_limits where user_id=p_user_id for update;
 select platform into source_platform from public.s2a_groups where id=p_old_group_id;
 select platform into target_platform from public.s2a_groups where id=p_new_group_id and enabled;
 if source_platform is null or target_platform is null then return jsonb_build_object('error','group_not_found','status',404); end if;
 if source_platform<>target_platform then return jsonb_build_object('error','group_platform_mismatch','status',400); end if;
 if not exists(select 1 from public.s2a_memberships where user_id=p_user_id and group_id=p_old_group_id) then
  return jsonb_build_object('error','group_access_denied','status',403);
 end if;
 if p_old_group_id=p_new_group_id then return jsonb_build_object('migrated_keys',0); end if;
 insert into public.s2a_memberships(user_id,group_id) values(p_user_id,p_new_group_id) on conflict do nothing;
 perform 1 from public.s2a_keys where user_id=p_user_id and group_id=p_old_group_id and deleted_at is null order by id for update;
 update public.s2a_keys set group_id=p_new_group_id where user_id=p_user_id and group_id=p_old_group_id and deleted_at is null;
 get diagnostics migrated=row_count;
 delete from public.s2a_memberships where user_id=p_user_id and group_id=p_old_group_id;
 return jsonb_build_object('migrated_keys',migrated);
end $$;
revoke all on function public.s2a_user_configure(uuid,uuid[],numeric,integer,integer,uuid) from public,anon,authenticated;
revoke all on function public.s2a_user_replace_group(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.s2a_user_configure(uuid,uuid[],numeric,integer,integer,uuid) to service_role;
grant execute on function public.s2a_user_replace_group(uuid,uuid,uuid) to service_role;
