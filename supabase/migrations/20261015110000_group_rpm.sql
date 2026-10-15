create table public.s2a_user_group_rpm (
 user_id uuid not null references auth.users(id) on delete cascade,
 group_id uuid not null references public.s2a_groups(id) on delete cascade,
 rpm_override integer not null check(rpm_override>=0 and rpm_override<=1000000),
 primary key(user_id,group_id)
);
create index s2a_user_group_rpm_group on public.s2a_user_group_rpm(group_id,user_id);
alter table public.s2a_user_group_rpm enable row level security;
revoke all on public.s2a_user_group_rpm from public,anon,authenticated;
grant select,insert,update,delete on public.s2a_user_group_rpm to service_role;
create trigger s2a_user_group_rpm_audit after insert or update or delete on public.s2a_user_group_rpm
 for each row execute function public.s2a_audit_mutation();

create function public.s2a_group_rpm_set(p_group_id uuid,p_entries jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
 if p_entries is null or jsonb_typeof(p_entries)<>'array' then return jsonb_build_object('error','invalid_group_rpm','status',400);end if;
 if jsonb_array_length(p_entries)>1000 or exists(select 1 from jsonb_array_elements(p_entries) e where jsonb_typeof(e)<>'object') then return jsonb_build_object('error','invalid_group_rpm','status',400);end if;
 if exists(select 1 from jsonb_array_elements(p_entries) e where not(e ? 'user_id' and e ? 'rpm_override') or jsonb_typeof(e->'user_id')<>'string' or jsonb_typeof(e->'rpm_override')<>'number' or (select count(*) from jsonb_object_keys(e))<>2) then return jsonb_build_object('error','invalid_group_rpm','status',400);end if;
 if exists(select 1 from jsonb_array_elements(p_entries) e where (e->>'rpm_override')::numeric<0 or (e->>'rpm_override')::numeric>1000000 or (e->>'rpm_override')::numeric<>trunc((e->>'rpm_override')::numeric)) then return jsonb_build_object('error','invalid_rpm_override','status',400);end if;
 if (select count(distinct user_id) from jsonb_to_recordset(p_entries) e(user_id uuid,rpm_override integer))<>jsonb_array_length(p_entries) then return jsonb_build_object('error','duplicate_user_ids','status',400);end if;
 perform id from public.s2a_groups where id=p_group_id for no key update;
 if not found then return jsonb_build_object('error','group_not_found','status',404);end if;
 if exists(select 1 from jsonb_to_recordset(p_entries) e(user_id uuid,rpm_override integer) where not exists(select 1 from auth.users where id=e.user_id and deleted_at is null)) then return jsonb_build_object('error','user_not_found','status',404);end if;
 insert into public.s2a_user_limits(user_id)
  select user_id from public.s2a_user_group_rpm where group_id=p_group_id union select user_id from jsonb_to_recordset(p_entries) e(user_id uuid,rpm_override integer) on conflict do nothing;
 perform user_id from public.s2a_user_limits where user_id in(select user_id from public.s2a_user_group_rpm where group_id=p_group_id union select user_id from jsonb_to_recordset(p_entries) e(user_id uuid,rpm_override integer)) order by user_id for update;
 delete from public.s2a_user_group_rpm where group_id=p_group_id and user_id not in(select user_id from jsonb_to_recordset(p_entries) e(user_id uuid,rpm_override integer));
 insert into public.s2a_user_group_rpm(user_id,group_id,rpm_override)
  select user_id,p_group_id,rpm_override from jsonb_to_recordset(p_entries) e(user_id uuid,rpm_override integer)
  on conflict(user_id,group_id) do update set rpm_override=excluded.rpm_override;
 return jsonb_build_object('ok',true);
exception when invalid_text_representation or numeric_value_out_of_range then return jsonb_build_object('error','invalid_group_rpm','status',400);
end $$;

revoke all on function public.s2a_group_rpm_set(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.s2a_group_rpm_set(uuid,jsonb) to service_role;
alter table public.s2a_groups add column rpm_limit integer not null default 0 check(rpm_limit between 0 and 1000000);
create table public.s2a_user_group_windows (
 user_id uuid not null references auth.users(id) on delete cascade,
 group_id uuid not null references public.s2a_groups(id) on delete cascade,
 window_start timestamptz not null default now(),
 window_count integer not null default 0 check(window_count>=0),
 primary key(user_id,group_id)
);
alter table public.s2a_user_group_windows enable row level security;
revoke all on public.s2a_user_group_windows from public,anon,authenticated;
grant select,insert,update,delete on public.s2a_user_group_windows to service_role;
create or replace function public.s2a_group_rates_list(p_group_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
 if not exists(select 1 from public.s2a_groups where id=p_group_id) then return jsonb_build_object('error','group_not_found','status',404);end if;
 return coalesce((select jsonb_agg(jsonb_build_object('user_id',ids.user_id,'user_name',coalesce(u.raw_user_meta_data->>'username',split_part(u.email,'@',1)),
  'user_email',u.email,'user_notes',coalesce(u.raw_app_meta_data->>'s2a_notes',''),'user_status',case when u.banned_until>now() then 'disabled' else 'active' end,'rate_multiplier',r.rate_multiplier,'rpm_override',o.rpm_override) order by ids.user_id)
  from (select user_id from public.s2a_user_group_rates where group_id=p_group_id union select user_id from public.s2a_user_group_rpm where group_id=p_group_id) ids join auth.users u on u.id=ids.user_id left join public.s2a_user_group_rates r on r.user_id=ids.user_id and r.group_id=p_group_id left join public.s2a_user_group_rpm o on o.user_id=ids.user_id and o.group_id=p_group_id where u.deleted_at is null),'[]'::jsonb);
end $$;
create or replace function public.s2a_group_create(p_name text,p_user_id uuid,p_platform text default 'openai',p_rate_multiplier numeric default 1,p_options jsonb default '{}')
returns jsonb language plpgsql set search_path='' as $$
declare g public.s2a_groups;
begin
 if p_options is null or jsonb_typeof(p_options)<>'object' or exists(select 1 from jsonb_object_keys(p_options) k where k not in ('rpm_limit','description','sort_order','subscription_type','daily_limit_usd','weekly_limit_usd','monthly_limit_usd')) then
  return jsonb_build_object('error','invalid_group_options','status',400);
 end if;
 insert into public.s2a_groups(name,platform,rate_multiplier,rpm_limit,description,sort_order,subscription_type,daily_limit_usd,weekly_limit_usd,monthly_limit_usd)
 values(p_name,p_platform,p_rate_multiplier,coalesce((p_options->>'rpm_limit')::integer,0),p_options->>'description',coalesce((p_options->>'sort_order')::integer,0),coalesce(p_options->>'subscription_type','standard'),(p_options->>'daily_limit_usd')::numeric,(p_options->>'weekly_limit_usd')::numeric,(p_options->>'monthly_limit_usd')::numeric) returning * into g;
 insert into public.s2a_memberships(user_id,group_id) values(p_user_id,g.id);
 return to_jsonb(g);
end $$;
create or replace function public.s2a_acquire(p_key_hash text,p_model text,p_request_id uuid,
 p_excluded uuid[] default '{}',p_count_request boolean default true)
returns jsonb language plpgsql set search_path='' as $$
declare owner_id uuid; limits public.s2a_user_limits; result jsonb; selected_group uuid; group_rpm integer; group_window public.s2a_user_group_windows;
begin
 select user_id,group_id into owner_id,selected_group from public.s2a_keys where key_hash=p_key_hash;
 if owner_id is null then return jsonb_build_object('error','invalid_api_key','status',401); end if;
 insert into public.s2a_user_limits(user_id) values(owner_id) on conflict do nothing;
 select * into limits from public.s2a_user_limits where user_id=owner_id for update;
 if limits.concurrency>0 and (select count(*) from public.s2a_leases l join public.s2a_keys k on k.id=l.key_id
    where k.user_id=owner_id and l.expires_at>now())>=limits.concurrency then
  return jsonb_build_object('error','user_concurrency_limit_exceeded','status',429);
 end if;
 if p_count_request and limits.rpm_limit>0 and limits.window_start>now()-interval '60 seconds' and limits.window_count>=limits.rpm_limit then
  return jsonb_build_object('error','user_rate_limit_exceeded','status',429);
 end if;
 select coalesce((select rpm_override from public.s2a_user_group_rpm where user_id=owner_id and group_id=selected_group),rpm_limit) into group_rpm from public.s2a_groups where id=selected_group;
 if p_count_request and group_rpm>0 then
  select * into group_window from public.s2a_user_group_windows where user_id=owner_id and group_id=selected_group;
  if group_window.window_start>now()-interval '60 seconds' and group_window.window_count>=group_rpm then
   return jsonb_build_object('error','group_rate_limit_exceeded','status',429);
  end if;
 end if;
 result := public.s2a_acquire_key(p_key_hash,p_model,p_request_id,p_excluded,p_count_request);
 if result ? 'lease_id' and p_count_request then
  insert into public.s2a_user_group_windows(user_id,group_id,window_count) values(owner_id,selected_group,1)
   on conflict(user_id,group_id) do update set
    window_count=case when s2a_user_group_windows.window_start<=now()-interval '60 seconds' then 1 else s2a_user_group_windows.window_count+1 end,
    window_start=case when s2a_user_group_windows.window_start<=now()-interval '60 seconds' then now() else s2a_user_group_windows.window_start end;

  update public.s2a_user_limits set
   window_count=case when window_start<=now()-interval '60 seconds' then 1 else window_count+1 end,
   window_start=case when window_start<=now()-interval '60 seconds' then now() else window_start end
   where user_id=owner_id;
 end if;
 return result;
end $$;

notify pgrst,'reload schema';
